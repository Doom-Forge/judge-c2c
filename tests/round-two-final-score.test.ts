import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";
import { roundTwoResults } from "../src/round-two-results";

const judge: ConsoleSession = { hash: "judge-session", role: "judge", identity_id: "judge-1", name: "Judge 1", team_id: null };
const unassigned: ConsoleSession = { ...judge, identity_id: "judge-2", name: "Judge 2" };
const organizer: ConsoleSession = { hash: "org", role: "organizer", identity_id: "org-1", name: "Organizer", team_id: null };
let mf: Miniflare;
let env: Env;

function request(method: "GET" | "POST" = "GET", data?: unknown, query = "") {
	return new Request(`https://organization.test/api/organization/round-two/results/final-score${query}`, {
		method,
		headers: { "content-type": "application/json" },
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
	});
}

beforeEach(async () => {
	mf = new Miniflare({ modules: true, script: 'export default{fetch(){return new Response("ok")}}', d1Databases: ["ORG_DB"], compatibilityDate: "2026-08-01" });
	const db = await mf.getD1Database("ORG_DB");
	await migrate(db as unknown as D1Database);
	await db.prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A')").run();
	await db.prepare("INSERT INTO console_identities(id,name,role,credential_hash) VALUES('judge-1','Judge 1','judge',?),('judge-2','Judge 2','judge',?),('org-1','Organizer','organizer',?)").bind("1".repeat(64), "2".repeat(64), "3".repeat(64)).run();
	await db.prepare("INSERT INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES('assignment-a','judge-1','team-a','organizer:org-1')").run();
	env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => { await mf.dispose(); });

describe("explicit immutable judge final score", () => {
	it("requires an assigned judge and a submitted engineering review", async () => {
		const denied = await roundTwoResults(request("GET", undefined, "?teamId=team-a"), env, unassigned);
		expect(denied.status).toBe(404);
		const contextResponse = await roundTwoResults(request("GET", undefined, "?teamId=team-a"), env, judge);
		expect((await contextResponse.json() as { canFinalize: boolean }).canFinalize).toBe(false);
		const response = await roundTwoResults(request("POST", { teamId: "team-a", score: 80, reason: "Final mark after reviewing submitted evidence." }), env, judge);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "ENGINEERING_REVIEW_REQUIRED" });
	});

	it("records one reasoned official score, prevents overwrites, and publishes only that score", async () => {
		await env.ORG_DB!.prepare("INSERT INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason) VALUES('review-engineering','team-a','judge-1','ENGINEERING',1,78,'{}',NULL,'Initial submission')").run();
		const context = await roundTwoResults(request("GET", undefined, "?teamId=team-a"), env, judge);
		const detail = await context.json() as { canFinalize: boolean; manualReviews: { engineering: { average: number } }; machineEvidence: { status: string; marks: null } };
		expect(detail).toMatchObject({ canFinalize: true, manualReviews: { engineering: { average: 78 } }, machineEvidence: { status: "UNVERIFIED", marks: null } });
		const finalized = await roundTwoResults(request("POST", { teamId: "team-a", score: 91.5, reason: "Final mark after reviewing submitted evidence." }), env, judge);
		expect(finalized.status).toBe(201);
		const duplicate = await roundTwoResults(request("POST", { teamId: "team-a", score: 40, reason: "Trying to replace the first official mark." }), env, judge);
		expect(duplicate.status).toBe(409);
		expect((await duplicate.json() as { finalScore: { score: number } }).finalScore.score).toBe(91.5);
		const results = await roundTwoResults(new Request("https://organization.test/api/organization/round-two/results"), env, organizer);
		const result = ((await results.json()) as { results: Array<Record<string, unknown>> }).results[0];
		expect(result).toMatchObject({ status: "READY", finalScore: 91.5, finalScoreBy: "judge-1", automatedEvidence: { status: "UNVERIFIED", marks: null } });
		const audit = await env.ORG_DB!.prepare("SELECT action,actor,changes FROM audit WHERE action='round_two.team_final_score.set'").first<{ action: string; actor: string; changes: string }>();
		expect(audit?.actor).toBe("judge:judge-1");
		expect(JSON.parse(audit!.changes)).toMatchObject({ score: 91.5, reason: "Final mark after reviewing submitted evidence." });
	});

	it("does not let organizers finalize a team score", async () => {
		const response = await roundTwoResults(request("POST", { teamId: "team-a", score: 80, reason: "Final mark after reviewing submitted evidence." }), env, organizer);
		expect(response.status).toBe(403);
	});
});
