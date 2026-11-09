import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { organization, seal } from "../src/organization";
import { migrate } from "./database";
import type { Env } from "../src/env";
let mf: Miniflare, env: Env;
const jobs: string[] = [];
const secret = "synthetic-matrix-webhook-" + "s".repeat(40);
const ctx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;
beforeAll(async () => {
	mf = new Miniflare({
		modules: true,
		script: "export default{}",
		d1Databases: ["DB"],
		compatibilityDate: "2026-08-01",
	});
	const db = (await mf.getD1Database("DB")) as unknown as D1Database;
	await migrate(db);
	env = {
		DB: db,
		ORG_DB: db,
		MATRIX_MODE: "true",
		ORG_ADMIN_TOKEN: "synthetic-organizer-" + "x".repeat(40),
		ORG_NAME: "180DC-VIT-CHENNAI",
		ORG_VAULT_KEY: "a".repeat(64),
		ORG_PUBLIC_ORIGIN: "https://matrix.test",
		MATRIX_EVALUATOR: {
			create: async ({ id }: { id: string }) => {
				jobs.push(id);
				return { id };
			},
		},
	} as unknown as Env;
	const encrypted = await seal(env, {
		id: 7,
		slug: "synthetic",
		key: "not-a-real-key",
		webhookSecret: secret,
	});
	await db
		.prepare("INSERT INTO github_connection VALUES(1,7,?,?,42)")
		.bind("synthetic", encrypted)
		.run();
	await db
		.prepare(
			"INSERT INTO github_repositories VALUES(1442222461,'180DC-VIT-CHENNAI/noyyal-treasury',0,'main',1)",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO matrix_repositories VALUES(1442222461,'180DC-VIT-CHENNAI/noyyal-treasury',?,'pilot-v1',?,?)",
		)
		.bind(
			"a".repeat(40),
			"c".repeat(64),
			"registry.cloudflare.com/test/image@sha256:" + "1".repeat(64),
		)
		.run();
	await db
		.prepare("INSERT INTO github_repositories VALUES(1442222462,'180DC-VIT-CHENNAI/mazhai-cover',0,'main',1)")
		.run();
}, 30000);
afterAll(async () => mf.dispose());
async function request(
	valid = true,
	event = "pull_request",
	repository = { id: 1442222462, full_name: "180DC-VIT-CHENNAI/mazhai-cover" },
) {
	const body = JSON.stringify({
		action: "opened",
		installation: { id: 42 },
		repository,
		pull_request: {
			number: 12,
			user: { id: 9001, login: "member-one" },
			head: { sha: "b".repeat(40) },
			base: { repo: { id: repository.id } },
			updated_at: "2026-11-04T10:00:00Z",
			state: "open",
		},
	});
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = Buffer.from(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
	).toString("hex");
	return new Request("https://matrix.test/webhooks/organization", {
		method: "POST",
		body,
		headers: {
			"x-github-event": event,
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": "sha256=" +
				(valid ? signature : "0".repeat(64)),
		},
	});
}
it("rejects an invalid signature before any matrix job is queued", async () => {
	expect((await organization(await request(false), env, ctx)).status).toBe(
		401,
	);
	expect(jobs).toHaveLength(0);
});
it("accepts signed four-repository PRs as unverified evidence without running a matrix", async () => {
	expect((await organization(await request(), env, ctx)).status).toBe(202);
	expect(jobs).toHaveLength(0);
	expect(
		await env.DB.prepare("SELECT count(*) AS n FROM unverified_pr_submissions").first(
			"n",
		),
	).toBe(1);
	expect(await env.DB.prepare("SELECT count(*) AS n FROM matrix_runs").first("n")).toBe(0);
	const oldPilot = await organization(await request(true, "pull_request", {
		id: 1442222461,
		full_name: "180DC-VIT-CHENNAI/noyyal-treasury",
	}), env, ctx);
	expect(oldPilot.status).toBe(403);
	expect(await oldPilot.json()).toEqual({ error: "MATRIX_REPOSITORY_NOT_AUTHORIZED" });
	expect(jobs).toHaveLength(0);
	expect(await env.DB.prepare("SELECT count(*) AS n FROM assignments").first("n")).toBe(0);
});
it("ignores issue events instead of dispatching the legacy evaluation system", async () => {
	const before = jobs.length;
	expect(
		(await organization(await request(true, "issues"), env, ctx)).status,
	).toBe(202);
	expect(jobs).toHaveLength(before);
});
