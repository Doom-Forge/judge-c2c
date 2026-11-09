import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";
import { roundTwoReview } from "../src/round-two-review";

const organizer: ConsoleSession = {
	hash: "organizer-session",
	role: "organizer",
	identity_id: "organizer-identity",
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
let mf: Miniflare, env: Env;

function request(path: string, method = "GET", data?: unknown) {
	return new Request(
		"https://organization.test/api/organization/round-two" + path,
		{
			method,
			headers: { "content-type": "application/json" },
			...(data === undefined ? {} : { body: JSON.stringify(data) }),
		},
	);
}

beforeEach(async () => {
	mf = new Miniflare({
		modules: true,
		script: 'export default{fetch(){return new Response("ok")}}',
		d1Databases: ["ORG_DB"],
		compatibilityDate: "2026-08-01",
	});
	const db = (await mf.getD1Database("ORG_DB")) as unknown as D1Database;
	await migrate(db);
	await db
		.prepare(
			"INSERT INTO teams(id,name) VALUES('team-a','Team A'),('team-b','Team B')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(1,'180DC-VIT-CHENNAI/noyyal-treasury',0,'main')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',1,'organizer:test')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO console_identities(id,name,role,credential_hash) VALUES(?, 'Judge A','judge',?)",
		)
		.bind(judge.identity_id, "a".repeat(64))
		.run();
	await db
		.prepare(
			"INSERT INTO matrix_runs(id,repository_id,full_name,pr_number,head_sha,baseline_sha,matrix_version,matrix_digest,image_uri,state) VALUES('run-a',1,'180DC-VIT-CHENNAI/noyyal-treasury',12,?,?,?,?,?,'COMPLETED')",
		)
		.bind(
			"b".repeat(40),
			"a".repeat(40),
			"pilot-v1",
			"c".repeat(64),
			"registry.cloudflare.com/test/image@sha256:" + "1".repeat(64),
		)
		.run();
	await db
		.prepare(
			"INSERT INTO matrix_submissions(repository_id,pr_number,head_sha,updated_at,closed,latest_run_id,team_id,author_id,author_login,mapping_status) VALUES(1,12,?,'2026-11-04T10:00:00Z',0,'run-a','team-a',9001,'member-one','MAPPED')",
		)
		.bind("b".repeat(40))
		.run();
	env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("judge access to attributed Matrix pull requests", () => {
	it("shows verified team pull requests to an assigned judge", async () => {
		await roundTwoReview(
			request("/assignments", "POST", {
				judgeIdentityId: judge.identity_id,
				teamId: "team-a",
			}),
			env,
			organizer,
		);
		const response = await roundTwoReview(
				request("/teams/team-a"),
				env,
				judge,
			),
			result = (await response.json()) as {
				matrixSubmissions: {
					pr_number: number;
					author_id: number;
					author_login: string;
					mapping_status: string;
					evaluation_status: string;
				}[];
			};

		expect(result.matrixSubmissions).toMatchObject([
			{
				pr_number: 12,
				author_id: 9001,
				author_login: "member-one",
				mapping_status: "MAPPED",
				evaluation_status: "COMPLETED",
			},
		]);
	});

	it("does not expose another team's Matrix pull requests", async () => {
		const response = await roundTwoReview(
			request("/teams/team-a"),
			env,
			judge,
		);

		expect(response.status).toBe(404);
	});
});
