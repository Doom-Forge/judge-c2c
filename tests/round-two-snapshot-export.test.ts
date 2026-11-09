import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";
import { roundTwoResults } from "../src/round-two-results";
import { roundTwoReview } from "../src/round-two-review";

const organizer: ConsoleSession = {
	hash: "organizer-session",
	role: "organizer",
	identity_id: "organizer-id",
	name: "Organizer",
	team_id: null,
};
const participant: ConsoleSession = {
	hash: "participant-session",
	role: "participant",
	identity_id: "participant-id",
	name: "Participant",
	team_id: "team-a",
};
let mf: Miniflare, env: Env;

function request(path: string, method = "GET", data?: unknown) {
	return new Request("https://organization.test" + path, {
		method,
		headers: { "content-type": "application/json" },
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
	});
}

async function finalReview(id: string, revision: number, score: number) {
	await env.ORG_DB!.prepare(
		"INSERT INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason) VALUES(?,\x27team-a\x27,\x27judge-a\x27,\x27ANALYSIS\x27,?,? ,\x27{}\x27,NULL,\x27Review revision\x27)",
	).bind(id, revision, score).run();
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
	await db.prepare(
		'INSERT INTO teams(id,name) VALUES(\x27team-a\x27,\x27Team, "A"\x27)',
	).run();
	await db.prepare(
		"INSERT INTO console_identities(id,name,role,credential_hash) VALUES('judge-a','Judge A','judge',?)",
	).bind("a".repeat(64)).run();
	env = { ORG_DB: db } as unknown as Env;
	await finalReview("review-1", 1, 80);
});

afterEach(async () => {
	await mf.dispose();
});

describe("round two snapshot CSV export", () => {
	it("exports persisted snapshot scores after reviews change and denies non-organizers", async () => {
		const created = await roundTwoReview(
			request("/api/organization/round-two/results/snapshots", "POST", {
				reason: "Freeze scores before later review edits.",
			}),
			env,
			organizer,
		);
		const snapshot = (await created.json()) as { id: string };
		await finalReview("review-2", 2, 100);
		const path =
			`/api/organization/round-two/results/snapshots/${snapshot.id}/export`;
		const response = await roundTwoResults(request(path), env, organizer);
		const csv = await response.text();
		const denied = await roundTwoResults(request(path), env, participant);
		expect(created.status).toBe(201);
		expect(response.status).toBe(200);
		expect(csv).toContain('"Team, ""A"""');
		expect(csv).toContain('"80"');
		expect(csv).not.toContain('"100"');
		expect(response.headers.get("content-type")).toContain("text/csv");
		expect(response.headers.get("content-disposition")).toContain(
			"attachment",
		);
		expect(response.headers.get("cache-control")).toContain("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(denied.status).toBe(403);
	});
	it("returns 404 for an unknown snapshot ID", async () => {
		const response = await roundTwoResults(
			request(
				"/api/organization/round-two/results/snapshots/missing/export",
			),
			env,
			organizer,
		);
		expect(response.status).toBe(404);
	});
});
