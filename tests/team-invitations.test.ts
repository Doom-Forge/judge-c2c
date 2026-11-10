import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import { importTeams } from "../src/competition-teams";
import worker from "../src/index";
import {
	dispatchTeamInvitations,
	requestParticipantLoginCode,
	teamAccessKey,
	verifyParticipant,
} from "../src/team-invitations";
import type { CompetitionServices } from "../src/competition-store";
import type { Env } from "../src/env";

let mf: Miniflare;
let env: Env;
let db: D1Database;
const sent: { to: string; idempotencyKey: string; body: string }[] = [];
const services = {
	client: async () => ({
		api: async (path: string) => ({
			id: path.includes("alice") ? 41 : 42,
			login: path.split("/").pop(),
			type: "User",
		}),
	}),
} as unknown as CompetitionServices;
beforeEach(async () => {
	sent.length = 0;
	mf = new Miniflare({
		modules: true,
		script: "export default{}",
		d1Databases: ["ORG_DB"],
		compatibilityDate: "2026-08-01",
	});
	db = (await mf.getD1Database("ORG_DB")) as unknown as D1Database;
	await migrate(db);
	env = {
		ORG_DB: db,
		ORG_VAULT_KEY: "12".repeat(32),
		ORG_ADMIN_TOKEN: "admin-test-token",
		ORG_NAME: "Pilot",
		ORG_PUBLIC_ORIGIN: "https://judge.test",
	} as Env;
});
afterEach(async () => mf.dispose());
async function imported() {
	await importTeams(env, services, "organizer:test", {
		csv: [
			"team_name,participant_name,github_username,email,team_lead_email,team_status",
			"Alpha,Alice,alice,alice@example.test,lead@example.test,ACTIVE",
			"Alpha,Bob,bob,bob@example.test,lead@example.test,ACTIVE",
		].join("\n"),
		commit: true,
	});
	return db
		.prepare("SELECT id FROM teams WHERE name='Alpha'")
		.first<{ id: string }>();
}
async function finalized() {
	const team = await imported();
	await db.prepare("INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(91,'Doom-Forge/mazhai-cover',0,'main')").run();
	await db.prepare("INSERT INTO team_repositories(team_id,repository_id,actor) VALUES(?,91,'organizer:test')").bind(team!.id).run();
	await db.prepare("UPDATE teams SET track_finalized=1 WHERE id=?").bind(team!.id).run();
	return team;
}
describe("Unstop participant onboarding", () => {
	it("keeps existing team access keys stable across an organization rename", async () => {
		const team = await finalized();
		const existingKey = await teamAccessKey(env, team!.id);
		env.ORG_NAME = "Doom-Forge";
		env.ORG_KEY_CONTEXT = "Pilot";

		expect(await teamAccessKey(env, team!.id)).toBe(existingKey);
	});
	it("creates hashed team code and pending lead-only invitation when sender is absent", async () => {
		const team = await imported();
		const stored = await db
			.prepare(
				"SELECT code_hash,nonce,expires_at FROM team_invitation_codes WHERE team_id=?",
			)
			.bind(team!.id)
			.first<Record<string, unknown>>();
		expect(stored?.code_hash).toMatch(/^[a-f0-9]{64}$/);
		expect(stored?.nonce).toMatch(/^[a-f0-9]{32}$/);
		expect(
			await db
				.prepare(
					"SELECT recipient,status FROM team_invitations WHERE team_id=?",
				)
				.bind(team!.id)
				.first(),
		).toMatchObject({ recipient: "lead@example.test", status: "PENDING" });
		await dispatchTeamInvitations(env);
		expect(sent).toHaveLength(0);
	});
	it("records only safe provider failures and reuses the stable invitation key", async () => {
		const team = await imported();
		const keys: string[] = [];
		env.TEAM_EMAIL_SENDER = {
			fetch: async (request: RequestInfo | URL) => {
				const payload = (await new Request(request).json()) as {
					idempotencyKey: string;
				};
				keys.push(payload.idempotencyKey);
				return new Response("provider-password=secret-value", {
					status: 503,
				});
			},
		} as Fetcher;
		await dispatchTeamInvitations(env);
		await dispatchTeamInvitations(env, Date.now() + 6 * 60_000);
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(1);
		expect(
			await db
				.prepare(
					"SELECT status,attempts,last_error FROM team_invitations WHERE team_id=?",
				)
				.bind(team!.id)
				.first(),
		).toMatchObject({
			status: "FAILED",
			attempts: 2,
			last_error: "SENDER_REJECTED",
		});
	});
	it("does not mail the team key and requires OTP plus the key for a member", async () => {
		const team = await finalized();
		env.TEAM_EMAIL_SENDER = {
			fetch: async (request: RequestInfo | URL) => {
				const body = (await new Request(request).json()) as {
					to: string;
					idempotencyKey: string;
					body: string;
				};
				sent.push(body);
				return Response.json({ accepted: true });
			},
		} as Fetcher;
		await dispatchTeamInvitations(env);
		await dispatchTeamInvitations(env);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe("lead@example.test");
		expect(sent[0]?.idempotencyKey).toMatch(/^team-invite:team-/);
		expect(sent[0]!.body).not.toMatch(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/);
		const key = await teamAccessKey(env, team!.id);
		const loginMessages: { idempotencyKey: string; to: string; body: string }[] = [];
		env.TEAM_EMAIL_SENDER = { fetch: async (request: RequestInfo | URL) => { const message = await new Request(request).json() as { idempotencyKey: string; to: string; body: string }; loginMessages.push(message); return Response.json({ accepted: true }); } } as Fetcher;
		await requestParticipantLoginCode(env, "alice@example.test", Date.parse("2026-11-08T12:00:00Z"), "ip", key!);
		const code = loginMessages[0]!.body.match(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/)![0]!;
		const result = await verifyParticipant(env, "alice@example.test", code, "2026-11-08T12:01:00.000Z", "ip", key!);
		expect(result.status).toBe(200);
		expect(
			await db
				.prepare(
					"SELECT i.team_id,i.team_member_id,m.github_id FROM console_identities i JOIN team_members m ON m.id=i.team_member_id WHERE i.id=?",
				)
				.bind(result.identityId)
				.first(),
		).toMatchObject({ team_id: team!.id, github_id: 41 });
		expect(
			await verifyParticipant(
				env,
				"alice@example.test",
				code,
				"2026-11-08T12:00:01.000Z",
				"ip",
				key!,
			),
		).toMatchObject({ status: 401 });
	});
	it("reissues one-use email login codes and requires the team key again", async () => {
		const team = await finalized();
		const key = await teamAccessKey(env, team!.id);
		const loginMessages: { idempotencyKey: string; to: string; body: string }[] = [];
		env.TEAM_EMAIL_SENDER = {
			fetch: async (request: RequestInfo | URL) => {
				const message = await new Request(request).json() as { idempotencyKey: string; to: string; body: string };
				loginMessages.push(message);
				return Response.json({ accepted: true });
			},
		} as Fetcher;
		const firstRequest = await requestParticipantLoginCode(env, "alice@example.test", Date.parse("2026-11-08T12:00:00Z"), "ip-a", key!);
		expect(firstRequest.status).toBe(202);
		const firstCode = loginMessages[0]!.body.match(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/)![0]!;
		const firstLogin = await verifyParticipant(env, "alice@example.test", firstCode, "2026-11-08T12:01:00.000Z", "ip-a", key!);
		expect(firstLogin.status).toBe(200);
		const secondRequest = await requestParticipantLoginCode(env, "alice@example.test", Date.parse("2026-11-08T13:00:00Z"), "ip-b", key!);
		expect(secondRequest.status).toBe(202);
		const secondCode = loginMessages[1]!.body.match(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/)![0]!;
		const secondLogin = await verifyParticipant(env, "alice@example.test", secondCode, "2026-11-08T13:01:00.000Z", "ip-b", key!);
		expect(secondLogin).toMatchObject({ status: 200, identityId: firstLogin.identityId });
		expect(await verifyParticipant(env, "alice@example.test", secondCode, "2026-11-08T13:02:00.000Z", "ip-b", key!)).toMatchObject({ status: 401 });
		expect(loginMessages.map(message => message.to)).toEqual(["alice@example.test", "alice@example.test"]);
		expect(loginMessages[0]?.idempotencyKey).not.toBe(loginMessages[1]?.idempotencyKey);
	});
	it("allows only one concurrent login-code use and hides recipient-specific sender failures", async () => {
		const team = await finalized();
		const key = await teamAccessKey(env, team!.id);
		env.TEAM_EMAIL_SENDER = {
			fetch: async (request: RequestInfo | URL) => {
				const message = await new Request(request).json() as { body: string };
				sent.push({ to: "", idempotencyKey: "", body: message.body });
				return Response.json({ accepted: true });
			},
		} as Fetcher;
		await requestParticipantLoginCode(env, "alice@example.test", Date.parse("2026-11-08T12:00:00Z"), "ip-c", key!);
		const code = sent[0]!.body.match(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/)![0]!;
		const simultaneous = await Promise.all([
			verifyParticipant(env, "alice@example.test", code, "2026-11-08T12:01:00.000Z", "ip-c", key!),
			verifyParticipant(env, "alice@example.test", code, "2026-11-08T12:01:00.000Z", "ip-d", key!),
		]);
		expect(simultaneous.map(result => result.status).sort()).toEqual([200, 409]);
		env.TEAM_EMAIL_SENDER = {
			fetch: async () => new Response("provider unavailable", { status: 503 }),
		} as unknown as Fetcher;
		expect(await requestParticipantLoginCode(env, "alice@example.test", Date.parse("2026-11-08T14:00:00Z"), "ip-e", key!)).toEqual({ status: 202 });
		expect(await requestParticipantLoginCode(env, "unknown@example.test", Date.parse("2026-11-08T14:00:00Z"), "ip-e")).toEqual({ status: 202 });
	});
	it("rejects wrong email, expired code, inactive members, and limits attempts", async () => {
		const team = await finalized();
		const key = await teamAccessKey(env, team!.id);
		env.TEAM_EMAIL_SENDER = {
			fetch: async (request: RequestInfo | URL) => {
				const body = (await new Request(request).json()) as {
					body: string;
				};
				sent.push({ to: "", idempotencyKey: "", body: body.body });
				return Response.json({});
			},
		} as Fetcher;
		await requestParticipantLoginCode(env, "alice@example.test", Date.parse("2026-11-08T12:00:00Z"), "ip-r", key!);
		const code = sent[0]!.body.match(/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/)![0]!;
		expect(
			await verifyParticipant(
				env,
				"other@example.test",
				code,
				"2026-11-08T12:00:00.000Z",
				"ip-r",
				key!,
			),
		).toMatchObject({ status: 401 });
		expect(
			await verifyParticipant(
				env,
				"alice@example.test",
				code,
				"2026-11-16T12:00:00.000Z",
				"ip-r",
				key!,
			),
		).toMatchObject({ status: 401 });
		await db
			.prepare("UPDATE team_members SET active=0 WHERE team_id=?")
			.bind(team!.id)
			.run();
		expect(
			await verifyParticipant(
				env,
				"alice@example.test",
				code,
				"2026-11-08T12:00:00.000Z",
				"ip-r",
				key!,
			),
		).toMatchObject({ status: 401 });
	});
	it("rate-limits verification and serves only the same-origin verification route in Matrix mode", async () => {
		await imported();
		for (let attempt = 0; attempt < 10; attempt++) {
			await verifyParticipant(
				env,
				"unknown@example.test",
				"AAAAAAAAAAAA",
				"2026-11-08T12:00:00.000Z",
				"192.0.2.4",
			);
		}
		expect(
			await verifyParticipant(
				env,
				"unknown@example.test",
				"AAAAAAAAAAAA",
				"2026-11-08T12:00:00.000Z",
				"192.0.2.4",
			),
		).toMatchObject({ status: 429 });
		env.TEAM_EMAIL_SENDER = {
			fetch: async (request: RequestInfo | URL) => {
				const body = (await new Request(request).json()) as {
					to: string;
					idempotencyKey: string;
					body: string;
				};
				sent.push(body);
				return Response.json({ accepted: true });
			},
		} as Fetcher;
		await requestParticipantLoginCode(env, "lead@example.test", Date.now(), "route-ip");
		const code = sent[0]!.body.match(
			/[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}/,
		)![0]!;
		const ctx = { waitUntil() {} } as unknown as ExecutionContext;
		const hostileOrigin = await worker.fetch(
			new Request(
				"https://judge.test/api/organization/participant/verify",
				{
					method: "POST",
					headers: {
						origin: "https://attacker.test",
						"content-type": "application/json",
					},
				body: JSON.stringify({ email: "lead@example.test", code }),
				},
			),
			{ ...env, MATRIX_MODE: "true" },
			ctx,
		);
		expect(hostileOrigin.status).toBe(403);
		const stillPending = await db
			.prepare("SELECT count(*) AS count FROM team_invitation_uses")
			.first<{ count: number }>();
		expect(stillPending?.count).toBe(0);
		const response = await worker.fetch(
			new Request(
				"https://judge.test/api/organization/participant/verify",
				{
					method: "POST",
					headers: {
						origin: "https://judge.test",
						"content-type": "application/json",
					},
				body: JSON.stringify({ email: "lead@example.test", code }),
				},
			),
			{ ...env, MATRIX_MODE: "true" },
			ctx,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toContain("HttpOnly");
		const participantCookie = response.headers.get("set-cookie")!.split(";")[0]!;
		for (const path of [
			"/api/organization/manage/audit",
			"/api/organization/manage/teams",
			"/api/organization/manage/team-email",
		]) {
			const blockedManagement = await worker.fetch(
				new Request("https://judge.test" + path, {
					headers: { origin: "https://judge.test", cookie: participantCookie },
				}),
			{ ...env, MATRIX_MODE: "true" },
			ctx,
		);
			expect(blockedManagement.status).toBe(403);
		}
		const blocked = await worker.fetch(
			new Request(
				"https://judge.test/api/organization/participant/verify",
				{
					method: "POST",
					headers: {
						origin: "https://attacker.test",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						email: "alice@example.test",
						code: "000000000000",
					}),
				},
			),
			{ ...env, MATRIX_MODE: "true" },
			ctx,
		);
		expect(blocked.status).toBe(403);
	});
});
