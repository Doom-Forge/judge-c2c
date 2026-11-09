import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import { organization } from "../src/organization";
import { roundTwoAnnouncements } from "../src/round-two-announcements";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";

const origin = "https://organization.test";
let mf: Miniflare;
let env: Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

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
	const db = (await mf.getD1Database("ORG_DB")) as unknown as D1Database;
	await migrate(db);
	await db.prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A')").run();
	env = {
		ORG_DB: db,
		ORG_ADMIN_TOKEN: "admin-token-" + "a".repeat(40),
		ORG_JUDGE_TOKEN: "judge-token-" + "b".repeat(40),
		ORG_VAULT_KEY: "12".repeat(32),
		ORG_NAME: "Doomforge",
		ORG_PUBLIC_ORIGIN: origin,
	} as unknown as Env;
});

afterEach(async () => mf.dispose());

async function login(token: string) {
	const response = await organization(
		request("/api/organization/login", "POST", { token }),
		env,
		ctx,
	);
	return response.headers.get("set-cookie")!.split(";")[0]!;
}

describe("participant announcements", () => {
	it("lets organizers publish audited, immutable announcements for participants", async () => {
		const organizerCookie = await login(env.ORG_ADMIN_TOKEN!);
		const created = await organization(
			request(
				"/api/organization/announcements",
				"POST",
				{ title: "Document deadline", body: "Upload your analysis by Friday." },
				organizerCookie,
			),
			env,
			ctx,
		);
		const body = await created.json() as {
			announcement: { id: string; title: string; body: string };
		};
		expect(created.status).toBe(201);
		expect(body.announcement).toMatchObject({
			title: "Document deadline",
			body: "Upload your analysis by Friday.",
		});

		const participant: ConsoleSession = {
			hash: "participant-session",
			role: "participant",
			identity_id: "participant-id",
			name: "Team A",
			team_id: "team-a",
		};
		const feed = await roundTwoAnnouncements(
			request("/api/organization/announcements"),
			env,
			participant,
		);
		expect(await feed.json()).toMatchObject({
			announcements: [
				{ id: body.announcement.id, title: "Document deadline", body: "Upload your analysis by Friday." },
			],
		});
		const audit = await env.ORG_DB!.prepare(
			"SELECT action,actor FROM audit WHERE entity=?",
		).bind(body.announcement.id).first();
		expect(audit).toMatchObject({
			action: "round_two.announcement.created",
			actor: expect.stringMatching(/^organizer:/),
		});
		await expect(
			env.ORG_DB!.prepare("DELETE FROM round_two_announcements WHERE id=?")
				.bind(body.announcement.id).run(),
		).rejects.toThrow();
	});

	it("rejects judge authoring, participant authoring, and malformed messages", async () => {
		const judgeCookie = await login(env.ORG_JUDGE_TOKEN!);
		const judgeWrite = await organization(
			request("/api/organization/announcements", "POST", { title: "Hi", body: "No." }, judgeCookie),
			env,
			ctx,
		);
		expect(judgeWrite.status).toBe(403);

		const participant: ConsoleSession = {
			hash: "participant-session",
			role: "participant",
			identity_id: "participant-id",
			name: "Team A",
			team_id: "team-a",
		};
		const participantWrite = await roundTwoAnnouncements(
			request("/api/organization/announcements", "POST", { title: "Hi", body: "No." }),
			env,
			participant,
		);
		expect(participantWrite.status).toBe(403);

		const organizerCookie = await login(env.ORG_ADMIN_TOKEN!);
		const invalid = await organization(
			request("/api/organization/announcements", "POST", { title: "", body: "" }, organizerCookie),
			env,
			ctx,
		);
		expect(invalid.status).toBe(400);
	});
});
