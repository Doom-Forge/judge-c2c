import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import { digest } from "../src/domain";
import { organization } from "../src/organization";
import type { Env } from "../src/env";

const origin = "https://organization.test",
	organizerToken = "organizer-token-" + "x".repeat(40),
	judgeToken = "judge-token-" + "y".repeat(40),
	judgeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	participantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	participantToken = "c".repeat(64);
let mf: Miniflare, env: Env;
const ctx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

function request(path: string, cookie = "") {
	return new Request(origin + path, {
		headers: {
			origin,
			...(cookie ? { cookie } : {}),
		},
	});
}

beforeEach(async () => {
	mf = new Miniflare({
		modules: true,
		script: 'export default{fetch(){return new Response("ok")}}',
		d1Databases: ["ORG_DB"],
		compatibilityDate: "2026-08-01",
	});
	const db = await mf.getD1Database("ORG_DB");
	await migrate(db as unknown as D1Database);
	await db
		.prepare("INSERT INTO teams(id,name) VALUES('team-a','Secret Team')")
		.run();
	await db
		.prepare(
			"INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES(?, 'Judge A','judge',NULL,?),(?,'Team A lead','participant','team-a',?)",
		)
		.bind(judgeId, await digest(judgeToken), participantId, "b".repeat(64))
		.run();
	await db
		.prepare(
			"INSERT INTO console_identity_sessions(hash,expires_at,identity_id) VALUES(?,?,?)",
		)
		.bind(
			await digest(participantToken),
			Date.now() + 60_000,
			participantId,
		)
		.run();
	await db
		.prepare(
			'INSERT INTO round_two_result_snapshots(id,snapshot,created_by) VALUES(\'snapshot-private\',\'{"teams":1,"completed":1,"pending":0,"results":[{"teamName":"Secret Team","finalScore":99}]}\',\'organizer:test\')',
		)
		.run();
	env = {
		ORG_DB: db,
		ORG_ADMIN_TOKEN: organizerToken,
		ORG_VAULT_KEY: "12".repeat(32),
		ORG_PUBLIC_ORIGIN: origin,
		ORG_NAME: "Doomforge",
	} as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("unpublished result privacy", () => {
	it("keeps an unpublished snapshot unavailable to unauthenticated, participant, and judge callers", async () => {
		const organizerLogin = await organization(
			new Request(origin + "/api/organization/login", {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body: JSON.stringify({ token: organizerToken }),
			}),
			env,
			ctx,
		);
		const organizerCookie =
			organizerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
		const judgeLogin = await organization(
			new Request(origin + "/api/organization/login", {
				method: "POST",
				headers: { origin, "content-type": "application/json" },
				body: JSON.stringify({ token: judgeToken }),
			}),
			env,
			ctx,
		);
		const judgeCookie =
			judgeLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
		const path = "/api/organization/round-two/results/snapshots",
			unauthenticated = await organization(request(path), env, ctx),
			participant = await organization(
				request(path, `judge_organizer=${participantToken}`),
				env,
				ctx,
			),
			judge = await organization(request(path, judgeCookie), env, ctx),
			organizer = await organization(
				request(path, organizerCookie),
				env,
				ctx,
			);

		expect([
			unauthenticated.status,
			participant.status,
			judge.status,
			organizer.status,
			await organizer.clone().text(),
		]).toEqual([
			401,
			403,
			403,
			200,
			expect.stringContaining("Secret Team"),
		]);
	});
});
