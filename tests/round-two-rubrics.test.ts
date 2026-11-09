import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";
import { roundTwoRubrics } from "../src/round-two-rubrics";

const origin = "https://organization.test",
	organizer: ConsoleSession = {
		hash: "organizer-session",
		role: "organizer",
		identity_id: "organizer-identity",
		name: "Organizer",
		team_id: null,
	},
	judge: ConsoleSession = {
		hash: "judge-session",
		role: "judge",
		identity_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		name: "Judge A",
		team_id: null,
	},
	criteria = [
		{ id: "correctness", label: "Functional correctness", weight: 30 },
		{ id: "security", label: "Security", weight: 20 },
		{ id: "performance", label: "Performance", weight: 20 },
		{ id: "quality", label: "Code quality", weight: 15 },
		{ id: "innovation", label: "Innovation", weight: 10 },
		{ id: "reproducibility", label: "Reproducibility", weight: 5 },
	];
let mf: Miniflare, env: Env;

function request(path: string, method = "GET", data?: unknown) {
	return new Request(origin + "/api/organization/round-two/rubrics" + path, {
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
		.prepare(
			"INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(1,'doomforge/payment-engine',0,'main',1),(2,'doomforge/inventory-control',0,'main',1)",
		)
		.run();
	env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("repository track rubrics", () => {
	it("publishes versioned criteria for the selected repository track", async () => {
		const first = await roundTwoRubrics(
				request("", "POST", { repositoryId: 1, criteria }),
				env,
				organizer,
			),
			firstResult = (await first.json()) as {
				rubric: { id: string; version: number; criteria: unknown[] };
			},
			second = await roundTwoRubrics(
				request("", "POST", {
					repositoryId: 1,
					criteria: criteria.map((criterion) => ({
						...criterion,
						label: criterion.label + " updated",
					})),
				}),
				env,
				organizer,
			),
			secondResult = (await second.json()) as {
				rubric: { version: number };
			};

		expect([
			first.status,
			firstResult.rubric.version,
			firstResult.rubric.criteria.length,
			secondResult.rubric.version,
		]).toEqual([201, 1, 6, 2]);
	});

	it("rejects rubrics whose criterion weights do not total one hundred", async () => {
		const response = await roundTwoRubrics(
			request("", "POST", {
				repositoryId: 1,
				criteria: [
					{ id: "correctness", label: "Correctness", weight: 60 },
					{ id: "security", label: "Security", weight: 39 },
				],
			}),
			env,
			organizer,
		);

		expect(response.status).toBe(400);
	});

	it("does not let judges change track rubrics", async () => {
		const response = await roundTwoRubrics(
			request("", "POST", { repositoryId: 1, criteria }),
			env,
			judge,
		);

		expect(response.status).toBe(403);
	});
});
