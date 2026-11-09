import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";
import { roundTwoEvaluations } from "../src/round-two-evaluations";

const origin = "https://organization.test",
	judgeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	criteriaScores = [
		{ criterionId: "correctness", score: 100, comment: "Complete" },
		{ criterionId: "security", score: 80, comment: "Secure enough" },
		{ criterionId: "performance", score: 90, comment: "Fast" },
		{ criterionId: "quality", score: 80, comment: "Readable" },
		{ criterionId: "innovation", score: 100, comment: "Useful" },
		{ criterionId: "reproducibility", score: 100, comment: "Reproducible" },
	],
	judge: ConsoleSession = {
		hash: "judge-session",
		role: "judge",
		identity_id: judgeId,
		name: "Judge A",
		team_id: null,
	};
let mf: Miniflare, env: Env;

function request(path: string, method = "GET", data?: unknown) {
	return new Request(origin + "/api/organization/round-two/reviews" + path, {
		method,
		headers: { "content-type": "application/json" },
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
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
		.prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A')")
		.run();
	await db
		.prepare(
			"INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES(?, 'Judge A', 'judge', NULL, ?)",
		)
		.bind(judgeId, "a".repeat(64))
		.run();
	await db
		.prepare(
			"INSERT INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES('assignment-a',?,'team-a','organizer:test')",
		)
		.bind(judgeId)
		.run();
	await db
		.prepare(
			"INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(1,'180DC-VIT-CHENNAI/veera-footwear',0,'main',1)",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',1,'participant:team-a')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO round_two_repository_rubric_versions(id,repository_id,version,criteria,actor) VALUES('rubric-v1',1,1,?,'organizer:test')",
		)
		.bind(
			JSON.stringify([
				{ id: "correctness", label: "Correctness", weight: 30 },
				{ id: "security", label: "Security", weight: 20 },
				{ id: "performance", label: "Performance", weight: 20 },
				{ id: "quality", label: "Quality", weight: 15 },
				{ id: "innovation", label: "Innovation", weight: 10 },
				{ id: "reproducibility", label: "Reproducibility", weight: 5 },
			]),
		)
		.run();
	await db
		.prepare(
			"INSERT INTO round_two_active_repository_rubrics(repository_id,rubric_id,actor) VALUES(1,'rubric-v1','organizer:test')",
		)
		.run();
	env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("reasoned revision history", () => {
	it("records an authorized revision without losing the prior finalized evaluation", async () => {
		await roundTwoEvaluations(
			request("", "POST", {
				action: "SAVE_DRAFT",
				teamId: "team-a",
				stage: "ENGINEERING",
				criteriaScores,
				overall: "Initial finalized review.",
			}),
			env,
			judge,
		);
		const submitted = await roundTwoEvaluations(
			request("", "POST", {
				action: "SUBMIT",
				teamId: "team-a",
				stage: "ENGINEERING",
			}),
			env,
			judge,
		);
		const submittedResult = (await submitted.json()) as {
			id: string;
			revision: number;
			score: number;
		};
		const revisionReason = "Corrected scoring after evidence review.";
		const revised = await roundTwoEvaluations(
			request("", "POST", {
				action: "REVISE",
				teamId: "team-a",
				stage: "ENGINEERING",
				criteriaScores: criteriaScores.map((criterion) => ({
					...criterion,
					score: criterion.score - 10,
				})),
				overall: "Revised after reviewing the evidence.",
				reason: revisionReason,
			}),
			env,
			judge,
		);
		const revisedResult = (await revised.json()) as {
			id: string;
			revision: number;
			score: number;
			status: string;
		};
		const historyResponse = await roundTwoEvaluations(
			request("?teamId=team-a&stage=ENGINEERING"),
			env,
			judge,
		);
		const history = (await historyResponse.json()) as {
			submissions: {
				id: string;
				revision: number;
				score: number;
				reason: string;
			}[];
		};
		const audit = await env.ORG_DB!
			.prepare(
				"SELECT actor,changes FROM audit WHERE action='review.revised' AND entity=?",
			)
			.bind(`team-a:${judgeId}:ENGINEERING`)
			.first<{ actor: string; changes: string }>();

		expect(submitted.status).toBe(201);
		expect(revised.status).toBe(201);
		expect(revisedResult).toMatchObject({ revision: 2, status: "FINAL" });
		expect(revisedResult.id).not.toBe(submittedResult.id);
		expect(history.submissions).toHaveLength(2);
		expect(history.submissions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: submittedResult.id,
					revision: 1,
					score: submittedResult.score,
					reason: "Initial submission",
				}),
				expect.objectContaining({
					id: revisedResult.id,
					revision: 2,
					score: revisedResult.score,
					reason: revisionReason,
				}),
			]),
		);
		expect(audit).toBeTruthy();
		expect(audit!.actor).toBe(`judge:${judgeId}`);
		expect(JSON.parse(audit!.changes)).toMatchObject({
			revision: 2,
			reason: revisionReason,
		});
	});
});
