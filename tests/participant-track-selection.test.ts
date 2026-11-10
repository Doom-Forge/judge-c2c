import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";
import { participantConsole } from "../src/console-identities";

const participant: ConsoleSession = {
	hash: "participant-session",
	role: "participant",
	identity_id: "participant-identity",
	name: "Team A",
	team_id: "team-a",
};
let mf: Miniflare, env: Env;

function request(path = "", method = "GET", data?: unknown) {
	return new Request(
		"https://organization.test/api/organization/participant" + path,
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
		.prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A')")
		.run();
	await db.prepare("UPDATE teams SET hackathon_id='initial',status='ACTIVE',lead_email='lead@example.test' WHERE id='team-a'").run();
	await db.prepare("INSERT INTO team_roster_members(id,team_id,hackathon_id,display_name,email) VALUES('lead-roster','team-a','initial','Team Lead','lead@example.test')").run();
	await db.prepare("INSERT INTO console_identities(id,name,role,team_id,team_roster_member_id,credential_hash) VALUES('participant-identity','Team A','participant','team-a','lead-roster',?)").bind("b".repeat(64)).run();
	for (
		const [id, name] of [
			[10, "mazhai-cover"],
			[11, "pricingpulse"],
			[12, "veera-footwear"],
			[13, "janus"],
			[14, "noyyal-treasury"],
		] as const
	) {
		await db
			.prepare(
				"INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(?,? ,0,'main')",
			)
			.bind(id, (name === "noyyal-treasury" ? "180DC-VIT-CHENNAI/" : "Doom-Forge/") + name)
			.run();
	}
	await db.prepare("INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',14,'organizer:test')").run();
	env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("participant repository track selection", () => {
	async function seedCurrentAndHistoricalSubmissions() {
		const db = env.ORG_DB!;
		await db.prepare(
			"INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(15,'180DC-VIT-CHENNAI/pricingpulse',0,'main',0)",
		).run();
		await db.prepare(
			"UPDATE team_repositories SET active=0 WHERE team_id='team-a' AND active=1",
		).run();
		await db.prepare(
			"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',11,'participant:test')",
		).run();
		await db.prepare(
			"UPDATE teams SET track_finalized=1 WHERE id='team-a'",
		).run();
		await db.prepare(
			"UPDATE console_identities SET github_verified_at=CURRENT_TIMESTAMP WHERE id='participant-identity'",
		).run();
		await db.prepare(
			"INSERT INTO repositories(id,full_name,installation_id,active_contract_hash) VALUES(11,'Doom-Forge/pricingpulse',1,'contract-current'),(15,'180DC-VIT-CHENNAI/pricingpulse',1,'contract-archived')",
		).run();
		await db.prepare(
			"INSERT INTO contracts(hash,repository_id,document) VALUES('contract-current',11,'{}'),('contract-archived',15,'{}')",
		).run();
		await db.prepare(
			"INSERT INTO submissions(repository_id,pr_number,head_sha,latest_run_id,github_updated_at,team_id,status) VALUES(11,42,?,'current-run','2026-11-10T10:00:00Z','team-a','VALID'),(15,7,?,'archived-run','2026-11-10T09:00:00Z','team-a','VALID')",
		).bind("a".repeat(40), "b".repeat(40)).run();
	}

	it("filters participant PR history to the active accessible track in matrix mode", async () => {
		await seedCurrentAndHistoricalSubmissions();
		env.MATRIX_MODE = "true";
		const response = await participantConsole(request(), env, participant);
		const result = await response.json() as {
			track: { repositoryId: number; fullName: string };
			submissions: { repository_id: number; pr_number: number; full_name: string }[];
		};

		expect(result.track).toEqual({
			repositoryId: 11,
			fullName: "Doom-Forge/pricingpulse",
		});
		expect(result.submissions.map(({ repository_id, pr_number, full_name }) => [repository_id, pr_number, full_name])).toEqual([
			[11, 42, "Doom-Forge/pricingpulse"],
		]);
	});

	it("preserves cross-repository submissions in legacy mode", async () => {
		await seedCurrentAndHistoricalSubmissions();
		env.MATRIX_MODE = "false";
		const response = await participantConsole(request(), env, participant);
		const result = await response.json() as {
			submissions: { repository_id: number; pr_number: number; full_name: string }[];
		};

		expect(result.submissions.map(({ repository_id, pr_number, full_name }) => [repository_id, pr_number, full_name])).toEqual([
			[11, 42, "Doom-Forge/pricingpulse"],
			[15, 7, "180DC-VIT-CHENNAI/pricingpulse"],
		]);
	});

	it("replaces the old track with exactly one allowed repository", async () => {
		const response = await participantConsole(
				request("/track", "POST", { repositoryId: 11 }),
				env,
				participant,
			),
			result = (await response.json()) as {
				track: { repositoryId: number; fullName: string };
			},
			active = await env.ORG_DB!.prepare(
				"SELECT repository_id FROM team_repositories WHERE team_id='team-a' AND active=1",
			).all<{ repository_id: number }>(),
			dashboard = await participantConsole(
				request(),
				env,
				participant,
			),
			dashboardResult = (await dashboard.json()) as {
				track: { repositoryId: number; fullName: string };
			},
			audit = await env.ORG_DB!.prepare(
				"SELECT changes FROM audit WHERE action='team.track_selected'",
			).first<string>("changes");

		expect([
			response.status,
			result.track,
			active.results,
				dashboard.status,
				dashboardResult,
			JSON.parse(audit ?? "{}"),
		]).toEqual([
			200,
			{
				repositoryId: 11,
				fullName: "Doom-Forge/pricingpulse",
			},
			[{ repository_id: 11 }],
			428,
			{ error: "PARTICIPANT_ONBOARDING_REQUIRED" },
			{
				eventId: expect.any(String),
				previousRepositoryIds: [14],
				repositoryId: 11,
				fullName: "Doom-Forge/pricingpulse",
			},
		]);
	});

	it("rejects repositories outside the four competition tracks", async () => {
		const response = await participantConsole(
				request("/track", "POST", { repositoryId: 14 }),
				env,
				participant,
			),
			result = await response.json(),
			active = await env.ORG_DB!.prepare(
				"SELECT repository_id FROM team_repositories WHERE team_id='team-a' AND active=1",
			).all<{ repository_id: number }>();

		expect([response.status, result, active.results]).toEqual([
			403,
			{ error: "TRACK_NOT_ALLOWED" },
			[{ repository_id: 14 }],
		]);
	});
});
