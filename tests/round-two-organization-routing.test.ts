import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import { organization } from "../src/organization";
import { digest } from "../src/domain";
import type { Env } from "../src/env";

const origin = "https://organization.test",
	token = "organizer-token-" + "x".repeat(40),
	judgeToken = "judge-token-" + "y".repeat(40),
	judgeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	participantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let mf: Miniflare, env: Env;
const ctx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

function request(path: string, method = "GET", data?: unknown, cookie = "") {
	return new Request(origin + path, {
		method,
		headers: {
			origin,
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
		},
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
			"INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(1,'180DC-VIT-CHENNAI/veera-footwear',0,'main',1)",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES(?, 'Judge A','judge',NULL,?),(?,'Team A lead','participant','team-a',?)",
		)
		.bind(judgeId, await digest(judgeToken), participantId, "b".repeat(64))
		.run();
	await db
		.prepare(
			"INSERT INTO team_documents(id,team_id,version,object_key,filename,content_type,bytes,sha256,status,uploaded_by_identity_id) VALUES('document-a','team-a',1,'analysis-documents/a','analysis.pdf','application/pdf',12,?,'STORED',?)",
		)
		.bind("c".repeat(64), participantId)
		.run();
	env = {
		ORG_DB: db,
		ORG_ADMIN_TOKEN: token,
		ORG_VAULT_KEY: "12".repeat(32),
		ORG_PUBLIC_ORIGIN: origin,
		ORG_NAME: "Doomforge",
	} as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("organization round two routes", () => {
	it("routes organizer judge assignments through the authenticated API", async () => {
		const login = await organization(
				request("/api/organization/login", "POST", { token }),
				env,
				ctx,
			),
			cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "",
			response = await organization(
				request(
					"/api/organization/round-two/assignments",
					"POST",
					{
						judgeIdentityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
						teamId: "team-a",
					},
					cookie,
				),
				env,
				ctx,
			);

		expect(response.status, await response.clone().text()).toBe(201);
	});

	it("allows an assigned judge to save a private analysis draft", async () => {
		const organizerLogin = await organization(
				request("/api/organization/login", "POST", { token }),
				env,
				ctx,
			),
			organizerCookie =
				organizerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
		await organization(
			request(
				"/api/organization/round-two/assignments",
				"POST",
				{ judgeIdentityId: judgeId, teamId: "team-a" },
				organizerCookie,
			),
			env,
			ctx,
		);
		const judgeLogin = await organization(
				request("/api/organization/login", "POST", {
					token: judgeToken,
				}),
				env,
				ctx,
			),
			judgeCookie = judgeLogin.headers.get("set-cookie")?.split(";")[0] ??
				"",
			response = await organization(
				request(
					"/api/organization/round-two/reviews",
					"POST",
					{
						action: "SAVE_DRAFT",
						teamId: "team-a",
						stage: "ANALYSIS",
						score: 80,
						feedback: {
							problemUnderstanding: "Problem is clear.",
							remediation: "Fix is feasible.",
							innovationImpact: "Impact is useful.",
							overall: "Good analysis.",
						},
						documentId: "document-a",
					},
					judgeCookie,
				),
				env,
				ctx,
			);

		expect(response.status, await response.clone().text()).toBe(200);
		const evidence = await organization(
			request(
				"/api/organization/round-two/reviews?teamId=team-a&stage=ANALYSIS",
				"GET",
				undefined,
				judgeCookie,
			),
			env,
			ctx,
		);
		expect(evidence.status).toBe(200);
	});

	it("routes official repository rubric imports through organizer auth", async () => {
		const login = await organization(
				request("/api/organization/login", "POST", { token }),
				env,
				ctx,
			),
			cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "",
			response = await organization(
				request(
					"/api/organization/round-two/rubrics",
					"POST",
					{
						repositoryId: 1,
						criteria: [
							{ id: "accuracy", label: "Accuracy", weight: 40 },
							{ id: "security", label: "Security", weight: 30 },
							{
								id: "quality",
								label: "Code quality",
								weight: 30,
							},
						],
					},
					cookie,
				),
				env,
				ctx,
			);

		expect(response.status, await response.clone().text()).toBe(201);
	});

	it("routes private pending score aggregates to organizers", async () => {
		const login = await organization(
				request("/api/organization/login", "POST", { token }),
				env,
				ctx,
			),
			cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "",
			response = await organization(
				request(
					"/api/organization/round-two/results",
					"GET",
					undefined,
					cookie,
				),
				env,
				ctx,
			),
			result = (await response.json()) as {
				teams: number;
				completed: number;
				pending: number;
			};

		expect([
			response.status,
			result.teams,
			result.completed,
			result.pending,
		])
			.toEqual([200, 1, 0, 1]);
	});
});
