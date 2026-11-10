import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate, migrationFiles } from "./database";
import { acceptMatrixPR } from "../src/matrix-service";
import { activeOrganization, competitionRepositoriesFor } from "../src/organization-selection";
import { organization, seal } from "../src/organization";
import type { Env } from "../src/env";

let mf: Miniflare;
let env: Env;
let db: D1Database;

const forgeSecret = "inactive-forge-webhook-secret-" + "f".repeat(32);
const vitcSecret = "active-vitc-webhook-secret-" + "v".repeat(32);
const origin = "https://dual-organization.test";
const ctx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

async function signedWebhook(secret: string, body: string) {
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
	return new Request(origin + "/webhooks/organization", {
		method: "POST",
		body,
		headers: {
			origin,
			"x-github-event": "pull_request",
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": `sha256=${signature}`,
		},
	});
}

beforeAll(async () => {
	mf = new Miniflare({
		modules: true,
		script: "export default{}",
		d1Databases: ["DB", "ORG_DB"],
		compatibilityDate: "2026-08-01",
	});
	db = (await mf.getD1Database("ORG_DB")) as unknown as D1Database;
	await migrate(db, [...migrationFiles, "0050_dual_organization_apps.sql"]);
	env = {
		DB: db,
		ORG_DB: db,
		MATRIX_MODE: "true",
		USE_DOOMFORGE_ORG: "false",
		USE_180DC_ORG: "true",
		ORG_NAME: "Doom-Forge",
		ORG_ADMIN_TOKEN: "organizer-test-token-" + "o".repeat(32),
		ORG_VAULT_KEY: "ab".repeat(32),
		ORG_VAULT_AAD: "judge-c2c:180DC-VIT-CHENNAI",
		ORG_PUBLIC_ORIGIN: origin,
	} as unknown as Env;

	const forgeApp = await seal(env, {
		id: 901,
		slug: "doombot-forge",
		key: "synthetic-forge-private-key",
		webhookSecret: forgeSecret,
	});
	const vitcApp = await seal(env, {
		id: 902,
		slug: "doombot-180dc-judging",
		key: "synthetic-vitc-private-key",
		webhookSecret: vitcSecret,
	});
	await db.batch([
		db.prepare("INSERT INTO github_connections(organization,app_id,slug,encrypted,installation_id,suspended) VALUES(?,?,?,?,?,0)")
			.bind("Doom-Forge", 901, "doombot-forge", forgeApp, 7001),
		db.prepare("INSERT INTO github_connections(organization,app_id,slug,encrypted,installation_id,suspended) VALUES(?,?,?,?,?,0)")
			.bind("180DC-VIT-CHENNAI", 902, "doombot-180dc-judging", vitcApp, 7002),
		db.prepare("INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(?,?,?,?,1)")
			.bind(88001, "Doom-Forge/mazhai-cover", 0, "main"),
		db.prepare("INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(?,?,?,?,1)")
			.bind(88002, "180DC-VIT-CHENNAI/mazhai-cover", 0, "main"),
	]);
}, 30000);

afterAll(async () => mf.dispose());

it("uses the 180DC repo set and ignores the inactive Doom-Forge app and PRs", async () => {
	expect(activeOrganization(env)).toBe("180DC-VIT-CHENNAI");
	expect(competitionRepositoriesFor(env)).toEqual([
		"180DC-VIT-CHENNAI/mazhai-cover",
		"180DC-VIT-CHENNAI/pricingpulse",
		"180DC-VIT-CHENNAI/veera-footwear",
		"180DC-VIT-CHENNAI/janus",
	]);

	const inactiveWebhook = await organization(
		await signedWebhook(forgeSecret, JSON.stringify({ action: "opened" })),
		env,
		ctx,
	);
	expect(inactiveWebhook.status).toBe(202);
	expect(await inactiveWebhook.json()).toEqual({
		status: "inactive_organization_ignored",
	});

	const pullRequest = {
		action: "opened",
		installation: { id: 7001 },
		repository: { id: 88001, full_name: "Doom-Forge/mazhai-cover" },
		pull_request: {
			number: 8,
			user: { id: 8001, login: "participant" },
			head: { sha: "a".repeat(40) },
			base: { repo: { id: 88001 } },
			updated_at: "2026-11-10T10:00:00.000Z",
			state: "open",
		},
	};
	const rejectedPR = await acceptMatrixPR(
		pullRequest,
		env,
		"inactive-forge-pr",
		"b".repeat(64),
		undefined,
		{ publishCheck: async () => {} },
	);
	expect(rejectedPR.status).toBe(403);
	expect(await rejectedPR.json()).toEqual({
		error: "MATRIX_REPOSITORY_NOT_AUTHORIZED",
	});

	const acceptedPR = await acceptMatrixPR(
		{
			...pullRequest,
			installation: { id: 7002 },
			repository: {
				id: 88002,
				full_name: "180DC-VIT-CHENNAI/mazhai-cover",
			},
			pull_request: {
				...pullRequest.pull_request,
				base: { repo: { id: 88002 } },
			},
		},
		env,
		"active-vitc-pr",
		"c".repeat(64),
		undefined,
		{ publishCheck: async () => {} },
	);
	expect(acceptedPR.status).toBe(202);
	expect(await acceptedPR.json()).toEqual({
		status: "accepted",
		verification: "UNVERIFIED",
		marks: null,
	});
	expect(
		await db
			.prepare("SELECT g.id AS repository_id,g.full_name FROM github_repositories g JOIN unverified_pr_submissions s ON s.repository_id=g.id WHERE s.pr_number=8")
			.first(),
	).toEqual({ repository_id: 88002, full_name: "180DC-VIT-CHENNAI/mazhai-cover" });

	const invalidSelection = {
		...env,
		USE_DOOMFORGE_ORG: "true",
		USE_180DC_ORG: "true",
	} as Env;
	expect(() => activeOrganization(invalidSelection)).toThrow(
		"ORGANIZATION_SELECTION_INVALID",
	);
});
