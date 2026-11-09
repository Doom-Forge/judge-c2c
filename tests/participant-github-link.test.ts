import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import { importTeams } from "../src/competition-teams";
import { dispatchTeamInvitations } from "../src/team-invitations";
import worker from "../src/index";
import type { CompetitionServices } from "../src/competition-store";
import type { Env } from "../src/env";

const origin = "https://organization.test";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let mf: Miniflare;
let env: Env;
let inviteBody = "";
let teamId = "";
const services = {
	client: async () => {
		throw new Error("Email-only import must not require GitHub App access.");
	},
} as unknown as CompetitionServices;

function request(path: string, method = "GET", data?: unknown, cookie = "") {
	return new Request(origin + path, {
		method,
		headers: {
			origin,
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
		},
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
	});
}

beforeEach(async () => {
	inviteBody = "";
	mf = new Miniflare({
		modules: true,
		script: 'export default{fetch(){return new Response("ok")}}',
		d1Databases: ["DB", "ORG_DB"],
		compatibilityDate: "2026-08-01",
	});
	const db = (await mf.getD1Database("ORG_DB")) as unknown as D1Database;
	await migrate(db);
	await db.prepare("UPDATE hackathons SET status='ACTIVE' WHERE id='initial'").run();
	env = {
		DB: (await mf.getD1Database("DB")) as unknown as D1Database,
		ORG_DB: db,
		ORG_ADMIN_TOKEN: "admin-token-" + "a".repeat(40),
		ORG_VAULT_KEY: "12".repeat(32),
		ORG_NAME: "Doomforge",
		ORG_PUBLIC_ORIGIN: origin,
		MATRIX_MODE: "true",
		ENVIRONMENT: "production",
		ASSETS: { fetch: async () => new Response("asset") },
		EVALUATOR: { create: async () => undefined },
		TEAM_EMAIL_SENDER: {
			fetch: async (request: RequestInfo | URL) => {
				const payload = await new Request(request).json() as { body: string };
				inviteBody = payload.body;
				return Response.json({ accepted: true });
			},
		} as unknown as Fetcher,
	} as unknown as Env;
	const imported = await importTeams(env, services, "organizer:test", {
		csv: [
			"team_name,participant_name,email,team_lead_email,team_status",
			"Alpha,Alice,alice@example.test,lead@example.test,ACTIVE",
			"Alpha,Bob,bob@example.test,lead@example.test,ACTIVE",
		].join("\n"),
		commit: true,
	});
	teamId = imported.teams[0]!.id;
	await dispatchTeamInvitations(env);
});

afterEach(async () => mf.dispose());

async function verify(email: string) {
	const code = inviteBody.match(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/)?.[0];
	expect(code).toBeTruthy();
	const response = await worker.fetch(
		request("/api/organization/participant/verify", "POST", { email, code }),
		env,
		ctx,
	);
	return {
		response,
		cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
	};
}

describe("email-only participant onboarding and GitHub linking", () => {
	it("verifies each imported member with the shared code and returns safe participant state", async () => {
		const alice = await verify("alice@example.test");
		const bob = await verify("bob@example.test");
		expect(alice.response.status).toBe(200);
		expect(await alice.response.json()).toMatchObject({
			authenticated: true,
			participant: {
				teamId,
				teamName: "Alpha",
				displayName: "Alice",
				email: "alice@example.test",
				githubLinked: false,
			},
		});
		expect(bob.response.status).toBe(200);
		const replay = await worker.fetch(
			request(
				"/api/organization/participant/verify",
				"POST",
				{ email: "alice@example.test", code: inviteBody.match(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/)?.[0] },
			),
			env,
			ctx,
		);
		expect(replay.status).toBe(409);
	});

	it("links only the authenticated Arena GitHub identity and rejects another member's identity", async () => {
		const alice = await verify("alice@example.test");
		const bob = await verify("bob@example.test");
		let forwardedCookie = "";
		env.ARENA_SERVICE = {
			fetch: async (request: RequestInfo | URL) => {
				const forwarded = new Request(request);
				forwardedCookie = forwarded.headers.get("cookie") ?? "";
				expect(new URL(forwarded.url).origin).toBe(origin);
				expect(new URL(forwarded.url).pathname).toBe("/api/auth/github-identity");
				return Response.json({
					success: true,
					data: { githubIdentity: { id: 424242, login: "alice-gh" } },
				});
			},
		} as unknown as Fetcher;
		const arenaCookie = "doomforge_session=verified-arena-session";
		const linked = await worker.fetch(
			request(
				"/api/organization/participant/github/link",
				"POST",
				{ id: 99, login: "browser-forgery" },
				`${alice.cookie}; ${arenaCookie}`,
			),
			env,
			ctx,
		);
		expect([linked.status, await linked.json()]).toEqual([
			200,
			{ linked: true, github: { login: "alice-gh" } },
		]);
		expect(forwardedCookie).toContain(arenaCookie);
		expect(await env.ORG_DB!.prepare(
			"SELECT github_id,github_login FROM team_members WHERE email='alice@example.test'",
		).first()).toEqual({ github_id: 424242, github_login: "alice-gh" });

		const conflict = await worker.fetch(
			request(
				"/api/organization/participant/github/link",
				"POST",
				{},
				`${bob.cookie}; ${arenaCookie}`,
			),
			env,
			ctx,
		);
		expect([conflict.status, await conflict.json()]).toEqual([
			409,
			{ error: "GITHUB_IDENTITY_ALREADY_ASSIGNED" },
		]);
		const logout = await worker.fetch(
			request("/api/organization/logout", "POST", undefined, alice.cookie),
			env,
			ctx,
		);
		expect(logout.status).toBe(200);
		const reLogin = await worker.fetch(
			request(
				"/api/organization/participant/github-login",
				"POST",
				undefined,
				arenaCookie,
			),
			env,
			ctx,
		);
		expect([reLogin.status, await reLogin.json()]).toEqual([
			200,
			{
				authenticated: true,
				identity: expect.objectContaining({ role: "participant", teamId }),
			},
		]);
		expect(reLogin.headers.get("set-cookie")).toContain("judge_organizer=");
	});

	it("requires an Arena session and reports an unavailable or unlinked Arena account", async () => {
		const alice = await verify("alice@example.test");
		env.ARENA_SERVICE = {
			fetch: async () => Response.json({ success: false, error: { code: "UNAUTHENTICATED" } }, { status: 401 }),
		} as unknown as Fetcher;
		const unauthenticated = await worker.fetch(
			request("/api/organization/participant/github/link", "POST", {}, alice.cookie),
			env,
			ctx,
		);
		expect([unauthenticated.status, await unauthenticated.json()]).toEqual([
			401,
			{ error: "GITHUB_SESSION_REQUIRED" },
		]);
		env.ARENA_SERVICE = {
			fetch: async () => Response.json({ success: false, error: { code: "GITHUB_IDENTITY_NOT_LINKED" } }, { status: 403 }),
		} as unknown as Fetcher;
		const notLinked = await worker.fetch(
			request("/api/organization/participant/github/link", "POST", {}, `${alice.cookie}; doomforge_session=unlinked`),
			env,
			ctx,
		);
		expect([notLinked.status, await notLinked.json()]).toEqual([
			403,
			{ error: "GITHUB_IDENTITY_NOT_LINKED" },
		]);
		const loginWithoutProof = await worker.fetch(
			request("/api/organization/participant/github-login", "POST"),
			env,
			ctx,
		);
		expect([loginWithoutProof.status, await loginWithoutProof.json()]).toEqual([
			401,
			{ error: "GITHUB_SESSION_REQUIRED" },
		]);
	});
});
