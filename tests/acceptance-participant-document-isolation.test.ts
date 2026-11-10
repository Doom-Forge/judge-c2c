import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import { participantDocuments } from "../src/round-two-documents";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";

const origin = "https://organization.test";
let mf: Miniflare, env: Env;

const session = (
	role: ConsoleSession["role"],
	teamId: string | null,
): ConsoleSession => ({
	hash: "session",
	role,
	identity_id: "identity",
	name: role,
	team_id: teamId,
});

function request(path = "") {
	return new Request(
		origin + "/api/organization/participant/documents" + path,
	);
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
		.prepare(
			"INSERT INTO teams(id,name) VALUES('team-a','Team A'),('team-b','Team B')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES('identity','Team A participant','participant','team-a',?),('other','Team B participant','participant','team-b',?)",
		)
		.bind("c".repeat(64), "d".repeat(64))
		.run();
	await db
		.prepare(
			"INSERT INTO team_documents(id,team_id,version,object_key,filename,content_type,bytes,sha256,status,uploaded_by_identity_id) VALUES('11111111-1111-4111-8111-111111111111','team-a',1,'analysis-documents/a','analysis.pdf','application/pdf',12,?,'STORED','identity'),('22222222-2222-4222-8222-222222222222','team-b',1,'analysis-documents/b','other.pdf','application/pdf',12,?,'STORED','other')",
		)
		.bind("a".repeat(64), "b".repeat(64))
		.run();
	env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("participant document access isolation", () => {
	it("lists metadata only for the authenticated team and denies other roles or unassigned identities", async () => {
		const own = await participantDocuments(
			request(),
			env,
			session("participant", "team-a"),
		);
		expect(own.status).toBe(200);
		expect(await own.json()).toMatchObject({
			documents: [
				{
					id: "11111111-1111-4111-8111-111111111111",
					filename: "analysis.pdf",
				},
			],
		});

		const otherTeam = await participantDocuments(
			request(),
			env,
			session("participant", "team-b"),
		);
		expect(otherTeam.status).toBe(200);
		expect(await otherTeam.json()).toMatchObject({
			documents: [
				{
					id: "22222222-2222-4222-8222-222222222222",
					filename: "other.pdf",
				},
			],
		});

		for (
			const unauthorized of [
				session("judge", null),
				session("organizer", null),
				session("participant", null),
			]
		) {
			expect(
				(await participantDocuments(request(), env, unauthorized))
					.status,
			).toBe(403);
		}
	});

	it("does not disclose document metadata or bytes across teams", async () => {
		const crossTeam = await participantDocuments(
			request("/11111111-1111-4111-8111-111111111111"),
			env,
			session("participant", "team-b"),
		);
		expect(crossTeam.status).toBe(404);
	});
});
