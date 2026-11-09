import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import { digest } from "../src/domain";
import worker from "../src/index";
import type { Env } from "../src/env";

const origin = "https://organization.test",
	participantToken = "a".repeat(64),
	organizerToken = "d".repeat(64),
	ctx = {
		waitUntil() {},
		passThroughOnException() {},
	} as unknown as ExecutionContext;
let mf: Miniflare, env: Env;

function request(path: string, token: string | null = participantToken) {
	return new Request(origin + path, {
		headers: {
			origin,
			"content-type": "application/json",
			...(token ? { cookie: "judge_organizer=" + token } : {}),
		},
	});
}

beforeEach(async () => {
	mf = new Miniflare({
		modules: true,
		script: 'export default{fetch(){return new Response("ok")}}',
		d1Databases: ["DB"],
		compatibilityDate: "2026-08-01",
	});
	const db = (await mf.getD1Database("DB")) as unknown as D1Database;
	await migrate(db);
	await db.prepare(
		"INSERT INTO teams(id,name) VALUES('team-a','Team A'),('team-b','Team B')",
	).run();
	await db.prepare(
		"INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES('participant-a','Team A','participant','team-a',? ),('organizer','Organizer','organizer',NULL,?)",
	)
		.bind("b".repeat(64), "c".repeat(64)).run();
	await db.prepare(
		"INSERT INTO console_identity_sessions(hash,identity_id,expires_at) VALUES(?,?,?),(?,?,?)",
	)
		.bind(
			await digest(participantToken),
			"participant-a",
			Date.now() + 3600000,
			await digest(organizerToken),
			"organizer",
			Date.now() + 3600000,
		).run();
	env = {
		DB: db,
		ORG_DB: db,
		ORG_ADMIN_TOKEN: "x".repeat(40),
		ORG_VAULT_KEY: "12".repeat(32),
		ORG_NAME: "Doomforge",
		ORG_PUBLIC_ORIGIN: origin,
	} as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("participant published results through the Worker fetch surface", () => {
	it("returns no score fields before publication", async () => {
		await env.ORG_DB!.prepare(
			"INSERT INTO round_two_result_snapshots(id,snapshot,created_by) VALUES(?,?,?)",
		).bind("private-feedback", JSON.stringify({ results: [{ teamId: "team-a", feedback: { analysis: [{ overall: "Unpublished judge comment" }] } }] }), "organizer:test").run();
		const response = await worker.fetch(
			request("/api/organization/participant/results"),
			env,
			ctx,
		);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toEqual({ published: false });
		expect(JSON.stringify(body)).not.toMatch(/score|rank|average/i);
		expect(JSON.stringify(body)).not.toContain("Unpublished judge comment");
	});

	it("returns only the active participant team's row from the published snapshot", async () => {
		const snapshotId = "snapshot-a";
		const snapshot = {
			results: [
				{
					teamId: "team-a",
					teamName: "Team A",
					finalScore: 82,
					feedback: { analysis: [{ overall: "Published analysis feedback" }], engineering: [] },
				},
				{
					teamId: "team-b",
					teamName: "Team B",
					finalScore: 11,
					feedback: { analysis: [{ overall: "Another team's private feedback" }], engineering: [] },
				},
			],
			ranking: [
				{
					teamId: "team-a",
					teamName: "Team A",
					finalScore: 82,
					rank: 1,
					feedback: { analysis: [{ overall: "Published analysis feedback" }], engineering: [] },
				},
				{
					teamId: "team-b",
					teamName: "Team B",
					finalScore: 11,
					rank: 2,
					feedback: { analysis: [{ overall: "Another team's private feedback" }], engineering: [] },
				},
			],
		};
		await env.ORG_DB!.batch([
			env.ORG_DB!.prepare(
				"INSERT INTO round_two_result_snapshots(id,snapshot,created_by) VALUES(?,?,?)",
			)
				.bind(snapshotId, JSON.stringify(snapshot), "organizer:test"),
			env.ORG_DB!.prepare(
				"INSERT INTO round_two_result_publication(id,snapshot_id,updated_by,published_at) VALUES(1,?,?,CURRENT_TIMESTAMP)",
			)
				.bind(snapshotId, "organizer:test"),
		]);
		const response = await worker.fetch(
			request("/api/organization/participant/results"),
			env,
			ctx,
		);
		expect([response.status, await response.json()]).toEqual([
			200,
			{
				published: true,
				results: [snapshot.results[0]],
				ranking: [snapshot.ranking[0]],
			},
		]);
	});

	it("denies results to nonparticipant and anonymous sessions", async () => {
		const organizer = await worker.fetch(
			request("/api/organization/participant/results", organizerToken),
			env,
			ctx,
		);
		const anonymous = await worker.fetch(
			request("/api/organization/participant/results", null),
			env,
			ctx,
		);
		expect([
			organizer.status,
			(await organizer.json() as { error: string }).error,
			anonymous.status,
			(await anonymous.json() as { error: string }).error,
		]).toEqual([403, "PARTICIPANT_REQUIRED", 401, "UNAUTHORIZED"]);
	});
});
