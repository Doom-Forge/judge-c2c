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
			.bind(1442222462 + index, `180DC-VIT-CHENNAI/${name}`, 0, "main")
			.run();
	}
	await db.prepare("CREATE TABLE teams(id TEXT PRIMARY KEY,status TEXT)")
		.run();
	await db
		.prepare(
			"CREATE TABLE team_members(team_id TEXT,github_id INTEGER,github_login TEXT,active INTEGER,hackathon_id TEXT)",
		)
		.run();
	await db
		.prepare(
			"CREATE TABLE team_repositories(team_id TEXT,repository_id INTEGER,active INTEGER)",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO teams VALUES('team-one','ACTIVE'),('team-two','ACTIVE')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO team_members VALUES('team-one',9001,'member-one',1,'initial'),('team-two',9002,'member-two',1,'initial')",
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
it("shows the four new repos as specification-required and refuses their PRs", async () => {
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
		const fullName = `180DC-VIT-CHENNAI/${name}`;
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
		);
		expect(result.status).toBe(403);
	}
	expect(jobs).toHaveLength(0);
});
it("keeps a specification-required repo blocked even if a matrix row exists", async () => {
	const repositoryId = 1442222465;
	await env.DB.prepare("INSERT INTO matrix_repositories VALUES(?,?,?,?,?,?)")
		.bind(
			repositoryId,
			"180DC-VIT-CHENNAI/janus",
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
			"180DC-VIT-CHENNAI/janus",
		),
		env,
		"unreviewed-janus",
		"unreviewed-janus-hash",
	);
	expect(result.status).toBe(403);
	expect(await result.json()).toEqual({
		error: "CHALLENGE_SPECIFICATION_REQUIRED",
	});
	expect(jobs).toHaveLength(0);
});
it("requests the default reviewer for a verified unconfigured PR without queuing evaluation", async () => {
	const previousReviewer = env.DEFAULT_PR_REVIEWER;
	env.DEFAULT_PR_REVIEWER = "Kevin272-dot";
	const p = payload(
		"b".repeat(40),
		"2026-11-04T10:00:00Z",
		1442222462,
		"180DC-VIT-CHENNAI/mazhai-cover",
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
			full_name: "180DC-VIT-CHENNAI/mazhai-cover",
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
					deferReviewer: (task) => {
						reviewerTask = task;
					},
				},
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: "CHALLENGE_SPECIFICATION_REQUIRED",
			});
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
		"180DC-VIT-CHENNAI/mazhai-cover",
	);
	const wrongId = payload(
		"b".repeat(40),
		"2026-11-04T10:00:00Z",
		1442222499,
		"180DC-VIT-CHENNAI/mazhai-cover",
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
it("queues once, rejects conflicting replay, and supersedes on new head", async () => {
	const first = await acceptMatrixPR(payload(), env, "delivery-1", "hash-1");
	expect(first.status).toBe(202);
	const { id } = (await first.json()) as { id: string };
	expect(jobs).toContain(id);
	expect(
		(await acceptMatrixPR(payload(), env, "delivery-1", "hash-1")).status,
	).toBe(200);
	expect(
		(await acceptMatrixPR(payload(), env, "delivery-1", "different"))
			.status,
	).toBe(409);
	await acceptMatrixPR(
		payload("d".repeat(40), "2026-11-04T11:00:00Z"),
		env,
		"delivery-2",
		"hash-2",
	);
	expect(
		await env.DB.prepare("SELECT state FROM matrix_runs WHERE id=?")
			.bind(id)
			.first("state"),
	).toBe("SUPERSEDED");
	const before = jobs.length;
	await acceptMatrixPR(
		payload("b".repeat(40), "2026-11-04T09:00:00Z"),
		env,
		"delivery-3",
		"hash-3",
	);
	expect(jobs).toHaveLength(before);
});
it("attributes the pull request to its verified GitHub member team", async () => {
	const p = payload();
	p.pull_request.number = 50;
	const response = await acceptMatrixPR(
		p,
		env,
		"team-attribution",
		"team-attribution",
	);
	expect(response.status).toBe(202);
	expect(
		await env.DB.prepare(
			"SELECT team_id,author_id,author_login,mapping_status FROM matrix_submissions WHERE repository_id=? AND pr_number=50",
		)
			.bind(1442222461)
			.first(),
	).toEqual({
		team_id: "team-one",
		author_id: 9001,
		author_login: "member-one",
		mapping_status: "MAPPED",
	});
});
it("rejects unselected repositories or the wrong installation", async () => {
	expect(
		(
			await acceptMatrixPR(
				{ ...payload(), installation: { id: 999 } },
				env,
				"delivery-4",
				"hash",
			)
		).status,
	).toBe(403);
});
it("advances same-head timestamps to reject delayed different heads", async () => {
	await acceptMatrixPR(
		payload("e".repeat(40), "2026-11-04T12:00:00Z"),
		env,
		"order-1",
		"o1",
	);
	await acceptMatrixPR(
		payload("e".repeat(40), "2026-11-04T14:00:00Z"),
		env,
		"order-2",
		"o2",
	);
	await acceptMatrixPR(
		payload("f".repeat(40), "2026-11-04T13:00:00Z"),
		env,
		"order-3",
		"o3",
	);
	expect(
		await env.DB.prepare(
			"SELECT head_sha FROM matrix_submissions WHERE pr_number=4",
		).first("head_sha"),
	).toBe("e".repeat(40));
});
it("retains a close-first tombstone against delayed opening events", async () => {
	const p = payload();
	p.pull_request.number = 8;
	p.action = "closed";
	p.pull_request.state = "closed";
	await acceptMatrixPR(p, env, "close-first", "closed");
	p.action = "opened";
	p.pull_request.state = "open";
	p.pull_request.updated_at = "2026-11-04T09:00:00Z";
	const before = jobs.length;
	await acceptMatrixPR(p, env, "open-late", "opened");
	expect(jobs).toHaveLength(before);
});
it("resolves conflicting timestamp ties against the actual GitHub head", async () => {
	const date = "2026-11-04T16:00:00Z";
	await acceptMatrixPR(payload("1".repeat(40), date), env, "tie-first", "t1");
	const live = async () => ({
		head: { sha: "2".repeat(40) },
		state: "open" as const,
		updated_at: date,
		user: { id: 9001, login: "member-one" },
	});
	await acceptMatrixPR(
		payload("2".repeat(40), date),
		env,
		"tie-newer",
		"t2",
		live,
	);
	await acceptMatrixPR(
		payload("1".repeat(40), date),
		env,
		"tie-delayed",
		"t3",
		live,
	);
	expect(
		await env.DB.prepare(
			"SELECT head_sha FROM matrix_submissions WHERE pr_number=4",
		).first("head_sha"),
	).toBe("2".repeat(40));
});
it("recovers a persisted queued dispatch after workflow creation fails", async () => {
	const previous = env.MATRIX_EVALUATOR;
	env.MATRIX_EVALUATOR = {
		create: async () => {
			throw new Error("temporary outage");
		},
		get: async () => ({
			status: async () => {
				throw new Error("not found");
			},
		}),
	} as unknown as Env["MATRIX_EVALUATOR"];
	const p = payload("3".repeat(40), "2026-11-04T17:00:00Z");
	p.pull_request.number = 10;
	await expect(
		acceptMatrixPR(p, env, "recoverable", "recover"),
	).rejects.toThrow("temporary outage");
	expect(
		await env.DB.prepare(
			"SELECT state FROM matrix_runs WHERE pr_number=10",
		).first("state"),
	).toBe("QUEUED");
	env.MATRIX_EVALUATOR = previous;
	expect((await acceptMatrixPR(p, env, "recoverable", "recover")).status)
		.toBe(
			200,
		);
	const id = await env.DB.prepare(
		"SELECT latest_run_id FROM matrix_submissions WHERE pr_number=10",
	).first<string>("latest_run_id");
	expect(jobs).toContain(id);
});
it("keeps fresh and retried runs unavailable to legacy score publication", async () => {
	const p = payload("4".repeat(40), "2026-11-04T18:00:00Z");
	p.pull_request.number = 11;
	const response = await acceptMatrixPR(p, env, "notice-only", "notice");
	const { id } = (await response.json()) as { id: string };
	expect(
		await env.DB.prepare(
			"SELECT publication_status FROM matrix_runs WHERE id=?",
		)
			.bind(id)
			.first("publication_status"),
	).toBe("NOTICE_ONLY");
	await env.DB.prepare("UPDATE matrix_runs SET state='COMPLETED' WHERE id=?")
		.bind(id)
		.run();
	const retry = await matrixApi(
		new Request(`https://test/api/matrix/runs/${id}/retry`, {
			method: "POST",
			headers: { authorization: "Bearer " + env.ADMIN_TOKEN },
		}),
		env,
	);
	expect(retry.status).toBe(202);
	const next = (await retry.json()) as { id: string };
	expect(
		await env.DB.prepare(
			"SELECT publication_status FROM matrix_runs WHERE id=?",
		)
			.bind(next.id)
			.first("publication_status"),
	).toBe("NOTICE_ONLY");
});
it("accepts ready_for_review without regrading an unchanged head", async () => {
	const p = payload("5".repeat(40), "2026-11-04T19:00:00Z");
	p.pull_request.number = 12;
	const first = await acceptMatrixPR(
		p,
		env,
		"draft-created",
		"draft-created",
	);
	const { id } = (await first.json()) as { id: string };
	await env.DB.prepare("UPDATE matrix_runs SET state='COMPLETED' WHERE id=?")
		.bind(id)
		.run();
	const count = jobs.length;
	p.action = "ready_for_review";
	p.pull_request.updated_at = "2026-11-04T20:00:00Z";
	const ready = await acceptMatrixPR(p, env, "draft-ready", "draft-ready");
	expect(ready.status).toBe(200);
	expect(jobs.length).toBe(count);
	expect(
		await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM matrix_runs WHERE pr_number=12",
		).first("n"),
	).toBe(1);
});
it("protects application budget accounting with bearer authentication", async () => {
	const denied = await matrixApi(
		new Request("https://matrix.test/api/matrix/budget"),
		env,
	);
	expect(denied.status).toBe(401);
	const response = await matrixApi(
		new Request("https://matrix.test/api/matrix/budget", {
			headers: { authorization: "Bearer " + env.ADMIN_TOKEN },
		}),
		env,
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		startLimit: 80,
		startsRemaining: 80,
		secondsPerStart: 180,
		globalConcurrencyLimit: 4,
		accounting: "application_reservations_not_cloudflare_bill",
	});
});
