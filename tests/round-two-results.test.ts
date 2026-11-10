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
const judge: ConsoleSession = {
	hash: "judge-session",
	role: "judge",
	identity_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	name: "Judge A",
	team_id: null,
};
const participant: ConsoleSession = {
	hash: "participant-session",
	role: "participant",
	identity_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	name: "Team A",
	team_id: "team-a",
};
let mf: Miniflare, env: Env;

function request(
	path = "/api/organization/round-two/results",
	method = "GET",
	data?: unknown,
) {
	return new Request("https://organization.test" + path, {
		method,
		headers: { "content-type": "application/json" },
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
	});
}

async function finalReview(
	id: string,
	teamId: string,
	judgeId: string,
	stage: "ANALYSIS" | "ENGINEERING",
	revision: number,
	score: number,
	rubricVersionId: string | null = null,
	payload: Record<string, unknown> = {},
) {
	await env.ORG_DB!.prepare(
		"INSERT INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason,rubric_version_id) VALUES(?,?,?,?,?,?,?,NULL,'Initial submission',?)",
	)
		.bind(id, teamId, judgeId, stage, revision, score, JSON.stringify(payload), rubricVersionId)
		.run();
}

async function finalizeScore(teamId: string, judgeId: string, score: number) {
	const session: ConsoleSession = { hash: "assigned-judge", role: "judge", identity_id: judgeId, name: judgeId, team_id: null };
	return roundTwoResults(request("/api/organization/round-two/results/final-score", "POST", { teamId, score, reason: "Final mark after reviewing submitted evidence." }), env, session);
}

async function finalizeAllTeams() {
	await env.ORG_DB!.prepare("INSERT OR IGNORE INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason,rubric_version_id) VALUES('b-pr-1','team-b','judge-1','ENGINEERING',1,85,'{}',NULL,'Initial submission','rubric-a')").run();
	for (const [teamId, judgeId, score] of [["team-a", "judge-1", 90.1], ["team-b", "judge-1", 75]] as const) {
		const response = await finalizeScore(teamId, judgeId, score);
		if (response.status !== 201) throw new Error(`Test setup failed to finalize ${teamId}: ${await response.text()}`);
	}
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
		.prepare(
			"INSERT INTO teams(id,name) VALUES('team-a','Team A'),('team-b','Team B')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(1,'Doom-Forge/veera-footwear',0,'main')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',1,'organizer:test'),('team-b',1,'organizer:test')",
		)
		.run();
		await db.prepare(
			"INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(2,'Doom-Forge/mazhai-cover',0,'main')",
		).run();
		await db.prepare(
			"INSERT INTO round_two_repository_rubric_versions(id,repository_id,version,criteria,actor) VALUES('rubric-a',1,1,'[]','organizer:test'),('rubric-b',2,1,'[]','organizer:test')",
		).run();
		await db.prepare(
			"INSERT INTO round_two_active_repository_rubrics(repository_id,rubric_id,actor) VALUES(1,'rubric-a','organizer:test'),(2,'rubric-b','organizer:test')",
		).run();
	await db
		.prepare(
			"INSERT INTO console_identities(id,name,role,credential_hash) VALUES('judge-1','Judge 1','judge',? ),('judge-2','Judge 2','judge',?)",
		)
		.bind("1".repeat(64), "2".repeat(64))
		.run();
	await db.prepare("INSERT INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES('assignment-a-1','judge-1','team-a','organizer:test'),('assignment-a-2','judge-2','team-a','organizer:test'),('assignment-b-1','judge-1','team-b','organizer:test')").run();
	env = { ORG_DB: db } as unknown as Env;
	await finalReview("a-doc-1", "team-a", "judge-1", "ANALYSIS", 1, 80);
	await finalReview("a-doc-2", "team-a", "judge-1", "ANALYSIS", 2, 84);
	await finalReview("a-doc-3", "team-a", "judge-2", "ANALYSIS", 1, 80);
	await finalReview("a-pr-1", "team-a", "judge-1", "ENGINEERING", 1, 90, "rubric-a");
	await finalReview("a-pr-2", "team-a", "judge-2", "ENGINEERING", 1, 92, "rubric-a");
	await finalReview("b-doc-1", "team-b", "judge-1", "ANALYSIS", 1, 75);
});

afterEach(async () => {
	await mf.dispose();
});

describe("private 10/90 results aggregation", () => {
	it("freezes the organizer leaderboard until it is unfrozen and records each transition", async () => {
		await finalizeAllTeams();
		const freeze = await roundTwoReview(
			request("/api/organization/round-two/results/freeze", "POST", {
				reason: "Freeze the current leaderboard for review.",
			}),
			env,
			organizer,
		);
		const frozen = await roundTwoReview(request(), env, organizer);
		await finalReview("a-doc-4", "team-a", "judge-1", "ANALYSIS", 3, 100);
		const stillFrozen = await roundTwoReview(request(), env, organizer);
		const freezeBody = await freeze.json() as { snapshotId: string };
		const historyWhileFrozen = await env.ORG_DB!.prepare(
			"SELECT action,actor FROM round_two_result_freeze_history ORDER BY created_at,id",
		).all<{ action: string; actor: string }>();
		const unfreeze = await roundTwoReview(
			request("/api/organization/round-two/results/freeze", "DELETE", {
				reason: "Unfreeze results to include the revised review.",
			}),
			env,
			organizer,
		);
		const live = await roundTwoReview(request(), env, organizer);
		const liveBody = await live.json() as {
			results: { teamId: string; analysisAverage: number | null }[];
		};
		const history = await env.ORG_DB!.prepare(
			"SELECT snapshot_id,action,actor,reason FROM round_two_result_freeze_history ORDER BY sequence",
		).all<{
			snapshot_id: string;
			action: string;
			actor: string;
			reason: string;
		}>();
		const audit = await env.ORG_DB!.prepare(
			"SELECT a.action,a.entity,a.actor,a.changes,h.snapshot_id FROM audit a JOIN round_two_result_freeze_history h ON h.id=a.entity WHERE a.action IN('round_two.results.frozen','round_two.results.unfrozen') ORDER BY h.sequence",
		).all<{
			action: string;
			entity: string;
			actor: string;
			changes: string;
			snapshot_id: string;
		}>();

		const outcomes = [
			freeze.status,
			(frozen as Response).status,
			(stillFrozen as Response).status,
			freezeBody.snapshotId,
			historyWhileFrozen.results.map((row) => row.action),
			unfreeze.status,
			liveBody.results.find((team) => team.teamId === "team-a")
				?.analysisAverage,
			history.results,
		];
		expect(outcomes).toEqual([
			200,
			200,
			200,
			expect.any(String),
			["FROZEN"],
			200,
			90,
			[
				{
					snapshot_id: freezeBody.snapshotId,
					action: "FROZEN",
					actor: "organizer:organizer-id",
					reason: "Freeze the current leaderboard for review.",
				},
				{
					snapshot_id: freezeBody.snapshotId,
					action: "UNFROZEN",
					actor: "organizer:organizer-id",
					reason: "Unfreeze results to include the revised review.",
				},
			],
		]);
		expect(
			audit.results.map((row) => ({
				action: row.action,
				entity: row.entity,
				actor: row.actor,
				snapshot_id: row.snapshot_id,
				changes: JSON.parse(row.changes),
			})),
		).toEqual([
			{
				action: "round_two.results.frozen",
				entity: expect.any(String),
				actor: "organizer:organizer-id",
				snapshot_id: freezeBody.snapshotId,
				changes: {
					snapshotId: freezeBody.snapshotId,
					reason: "Freeze the current leaderboard for review.",
				},
			},
			{
				action: "round_two.results.unfrozen",
				entity: expect.any(String),
				actor: "organizer:organizer-id",
				snapshot_id: freezeBody.snapshotId,
				changes: {
					snapshotId: freezeBody.snapshotId,
					reason: "Unfreeze results to include the revised review.",
				},
			},
		]);
		const frozenBody = await frozen.json() as {
			results: { teamId: string; analysisAverage: number | null }[];
		};
		const stillFrozenBody = await stillFrozen.json() as typeof frozenBody;
		expect(
			[
				frozenBody.results.find((team) => team.teamId === "team-a")
					?.analysisAverage,
				stillFrozenBody.results.find((team) => team.teamId === "team-a")
					?.analysisAverage,
			],
		).toEqual([82, 82]);
	});

	it("excludes engineering scores whose rubric no longer matches the team's selected track", async () => {
		await env.ORG_DB!.prepare(
			"INSERT INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason,rubric_version_id) VALUES('a-pr-mismatched','team-a','judge-1','ENGINEERING',2,95,'{}',NULL,'Latest review on old track','rubric-a'),('a-pr-current','team-a','judge-2','ENGINEERING',2,92,'{}',NULL,'Latest review on current track','rubric-b')",
		).run();
		await env.ORG_DB!.prepare(
			"UPDATE team_repositories SET active=0 WHERE team_id='team-a'",
		).run();
		await env.ORG_DB!.prepare(
			"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',2,'organizer:test')",
		).run();
		const response = await roundTwoReview(request(), env, organizer);
		const body = await response.json() as {
			results: { teamId: string; engineeringJudgeCount: number; status: string; finalScore: number | null }[];
		};
		const team = body.results.find((result) => result.teamId === "team-a");
		expect(team).toMatchObject({
			engineeringJudgeCount: 1,
			engineeringAverage: 92,
			status: "PENDING",
			manualAggregateScore: 91,
			finalScore: null,
		});
		const historical = await env.ORG_DB!.prepare(
			"SELECT count(*) AS count FROM round_two_review_submissions WHERE team_id='team-a' AND stage='ENGINEERING'",
		).first<{ count: number }>();
		expect(historical?.count).toBe(4);
	});

	it("keeps reviews pinned to an older rubric version on the same repository", async () => {
		await env.ORG_DB!.prepare(
			"INSERT INTO round_two_repository_rubric_versions(id,repository_id,version,criteria,actor) VALUES('rubric-a-v2',1,2,'[]','organizer:test')",
		).run();
		await env.ORG_DB!.prepare(
			"UPDATE round_two_active_repository_rubrics SET rubric_id='rubric-a-v2' WHERE repository_id=1",
		).run();
		await finalReview(
			"a-pr-revision-v1",
			"team-a",
			"judge-1",
			"ENGINEERING",
			2,
			94,
			"rubric-a",
		);
		const response = await roundTwoReview(request(), env, organizer);
		const body = await response.json() as {
			results: { teamId: string; engineeringJudgeCount: number; engineeringAverage: number | null; finalScore: number | null }[];
		};
		expect(body.results.find((result) => result.teamId === "team-a")).toMatchObject({
			engineeringJudgeCount: 2,
			engineeringAverage: 93,
			status: "PENDING",
			manualAggregateScore: 91.9,
			finalScore: null,
		});
	});

	it("keeps the manual-review aggregate separate from the official score", async () => {
		const response = await roundTwoResults(request(), env, organizer),
			result = (await response.json()) as {
				results: {
					teamId: string;
					status: string;
					analysisAverage: number | null;
					engineeringAverage: number | null;
					analysisJudgeCount: number;
					engineeringJudgeCount: number;
					finalScore: number | null;
				}[];
			},
			team = result.results.find((item) => item.teamId === "team-a");

		expect(team).toMatchObject({
			status: "PENDING",
			analysisAverage: 82,
			engineeringAverage: 91,
			analysisJudgeCount: 2,
			engineeringJudgeCount: 2,
			manualAggregateScore: 90.1,
			finalScore: null,
		});
	});

	it("keeps results pending when a stage has no submitted reviews", async () => {
		const response = await roundTwoResults(request(), env, organizer),
			result = (await response.json()) as {
				results: {
					teamId: string;
					status: string;
					analysisAverage: number | null;
					engineeringAverage: number | null;
					finalScore: number | null;
				}[];
			},
			team = result.results.find((item) => item.teamId === "team-b");

		expect(team).toMatchObject({
			status: "PENDING",
			analysisAverage: 75,
			engineeringAverage: null,
			finalScore: null,
		});
	});

	it("does not expose aggregate results to participant or judge sessions", async () => {
		const participantResponse = await roundTwoResults(
				request(),
				env,
				participant,
			),
			judgeResponse = await roundTwoResults(request(), env, judge);

		expect([participantResponse.status, judgeResponse.status]).toEqual([
			403,
			403,
		]);
	});

	it("allows only organizers to freeze or unfreeze results", async () => {
		const outcomes = [];
		for (const session of [judge, participant]) {
			outcomes.push(
				(await roundTwoResults(
					request(
						"/api/organization/round-two/results/freeze",
						"POST",
						{
							reason:
								"Attempt to freeze results without organizer access.",
						},
					),
					env,
					session,
				)).status,
				(await roundTwoResults(
					request(
						"/api/organization/round-two/results/freeze",
						"DELETE",
						{
							reason:
								"Attempt to unfreeze results without organizer access.",
						},
					),
					env,
					session,
				)).status,
			);
		}
		expect(outcomes).toEqual([403, 403, 403, 403]);
		expect(
			await env.ORG_DB!.prepare(
				"SELECT COUNT(*) AS count FROM round_two_result_freeze_history",
			).first("count"),
		).toBe(0);
	});

	it("keeps a newer freeze when an unfreeze used an older observed snapshot", async () => {
		await finalizeAllTeams();
		const freeze = (reason: string) =>
			roundTwoResults(
				request("/api/organization/round-two/results/freeze", "POST", {
					reason,
				}),
				env,
				organizer,
			);
		const unfreeze = (reason: string) =>
			roundTwoResults(
				request(
					"/api/organization/round-two/results/freeze",
					"DELETE",
					{
						reason,
					},
				),
				env,
				organizer,
			);
		const first = await freeze("Freeze the first results snapshot.");
		const firstId =
			(await first.json() as { snapshotId: string }).snapshotId;
		let releaseRead!: () => void,
			observedRead!: () => void;
		let observedSnapshotId: string | null = null;
		const readObserved = new Promise<void>((resolve) => {
				observedRead = resolve;
			}),
			continueRead = new Promise<void>((resolve) => {
				releaseRead = resolve;
			});
		const db = new Proxy(env.ORG_DB!, {
			get(target, property) {
				if (property === "prepare") {
					return (sql: string) => {
						const statement = target.prepare(sql);
						if (!sql.includes("FROM round_two_result_freeze f")) {
							return statement;
						}
						return new Proxy(statement, {
							get(inner, method) {
								if (method !== "first") {
									const value = Reflect.get(
										inner,
										method,
										inner,
									);
									return typeof value === "function"
										? value.bind(inner)
										: value;
								}
								return async <T = unknown>(
									columnName?: string,
								) => {
									const row = columnName === undefined
										? await inner.first<T>()
										: await inner.first<T>(columnName);
									observedSnapshotId = (
										row as { snapshot_id: string } | null
									)?.snapshot_id ?? null;
									observedRead();
									await continueRead;
									return row;
								};
							},
						});
					};
				}
				return Reflect.get(target, property, target);
			},
		});
		const staleUnfreezePromise = roundTwoResults(
			request("/api/organization/round-two/results/freeze", "DELETE", {
				reason: "Stale request to unfreeze the first results snapshot.",
			}),
			{ ...env, ORG_DB: db } as Env,
			organizer,
		);
		await readObserved;
		expect(observedSnapshotId).toBe(firstId);
		await unfreeze("Unfreeze the first results snapshot.");
		const second = await freeze("Freeze the second results snapshot.");
		const secondId =
			(await second.json() as { snapshotId: string }).snapshotId;
		releaseRead();
		const staleUnfreeze = await staleUnfreezePromise;
		const active = await env.ORG_DB!.prepare(
			"SELECT snapshot_id FROM round_two_result_freeze WHERE id=1",
		).first<{ snapshot_id: string }>();
		const history = await env.ORG_DB!.prepare(
			"SELECT snapshot_id,action FROM round_two_result_freeze_history ORDER BY sequence",
		).all<{ snapshot_id: string; action: string }>();
		expect([
			staleUnfreeze.status,
			active?.snapshot_id,
			history.results,
		]).toEqual([
			409,
			secondId,
			[
				{ snapshot_id: firstId, action: "FROZEN" },
				{ snapshot_id: firstId, action: "UNFROZEN" },
				{ snapshot_id: secondId, action: "FROZEN" },
			],
		]);
	});

	it("handles simultaneous freeze requests as one transition", async () => {
		await finalizeAllTeams();
		const freeze = (reason: string) =>
			roundTwoResults(
				request("/api/organization/round-two/results/freeze", "POST", {
					reason,
				}),
				env,
				organizer,
			);
		const responses = await Promise.all([
			freeze("Freeze the leaderboard from organizer one."),
			freeze("Freeze the leaderboard from organizer two."),
		]);
		const bodies = await Promise.all(
			responses.map((response) =>
				response.json() as Promise<{
					snapshotId: string;
				}>
			),
		);
		const history = await env.ORG_DB!.prepare(
			"SELECT action FROM round_two_result_freeze_history ORDER BY sequence",
		).all<{ action: string }>();
		expect([
			responses.map((response) => response.status),
			bodies[0]?.snapshotId,
			bodies[1]?.snapshotId,
			history.results,
		]).toEqual([
			[200, 200],
			expect.any(String),
			bodies[0]?.snapshotId,
			[{ action: "FROZEN" }],
		]);
	});

	it("reads result inputs in one D1 batch", async () => {
		const batchSizes: number[] = [];
		const db = new Proxy(env.ORG_DB!, {
			get(target, property) {
				if (property === "batch") {
					return (statements: D1PreparedStatement[]) => {
						batchSizes.push(statements.length);
						return target.batch(statements);
					};
				}
				return Reflect.get(target, property, target);
			},
		});
		await roundTwoResults(
			request(),
			{ ...env, ORG_DB: db } as Env,
			organizer,
		);
		expect(batchSizes).toContain(5);
	});

	it("includes only feedback from latest submitted revisions in result snapshots", async () => {
		await finalizeAllTeams();
		await finalReview("a-doc-4", "team-a", "judge-1", "ANALYSIS", 3, 100, null, { problemUnderstanding: "Clear framing", remediation: "Fix addresses root cause", innovationImpact: "Strong impact", overall: "Final submitted comment" });
		await env.ORG_DB!.prepare("INSERT INTO round_two_review_drafts(team_id,judge_identity_id,stage,score,payload,document_id) VALUES('team-a','judge-1','ANALYSIS',99,?,NULL)")
			.bind(JSON.stringify({ overall: "Private draft comment" }))
			.run();
		const response = await roundTwoReview(
			request("/api/organization/round-two/results/snapshots", "POST", { reason: "Snapshot the submitted judging feedback." }),
			env,
			organizer,
		);
		const snapshot = await response.json() as { snapshot: { results: Array<{ teamId: string; feedback?: { analysis: Array<Record<string, unknown>>; engineering: Array<Record<string, unknown>> }; feedbackTruncated?: boolean }>; ranking: Array<Record<string, unknown>> } };
		const team = snapshot.snapshot.results.find(item => item.teamId === "team-a");
		expect(response.status).toBe(201);
		expect(team?.feedback?.analysis).toEqual([{
			problemUnderstanding: "Clear framing",
			remediation: "Fix addresses root cause",
			innovationImpact: "Strong impact",
			overall: "Final submitted comment",
		}]);
		expect(JSON.stringify(snapshot)).not.toContain("Private draft comment");
		expect(snapshot.snapshot.ranking.every(item => !("feedback" in item))).toBe(true);
		const feedbackBytes = snapshot.snapshot.results.reduce((total, result) => total + new TextEncoder().encode(JSON.stringify(result.feedback ?? null)).byteLength, 0);
		expect(feedbackBytes).toBeLessThanOrEqual(512 * 1024);
		expect(new TextEncoder().encode(JSON.stringify(team?.feedback ?? null)).byteLength).toBeLessThanOrEqual(8 * 1024);
	});

	it("freezes score results and publishes only complete snapshots", async () => {
		await finalizeScore("team-a", "judge-1", 90.1);
		const createSnapshot = () =>
				roundTwoReview(
					request(
						"/api/organization/round-two/results/snapshots",
						"POST",
						{ reason: "Freeze the completed judging results." },
					),
					env,
					organizer,
				),
			firstSnapshotResponse = await createSnapshot();

		const judgeSnapshot = await roundTwoReview(
			request(
				"/api/organization/round-two/results/snapshots",
				"POST",
				{ reason: "Judge attempts to freeze results." },
			),
			env,
			judge,
		);
		expect([
			firstSnapshotResponse.status,
			judgeSnapshot.status,
			(await firstSnapshotResponse.json() as { error: string }).error,
		]).toEqual([409, 403, "FINAL_SCORES_REQUIRED"]);

		await finalReview(
			"a-doc-4",
			"team-a",
			"judge-1",
			"ANALYSIS",
			3,
			100,
		);
		await finalReview(
			"b-pr-1",
			"team-b",
			"judge-1",
			"ENGINEERING",
			1,
			85,
			"rubric-a",
		);
		const teamBFinal = await finalizeScore("team-b", "judge-1", 85);
		expect(teamBFinal.status).toBe(201);
		const completeSnapshotResponse = await createSnapshot(),
			completeSnapshot = (await completeSnapshotResponse.json()) as {
				id: string;
				snapshot: {
					results: { teamId: string; finalScore: number | null }[];
				};
			};
		const published = await roundTwoReview(
			request(
				"/api/organization/round-two/results/publication",
				"POST",
				{
					snapshotId: completeSnapshot.id,
					reason: "Publish completed results.",
				},
			),
			env,
			organizer,
		);
		const unpublish = await roundTwoReview(
			request(
				"/api/organization/round-two/results/publication",
				"POST",
				{
					snapshotId: null,
					reason: "Withdraw results for correction.",
				},
			),
			env,
			organizer,
		);

		expect([
			completeSnapshotResponse.status,
			published.status,
			unpublish.status,
			(await env.ORG_DB!.prepare(
				"SELECT snapshot_id FROM round_two_result_publication WHERE id=1",
			).first("snapshot_id")) ?? null,
			await env.ORG_DB!.prepare(
				"SELECT COUNT(*) AS count FROM round_two_result_publication_history",
			).first("count"),
		]).toEqual([201, 200, 200, null, 2]);
	});
});
