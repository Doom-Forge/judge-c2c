import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";
import type { GitHub } from "../src/github";
import type { EvidenceClientFactory } from "../src/round-two-github";
import { roundTwoReview } from "../src/round-two-review";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";

const judge: ConsoleSession = {
	hash: "judge-session",
	role: "judge",
	identity_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	name: "Judge A",
	team_id: null,
};
const organizer: ConsoleSession = {
	hash: "organizer-session",
	role: "organizer",
	identity_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	name: "Organizer",
	team_id: null,
};

let mf: Miniflare;
let env: Env;
let api: ReturnType<typeof vi.fn>;
let clientFactory: EvidenceClientFactory;

function request(teamId = "team-a", repositoryId = 1, prNumber = 12) {
	return new Request(
		`https://organization.test/api/organization/round-two/teams/${teamId}/pull-requests/${repositoryId}/${prNumber}`,
	);
}

function clientResponse(path: string) {
	if (path.endsWith("/pulls/12")) {
		return {
			number: 12,
			title: "Add ledger pagination",
			html_url: "https://github.com/180DC-VIT-CHENNAI/noyyal-treasury/pull/12",
			user: { login: "contributor" },
			created_at: "2026-11-01T10:00:00Z",
			updated_at: "2026-11-08T10:00:00Z",
			state: "open",
			merged_at: null,
			additions: 17,
			deletions: 4,
			head: { sha: "d".repeat(40) },
			base: { repo: { id: 1 } },
		};
	}
	if (path.includes("/files?")) {
		return [{
			filename: "src/ledger.ts",
			status: "modified",
			additions: 17,
			deletions: 4,
			patch: "+".repeat(5000),
		}];
	}
	if (path.includes("/commits?")) {
		return [{
			sha: "e".repeat(40),
			author: { login: "contributor" },
			commit: {
				message: "Add paginated ledger query",
				author: { name: "Contributor", date: "2026-11-07T10:00:00Z" },
			},
		}];
	}
	if (path.includes("/reviews?")) {
		return [{
			user: { login: "reviewer" },
			state: "COMMENTED",
			submitted_at: "2026-11-08T09:00:00Z",
			body: "Please add a regression test.",
		}];
	}
	if (path.includes("/check-runs?")) {
		return {
			total_count: 1,
			check_runs: [{
				name: "unit-tests",
				status: "completed",
				conclusion: "success",
				details_url: "https://github.com/180DC-VIT-CHENNAI/noyyal-treasury/actions/runs/1",
			}],
		};
	}
	if (path.includes("/code-scanning/alerts?")) {
		return [{
			rule: { name: "js/sql-injection", description: "Untrusted input reaches SQL." },
			state: "open",
			html_url: "https://github.com/180DC-VIT-CHENNAI/noyyal-treasury/security/code-scanning/1",
			created_at: "2026-11-07T11:00:00Z",
			most_recent_instance: { location: { path: "src/ledger.ts" } },
		}];
	}
	throw new Error(`Unexpected GitHub API request: ${path}`);
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
		.prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A'),('team-b','Team B')")
		.run();
	await db
		.prepare("INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(1,'180DC-VIT-CHENNAI/noyyal-treasury',0,'main'),(2,'180DC-VIT-CHENNAI/rasoi-offer-roulette',0,'main')")
		.run();
	await db
		.prepare("INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',1,'organizer:test'),('team-b',2,'organizer:test')")
		.run();
	await db
		.prepare("INSERT INTO console_identities(id,name,role,credential_hash) VALUES(?, 'Judge A','judge',?), (?, 'Organizer','organizer',?)")
		.bind(judge.identity_id, "a".repeat(64), organizer.identity_id, "c".repeat(64))
		.run();
	await db
		.prepare("INSERT INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES('assignment-a',?,'team-a','organizer:test')")
		.bind(judge.identity_id)
		.run();
	await db
		.prepare("INSERT INTO matrix_repositories(repository_id,full_name,baseline_sha,matrix_version,matrix_digest,image_uri) VALUES(1,'180DC-VIT-CHENNAI/noyyal-treasury',?,'matrix-v1',?,'registry/test@sha256:abc'),(2,'180DC-VIT-CHENNAI/rasoi-offer-roulette',?,'matrix-v1',?,'registry/test@sha256:def')")
		.bind("b".repeat(40), "1".repeat(64), "f".repeat(40), "2".repeat(64))
		.run();
	const report = JSON.stringify({
		categories: {
			scalability: { status: "PASS", score: 100 },
			security: { status: "UNVERIFIED", score: null },
			usefulness: { status: "PASS", score: 100 },
		},
		overallScore: null,
		checks: [{ id: "security-check", category: "security", status: "UNVERIFIED", durationMs: 5, detail: "No static scan configured." }],
	});
	await db
		.prepare("INSERT INTO matrix_runs(id,repository_id,full_name,pr_number,head_sha,baseline_sha,matrix_version,matrix_digest,image_uri,state,report) VALUES('run-a',1,'180DC-VIT-CHENNAI/noyyal-treasury',12,?,?,?,?,?,'COMPLETED',?),('run-b',2,'180DC-VIT-CHENNAI/rasoi-offer-roulette',13,?,?,?,?,?,'COMPLETED',?)")
		.bind("b".repeat(40), "a".repeat(40), "matrix-v1", "1".repeat(64), "registry/test@sha256:abc", report, "e".repeat(40), "f".repeat(40), "matrix-v1", "2".repeat(64), "registry/test@sha256:def", report)
		.run();
	await db
		.prepare("INSERT INTO matrix_submissions(repository_id,pr_number,head_sha,updated_at,closed,latest_run_id,team_id,author_id,author_login,mapping_status) VALUES(1,12,?,'2026-11-08T10:00:00Z',0,'run-a','team-a',9001,'contributor','MAPPED'),(2,13,?,'2026-11-08T10:00:00Z',0,'run-b','team-b',9002,'contributor-b','MAPPED')")
		.bind("b".repeat(40), "e".repeat(40))
		.run();
	env = { ORG_DB: db } as unknown as Env;
	api = vi.fn(async (path: string) => clientResponse(path));
	clientFactory = vi.fn(async () => ({ api }) as unknown as GitHub) as unknown as EvidenceClientFactory;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await mf.dispose();
});

describe("assigned judge live pull request evidence", () => {
	it("returns bounded real GitHub evidence and marks a changed head stale", async () => {
		const response = await roundTwoReview(request(), env, judge, clientFactory);
		const result = (await response.json()) as {
			pullRequest: { title: string; state: string; additions: number; deletions: number };
			captured: { headSha: string; baselineSha: string };
			stale: boolean;
			changedFiles: { filename: string; patch: string; patchTruncated: boolean }[];
			commits: { sha: string; message: string; author: string; date: string }[];
			reviews: { author: string; state: string }[];
			checks: { name: string; status: string; conclusion: string }[];
			securityFindings: { rule: string; severity: string | null }[];
			automatedEvaluation: { status: string; checks: { id: string; status: string }[] };
		};

		expect(response.status).toBe(200);
		expect(result.pullRequest).toMatchObject({
			title: "Add ledger pagination",
			state: "open",
			additions: 17,
			deletions: 4,
		});
		expect(result.captured).toEqual({ headSha: "b".repeat(40), baselineSha: "a".repeat(40) });
		expect(result.stale).toBe(true);
		expect(result.changedFiles[0]).toMatchObject({
			filename: "src/ledger.ts",
			patchTruncated: true,
		});
		expect(result.changedFiles[0]!.patch.length).toBeLessThanOrEqual(4000);
		expect(result.commits[0]).toMatchObject({ author: "contributor", message: "Add paginated ledger query" });
		expect(result.reviews[0]).toMatchObject({ author: "reviewer", state: "COMMENTED" });
		expect(result.checks[0]).toMatchObject({ name: "unit-tests", status: "completed", conclusion: "success" });
		expect(result.securityFindings[0]).toMatchObject({ rule: "js/sql-injection" });
		expect(result.automatedEvaluation).toMatchObject({
			status: "available",
			checks: [{ id: "security-check", status: "UNVERIFIED" }],
		});
		expect(clientFactory).toHaveBeenCalledWith(env, 1, false);
		expect(api.mock.calls.every(([path]) => String(path).startsWith("/repos/180DC-VIT-CHENNAI/noyyal-treasury/"))).toBe(true);
	});

	it("hides another team's PR from a judge before calling GitHub", async () => {
		const response = await roundTwoReview(request("team-b", 2, 12), env, judge, clientFactory);

		expect(response.status).toBe(404);
		expect(clientFactory).not.toHaveBeenCalled();
	});

	it("pages changed files and signals when more evidence remains", async () => {
		api.mockImplementation(async (path: string) => {
			if (path.includes("/files?")) {
				return Array.from({ length: 17 }, (_, index) => ({
					filename: `src/file-${index}.ts`,
					status: "modified",
					additions: 1,
					deletions: 0,
					patch: "+line",
				}));
			}
			return clientResponse(path);
		});
		const evidenceRequest = new Request(`${request().url}?filesPage=2`);
		const response = await roundTwoReview(evidenceRequest, env, judge, clientFactory);
		const result = (await response.json()) as {
			changedFiles: { filename: string }[];
			changedFilesPage: { page: number; hasMore: boolean; status: string };
		};

		expect(response.status).toBe(200);
		expect(result.changedFiles).toHaveLength(16);
		expect(result.changedFilesPage).toMatchObject({ page: 2, hasMore: true, status: "available" });
		expect(api.mock.calls.some(([path]) => String(path).includes("/files?per_page=17&page=2"))).toBe(true);
	});

	it("reports optional GitHub services as unavailable without losing PR metadata", async () => {
		api.mockImplementation(async (path: string) => {
			if (path.includes("/check-runs?") || path.includes("/code-scanning/alerts?")) {
				throw new Error("GITHUB_HTTP_403");
			}
			return clientResponse(path);
		});
		const response = await roundTwoReview(request(), env, judge, clientFactory);
		const result = (await response.json()) as {
			pullRequest: { number: number };
			checks: unknown[];
			checksPage: { status: string; reason: string };
			securityFindings: unknown[];
			securityFindingsPage: { status: string; reason: string };
		};

		expect(response.status).toBe(200);
		expect(result.pullRequest.number).toBe(12);
		expect(result.checks).toEqual([]);
		expect(result.checksPage).toMatchObject({ status: "unavailable", reason: "permission_required" });
		expect(result.securityFindings).toEqual([]);
		expect(result.securityFindingsPage).toMatchObject({ status: "unavailable", reason: "permission_required" });
	});

	it("allows organizers to inspect assigned-team evidence", async () => {
		const response = await roundTwoReview(request(), env, organizer, clientFactory);
		expect(response.status).toBe(200);
		expect(clientFactory).toHaveBeenCalledWith(env, 1, false);
	});
});
