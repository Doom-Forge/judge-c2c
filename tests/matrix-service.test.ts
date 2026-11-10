import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { readFileSync } from "node:fs";
import { acceptMatrixPR, matrixApi } from "../src/matrix-service";
import type { Env } from "../src/env";
import type { GitHub } from "../src/github";
import { acquireMatrixSlot, releaseMatrixSlot } from "../src/matrix-capacity";
let mf: Miniflare, env: Env;
const jobs: string[] = [];
const payload = (
	sha = "b".repeat(40),
	date = "2026-11-04T10:00:00Z",
	repositoryId = 1442222461,
	repositoryName = "180DC-VIT-CHENNAI/noyyal-treasury",
) => ({
	action: "opened",
	installation: { id: 42 },
	repository: {
		id: repositoryId,
		full_name: repositoryName,
	},
	pull_request: {
		number: 4,
		user: { id: 9001, login: "member-one" },
		head: { sha },
		base: { repo: { id: repositoryId } },
		updated_at: date,
		state: "open",
	},
});
beforeAll(async () => {
	mf = new Miniflare({
		modules: true,
		script: "export default{}",
		d1Databases: ["DB"],
		compatibilityDate: "2026-08-01",
	});
	const db = (await mf.getD1Database("DB")) as unknown as D1Database;
	for (
		const file of [
			"0004_organization.sql",
			"0027_matrix_judging.sql",
			"0028_matrix_capacity.sql",
		"0030_default_reviewer.sql",
			"0031_matrix_cost_controls.sql",
		]
	) {
		for (
			const sql of readFileSync("migrations/" + file, "utf8")
				.split(";")
				.filter((s) => s.trim())
		) {
			await db.prepare(sql).run();
		}
	}
	await db
		.prepare(
			"INSERT INTO github_connection VALUES(1,1,'fixture','fixture',42)",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO github_repositories VALUES(1442222461,'180DC-VIT-CHENNAI/noyyal-treasury',0,'main',1)",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO matrix_repositories VALUES(1442222461,'180DC-VIT-CHENNAI/noyyal-treasury',?,'pilot-v1',?,'registry.cloudflare.com/fixture/image@sha256:1111111111111111111111111111111111111111111111111111111111111111')",
		)
		.bind("a".repeat(40), "c".repeat(64))
		.run();
	for (
		const [index, name] of [
			"mazhai-cover",
			"pricingpulse",
			"veera-footwear",
			"janus",
		].entries()
	) {
		await db
			.prepare("INSERT INTO github_repositories VALUES(?,?,?,?,1)")
			.bind(1442222462 + index, `Doom-Forge/${name}`, 0, "main")
			.run();
	}
	await db.prepare("CREATE TABLE teams(id TEXT PRIMARY KEY,status TEXT,hackathon_id TEXT DEFAULT 'initial',track_finalized INTEGER DEFAULT 0)")
		.run();
	await db
		.prepare(
			"CREATE TABLE team_members(id TEXT,team_id TEXT,github_id INTEGER,github_login TEXT,active INTEGER,hackathon_id TEXT)",
		)
		.run();
	await db
		.prepare(
			"CREATE TABLE team_repositories(team_id TEXT,repository_id INTEGER,active INTEGER)",
		)
		.run();
	await db.prepare("CREATE TABLE console_identities(id TEXT,team_id TEXT,role TEXT,team_member_id TEXT,team_roster_member_id TEXT,github_verified_at TEXT,revoked_at TEXT)").run();
	await db.prepare("CREATE TABLE team_roster_members(id TEXT,linked_team_member_id TEXT,active INTEGER)").run();
	await db
		.prepare(
			"INSERT INTO teams(id,status) VALUES('team-one','ACTIVE'),('team-two','ACTIVE')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO team_members VALUES('member-one','team-one',9001,'member-one',1,'initial'),('member-two','team-two',9002,'member-two',1,'initial')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO team_repositories VALUES('team-one',1442222461,1),('team-two',1442222461,1)",
		)
		.run();
	for (
		const sql of readFileSync(
			"migrations/0036_matrix_team_attribution.sql",
			"utf8",
		)
			.split(";")
			.filter((statement) => statement.trim())
	) {
		await db.prepare(sql).run();
	}
	for (const sql of readFileSync("migrations/0048_unverified_matrix_intake.sql", "utf8").split(";").filter((statement) => statement.trim())) {
		await db.prepare(sql).run();
	}
	env = {
		DB: db,
		ORG_DB: db,
		ADMIN_TOKEN: "x".repeat(40),
		MATRIX_EVALUATOR: {
			create: async ({ id }: { id: string }) => {
				jobs.push(id);
				return { id };
			},
		},
	} as unknown as Env;
});
afterAll(async () => mf.dispose());
it("bounds container concurrency and never expires uncertain owners", async () => {
	const one = await acquireMatrixSlot(env.DB, "test-repo", "one", 1000);
	await acquireMatrixSlot(env.DB, "test-repo", "two", 1000);
	await expect(
		acquireMatrixSlot(env.DB, "test-repo", "three", 1000),
	).rejects.toThrow("MATRIX_BUSY");
	await releaseMatrixSlot(env.DB, one, "wrong-owner");
	await expect(
		acquireMatrixSlot(env.DB, "test-repo", "three", 1000),
	).rejects.toThrow("MATRIX_BUSY");
	await expect(
		acquireMatrixSlot(env.DB, "test-repo", "three", 181001),
	).rejects.toThrow("MATRIX_BUSY");
	await releaseMatrixSlot(env.DB, one, "one");
	expect(await acquireMatrixSlot(env.DB, "test-repo", "three", 181001)).toBe(
		one,
	);
});
it("requires organizer auth for matrix overview", async () => {
	expect(
		(await matrixApi(new Request("https://test/api/matrix/overview"), env))
			.status,
	).toBe(401);
});
it("durably accepts the four new repos without dispatching any matrix run", async () => {
	const response = await matrixApi(
		new Request("https://test/api/matrix/overview", {
			headers: { Authorization: `Bearer ${"x".repeat(40)}` },
		}),
		env,
	);
	const overview = (await response.json()) as {
		repositories: {
			id: number;
			full_name: string;
			evaluation_status: string;
		}[];
	};
	const expected = [
		"mazhai-cover",
		"pricingpulse",
		"veera-footwear",
		"janus",
	];
	for (const [index, name] of expected.entries()) {
		const fullName = `Doom-Forge/${name}`;
		expect(
			overview.repositories.find(
				(repository) => repository.full_name === fullName,
			)?.evaluation_status,
		).toBe("SPECIFICATION_REQUIRED");
		const result = await acceptMatrixPR(
			payload(
				"b".repeat(40),
				"2026-11-04T10:00:00Z",
				1442222462 + index,
				fullName,
			),
			env,
			`unconfigured-${name}`,
			`hash-${name}`,
			undefined,
			{ publishCheck: async () => undefined },
		);
		expect(result.status).toBe(202);
		expect(await result.json()).toMatchObject({ verification: "UNVERIFIED", marks: null });
	}
	expect(jobs).toHaveLength(0);
	expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM unverified_pr_submissions").first("n")).toBe(4);
	expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM matrix_runs").first("n")).toBe(0);
});
it("does not run a newly added but unapproved matrix row", async () => {
	const repositoryId = 1442222465;
	await env.DB.prepare("INSERT INTO matrix_repositories VALUES(?,?,?,?,?,?)")
		.bind(
			repositoryId,
			"Doom-Forge/janus",
			"a".repeat(40),
			"unreviewed-v1",
			"d".repeat(64),
			"registry.cloudflare.com/fixture/image@sha256:" + "2".repeat(64),
		)
		.run();
	const result = await acceptMatrixPR(
		payload(
			"b".repeat(40),
			"2026-11-04T10:00:00Z",
			repositoryId,
			"Doom-Forge/janus",
		),
		env,
		"unreviewed-janus",
		"unreviewed-janus-hash",
		undefined,
		{ publishCheck: async () => undefined },
	);
	expect(result.status).toBe(202);
	expect(await result.json()).toMatchObject({ verification: "UNVERIFIED", marks: null });
	expect(jobs).toHaveLength(0);
});
it("requests the default reviewer for a verified unconfigured PR without queuing evaluation", async () => {
	const previousReviewer = env.DEFAULT_PR_REVIEWER;
	env.DEFAULT_PR_REVIEWER = "Kevin272-dot";
	const p = payload(
		"b".repeat(40),
		"2026-11-04T10:00:00Z",
		1442222462,
		"Doom-Forge/mazhai-cover",
	);
	let reviewerRequests = 0;
	let clientRequests = 0;
	let reviewerTask: Promise<void> | undefined;
	const clientFactory = async (repository: {
		repository_id: number;
		full_name: string;
		installation_id: number;
	}) => {
		clientRequests++;
		expect(repository).toEqual({
			repository_id: 1442222462,
			full_name: "Doom-Forge/mazhai-cover",
			installation_id: 42,
		});
		return {
			api: async (path: string, init?: RequestInit) => {
				if (path.endsWith("/requested_reviewers") && init?.method === "POST") {
					reviewerRequests++;
					expect(JSON.parse(String(init.body))).toEqual({
						reviewers: ["Kevin272-dot"],
					});
					return {};
				}
				if (path.includes("/requested_reviewers")) return { users: [] };
				if (path.includes("/reviews?")) return [];
				return { state: "open", draft: false, user: { login: "participant" } };
			},
		} as unknown as Pick<GitHub, "api">;
	};
	const jobsBefore = jobs.length;
	try {
		for (const delivery of ["verified-reviewer-1", "verified-reviewer-2"]) {
			const response = await acceptMatrixPR(
				p,
				env,
				delivery,
				delivery,
				undefined,
				{
					clientFactory,
					publishCheck: async () => undefined,
					deferReviewer: (task) => {
						reviewerTask = task;
					},
				},
			);
			expect(response.status).toBe(202);
			expect(await response.json()).toMatchObject({ verification: "UNVERIFIED", marks: null });
			await reviewerTask;
			reviewerTask = undefined;
		}
		expect(clientRequests).toBe(2);
		expect(reviewerRequests).toBe(1);
		expect(
			await env.DB.prepare("SELECT COUNT(*) AS n FROM matrix_submissions")
				.first("n"),
		).toBe(0);
		expect(
			await env.DB.prepare("SELECT COUNT(*) AS n FROM matrix_runs").first("n"),
		).toBe(0);
		expect(jobs).toHaveLength(jobsBefore);
	} finally {
		env.DEFAULT_PR_REVIEWER = previousReviewer;
	}
});
it("rejects unconfigured PR identity mismatches before requesting a reviewer", async () => {
	const previousReviewer = env.DEFAULT_PR_REVIEWER;
	env.DEFAULT_PR_REVIEWER = "Kevin272-dot";
	let clientRequests = 0;
	const clientFactory = async () => {
		clientRequests++;
		return { api: async () => ({}) } as unknown as Pick<GitHub, "api">;
	};
	const valid = payload(
		"b".repeat(40),
		"2026-11-04T10:00:00Z",
		1442222462,
		"Doom-Forge/mazhai-cover",
	);
	const wrongId = payload(
		"b".repeat(40),
		"2026-11-04T10:00:00Z",
		1442222499,
		"Doom-Forge/mazhai-cover",
	);
	const wrongInstallation = { ...valid, installation: { id: 999 } };
	const wrongBase = {
		...valid,
		pull_request: {
			...valid.pull_request,
			base: { repo: { id: 1442222499 } },
		},
	};
	const jobsBefore = jobs.length;
	const reviewersBefore = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM matrix_default_reviewers",
	).first("n");
	try {
		for (const [event, delivery] of [
			[wrongId, "wrong-repository-id"],
			[wrongInstallation, "wrong-installation"],
			[wrongBase, "wrong-base-repository"],
		] as const) {
			const response = await acceptMatrixPR(
				event,
				env,
				delivery,
				delivery,
				undefined,
				{ clientFactory },
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "REPOSITORY_NOT_SELECTED" });
		}
		await env.DB.prepare(
			"UPDATE github_repositories SET accessible=0 WHERE id=?",
		)
			.bind(1442222462)
			.run();
		const inaccessible = await acceptMatrixPR(
			valid,
			env,
			"inaccessible-repository",
			"inaccessible-repository",
			undefined,
			{ clientFactory },
		);
		expect(inaccessible.status).toBe(403);
		expect(await inaccessible.json()).toEqual({
			error: "REPOSITORY_NOT_SELECTED",
		});
		expect(clientRequests).toBe(0);
		expect(
			await env.DB.prepare("SELECT COUNT(*) AS n FROM matrix_default_reviewers")
				.first("n"),
		).toBe(reviewersBefore);
		expect(jobs).toHaveLength(jobsBefore);
	} finally {
		await env.DB.prepare(
			"UPDATE github_repositories SET accessible=1 WHERE id=?",
		)
			.bind(1442222462)
			.run();
		env.DEFAULT_PR_REVIEWER = previousReviewer;
	}
});
it("keeps the two historical pilots read-only and rejects new PR intake", async () => {
	const response = await acceptMatrixPR(payload(), env, "pilot-intake", "pilot-hash");
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({ error: "MATRIX_REPOSITORY_NOT_AUTHORIZED" });
	expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM matrix_submissions").first("n")).toBe(0);
	expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM matrix_runs").first("n")).toBe(0);
	expect(jobs).toHaveLength(0);
});
it("deduplicates exact webhook delivery and retains the newest captured PR head", async () => {
	const pr = (sha: string, date: string) => payload(sha, date, 1442222462, "Doom-Forge/mazhai-cover");
	const first = await acceptMatrixPR(pr("a".repeat(40), "2026-11-04T10:00:00Z"), env, "head-one", "hash-one", undefined, { publishCheck: async () => undefined });
	expect(first.status).toBe(202);
	expect((await acceptMatrixPR(pr("a".repeat(40), "2026-11-04T10:00:00Z"), env, "head-one", "hash-one")).status).toBe(202);
	expect((await acceptMatrixPR(pr("c".repeat(40), "2026-11-04T09:00:00Z"), env, "stale-head", "hash-stale", undefined, { publishCheck: async () => undefined })).status).toBe(202);
	expect(await env.DB.prepare("SELECT head_sha FROM unverified_pr_submissions WHERE repository_id=1442222462 AND pr_number=4").first("head_sha")).toBe("a".repeat(40));
	expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM matrix_runs").first("n")).toBe(0);
});
it("denies retry and diagnostic execution without an approved profile", async () => {
	const legacyId = "e".repeat(64);
	await env.DB.prepare("INSERT INTO matrix_runs(id,repository_id,full_name,pr_number,head_sha,baseline_sha,matrix_version,matrix_digest,image_uri,state) VALUES(?,1442222461,'180DC-VIT-CHENNAI/noyyal-treasury',4,?,?,?,?,?,'COMPLETED')")
		.bind(legacyId, "b".repeat(40), "a".repeat(40), "pilot-v1", "c".repeat(64), "registry.cloudflare.com/fixture/image@sha256:" + "1".repeat(64)).run();
	const headers = { Authorization: `Bearer ${"x".repeat(40)}`, Origin: "https://test" };
	const retry = await matrixApi(new Request("https://test/api/matrix/runs/" + legacyId + "/retry", { method: "POST", headers }), env);
	expect(retry.status).toBe(403);
	expect(await retry.json()).toEqual({ error: "MATRIX_REPOSITORY_NOT_AUTHORIZED" });
	const diagnostic = await matrixApi(new Request("https://test/api/matrix/diagnostic", { method: "POST", headers, body: JSON.stringify({ repository: "noyyal-treasury", files: [] }) }), env);
	expect(diagnostic.status).toBe(403);
	const profileRunId = "f".repeat(64);
	await env.DB.prepare("INSERT INTO matrix_runs(id,repository_id,full_name,pr_number,head_sha,baseline_sha,matrix_version,matrix_digest,image_uri,state) VALUES(?,1442222465,'Doom-Forge/janus',4,?,?,?,?,?,'COMPLETED')")
		.bind(profileRunId, "b".repeat(40), "a".repeat(40), "unapproved-v1", "d".repeat(64), "registry.cloudflare.com/fixture/image@sha256:" + "2".repeat(64)).run();
	const unapprovedRetry = await matrixApi(new Request("https://test/api/matrix/runs/" + profileRunId + "/retry", { method: "POST", headers }), env);
	expect(unapprovedRetry.status).toBe(409);
	expect(await unapprovedRetry.json()).toEqual({ error: "MATRIX_PROFILE_NOT_APPROVED" });
	expect(jobs).toHaveLength(0);
});
