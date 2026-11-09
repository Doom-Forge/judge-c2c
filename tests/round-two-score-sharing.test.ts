import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";
import { participantSharedScores } from "../src/round-two-score-sharing";
import { roundTwoReview } from "../src/round-two-review";
import { roundTwoResults } from "../src/round-two-results";

const organizer: ConsoleSession = {
	hash: "organizer-session",
	role: "organizer",
	identity_id: "organizer-a",
	name: "Organizer",
	team_id: null,
};
const judge: ConsoleSession = {
	hash: "judge-session",
	role: "judge",
	identity_id: "judge-a",
	name: "Judge A",
	team_id: null,
};
const otherJudge: ConsoleSession = { ...judge, identity_id: "judge-b" };
let mf: Miniflare;
let env: Env;

function request(path: string, method = "GET", data?: unknown) {
	return new Request("https://organization.test" + path, {
		method,
		headers: { "content-type": "application/json" },
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
	});
}

async function submit(
	id: string,
	stage: "ANALYSIS" | "ENGINEERING",
	revision: number,
	score: number,
) {
	await env.ORG_DB!.prepare(
		"INSERT INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason,rubric_version_id) VALUES(?,'team-a','judge-a',?,?,?,'{\"overall\":\"private text\"}',NULL,'Initial submission',?)",
	).bind(id, stage, revision, score, stage === "ENGINEERING" ? "rubric-a" : null).run();
}

async function share(reviewId: string, shared: boolean) {
	return roundTwoReview(request(
		"/api/organization/round-two/reviews/share",
		"POST",
		{ teamId: "team-a", stage: "ANALYSIS", reviewId, shared },
	), env, judge);
}

async function publishSnapshot() {
	const created = await roundTwoResults(request(
		"/api/organization/round-two/results/snapshots",
		"POST",
		{ reason: "Create an immutable result snapshot." },
	), env, organizer);
	const snapshotId = (await created.json() as { id: string }).id;
	const published = await roundTwoResults(request(
		"/api/organization/round-two/results/publication",
		"POST",
		{ snapshotId, reason: "Publish the completed result snapshot." },
	), env, organizer);
	return { created, published, snapshotId };
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
	await db.prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A'),('team-b','Team B')").run();
	await db.prepare("UPDATE teams SET status='WITHDRAWN' WHERE id='team-b'").run();
	await db.prepare(
		"INSERT INTO console_identities(id,name,role,credential_hash) VALUES('judge-a','Judge A','judge',?),('judge-b','Judge B','judge',?)",
	).bind("a".repeat(64), "b".repeat(64)).run();
	await db.prepare(
		"INSERT INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES('assignment-a','judge-a','team-a','organizer:test')",
	).run();
	await db.prepare(
		"INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(1,'org/repo',0,'main')",
	).run();
	await db.prepare(
		"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',1,'organizer:test')",
	).run();
	await db.prepare(
		"INSERT INTO round_two_repository_rubric_versions(id,repository_id,version,criteria,actor) VALUES('rubric-a',1,1,'[]','organizer:test')",
	).run();
	env = { ORG_DB: db } as unknown as Env;
	await submit("analysis-review-1", "ANALYSIS", 1, 80);
	await submit("engineering-review-1", "ENGINEERING", 1, 90);
});

afterEach(async () => {
	await mf.dispose();
});

describe("judge-controlled participant score sharing", () => {
	it("keeps a selected score hidden until the published snapshot contains its exact review", async () => {
		const optedIn = await share("analysis-review-1", true);
		const beforePublish = await participantSharedScores(env.ORG_DB!, "team-a", "missing-snapshot");
		const { created, published, snapshotId } = await publishSnapshot();
		const afterPublish = await participantSharedScores(env.ORG_DB!, "team-a", snapshotId);

		expect([optedIn.status, beforePublish, created.status, published.status]).toEqual([
			200,
			[],
			201,
			200,
		]);
		expect(afterPublish).toEqual([
			{ stage: "ANALYSIS", score: 80, sharedAt: expect.any(String) },
		]);
		expect(JSON.stringify(afterPublish)).not.toContain("private text");
		expect(Object.keys(afterPublish[0]!).sort()).toEqual(["score", "sharedAt", "stage"]);
	});

	it("never exposes a post-snapshot revision and allows the judge to revoke the selected score", async () => {
		await share("analysis-review-1", true);
		const { created, published, snapshotId } = await publishSnapshot();
		await submit("analysis-review-2", "ANALYSIS", 2, 99);
		const selectedAfterRevision = await share("analysis-review-2", true);
		const stillFrozen = await participantSharedScores(env.ORG_DB!, "team-a", snapshotId);
		const revoked = await share("analysis-review-1", false);
		const afterRevocation = await participantSharedScores(env.ORG_DB!, "team-a", snapshotId);

		expect([created.status, published.status, selectedAfterRevision.status, revoked.status]).toEqual([
			201,
			200,
			200,
			200,
		]);
		expect(stillFrozen.map(({ score }) => score)).toEqual([80]);
		expect(afterRevocation).toEqual([]);
	});

	it("rejects another judge's review and does not allow drafts or unassigned teams to be shared", async () => {
		const foreignReview = await roundTwoReview(request(
			"/api/organization/round-two/reviews/share",
			"POST",
			{ teamId: "team-a", stage: "ANALYSIS", reviewId: "analysis-review-1", shared: true },
		), env, otherJudge);
		const draft = await roundTwoReview(request(
			"/api/organization/round-two/reviews/share",
			"POST",
			{ teamId: "team-a", stage: "ANALYSIS", reviewId: "draft-id", shared: true },
		), env, judge);
		const otherTeam = await roundTwoReview(request(
			"/api/organization/round-two/reviews/share",
			"POST",
			{ teamId: "team-b", stage: "ANALYSIS", reviewId: "analysis-review-1", shared: true },
		), env, judge);

		expect([foreignReview.status, draft.status, otherTeam.status]).toEqual([404, 404, 404]);
		expect(await participantSharedScores(env.ORG_DB!, "team-b", "missing-snapshot")).toEqual([]);
	});
});
