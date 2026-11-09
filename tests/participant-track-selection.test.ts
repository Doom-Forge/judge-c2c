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
			.bind(id, "180DC-VIT-CHENNAI/" + name)
			.run();
	}
	await db
		.prepare(
			"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',14,'organizer:test')",
		)
		.run();
	env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("participant repository track selection", () => {
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
			dashboardResult.track,
			JSON.parse(audit ?? "{}"),
		]).toEqual([
			200,
			{
				repositoryId: 11,
				fullName: "180DC-VIT-CHENNAI/pricingpulse",
			},
			[{ repository_id: 11 }],
			{
				repositoryId: 11,
				fullName: "180DC-VIT-CHENNAI/pricingpulse",
			},
			{
				eventId: expect.any(String),
				previousRepositoryIds: [14],
				repositoryId: 11,
				fullName: "180DC-VIT-CHENNAI/pricingpulse",
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
