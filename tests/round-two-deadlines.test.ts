import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import type { ConsoleSession } from "../src/console-identities";
import type { Env } from "../src/env";
import { participantDocuments } from "../src/round-two-documents";
import { roundTwoReview } from "../src/round-two-review";
import { competition } from "../src/competition";
import type { CompetitionServices } from "../src/competition-store";

let mf: Miniflare, env: Env;
const origin = "https://organization.test",
	organizer: ConsoleSession = {
		hash: "organizer-session",
		role: "organizer",
		identity_id: "organizer-identity",
		name: "Organizer",
		team_id: null,
	},
	participant: ConsoleSession = {
		hash: "participant-session",
		role: "participant",
		identity_id: "participant-identity",
		name: "Team A",
		team_id: "team-a",
	},
	services = {
		client: async () => ({}),
		evaluationEnv: async () => env,
		installationId: async () => 1,
		appSlug: async () => "test",
	} as unknown as CompetitionServices,
	ctx = { waitUntil() {} } as unknown as ExecutionContext;

function request(path: string, method = "GET", data?: unknown) {
	return new Request(origin + path, {
		method,
		headers: { "content-type": "application/json" },
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
	});
}

function upload() {
	const form = new FormData();
	form.set(
		"file",
		new File(
			[new TextEncoder().encode("%PDF-1.7\nanalysis")],
			"analysis.pdf",
		),
	);
	return new Request(origin + "/api/organization/participant/documents", {
		method: "POST",
		body: form,
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
	await db.prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A')")
		.run();
	await db.prepare(
		"INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES('participant-identity','Team A lead','participant','team-a',?)",
	).bind("a".repeat(64)).run();
	env = {
		ORG_DB: db,
		ARTIFACTS: {
			async put() {},
			async get() {
				return null;
			},
			async delete() {},
		},
	} as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("organizer-managed deadlines", () => {
	it("updates both UTC deadlines with organizer-only access and an audit record", async () => {
		const url = origin + "/api/organization/manage/deadlines",
			denied = await competition(
				request("/api/organization/manage/deadlines", "PUT", {
					analysisDocumentDeadline: "2030-01-01T00:00:00Z",
					pullRequestDeadline: null,
				}),
				env,
				ctx,
				services,
				"participant:participant-identity",
			);
		expect(denied.status).toBe(403);

		const response = await competition(
			request("/api/organization/manage/deadlines", "PUT", {
				analysisDocumentDeadline: "2030-01-01T00:00:00Z",
				pullRequestDeadline: "2030-01-02T00:00:00Z",
			}),
			env,
			ctx,
			services,
			"organizer:organizer-identity",
		);
		const read = await competition(
			request("/api/organization/manage/deadlines", "GET"),
			env,
			ctx,
			services,
			"judge:judge-a",
		);
		expect(response.status).toBe(200);
		expect(await read.json()).toEqual({
			analysisDocumentDeadline: "2030-01-01T00:00:00Z",
			pullRequestDeadline: "2030-01-02T00:00:00Z",
		});
		expect(
			await env.ORG_DB!.prepare(
				"SELECT count(*) AS count FROM audit WHERE action='hackathon.deadlines.updated'",
			).first(),
		).toMatchObject({ count: 1 });
	});

	it("rejects malformed timestamps and does not expose settings to participants", async () => {
		const invalid = await competition(
			request("/api/organization/manage/deadlines", "PUT", {
				analysisDocumentDeadline: "tomorrow",
				pullRequestDeadline: null,
			}),
			env,
			ctx,
			services,
			"organizer:organizer-identity",
		);
		expect(invalid.status).toBe(400);
		const impossibleDate = await competition(
			request("/api/organization/manage/deadlines", "PUT", {
				analysisDocumentDeadline: "2030-02-31T00:00:00Z",
				pullRequestDeadline: null,
			}),
			env,
			ctx,
			services,
			"organizer:organizer-identity",
		);
		expect(impossibleDate.status).toBe(400);
		await env.ORG_DB!.prepare(
			"UPDATE hackathons SET analysis_document_deadline=?,pull_request_deadline=? WHERE id='initial'",
		).bind("2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z").run();
		const response = await participantDocuments(
			request("/api/organization/participant/documents"),
			env,
			participant,
		);
		expect(await response.json()).toMatchObject({
			deadlines: {
				analysisDocumentDeadline: "2030-01-01T00:00:00Z",
				pullRequestDeadline: "2030-01-02T00:00:00Z",
			},
		});
	});

	it("reserves only the first document version after the deadline", async () => {
		await env.ORG_DB!.prepare(
			"UPDATE hackathons SET analysis_document_deadline='2000-01-01T00:00:00Z' WHERE id='initial'",
		).run();
		const responses = await Promise.all([
			participantDocuments(upload(), env, participant),
			participantDocuments(upload(), env, participant),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([
			201,
			409,
		]);
		expect(
			await env.ORG_DB!.prepare(
				"SELECT version,status FROM team_documents WHERE team_id='team-a' ORDER BY version",
			).all(),
		).toMatchObject({ results: [{ version: 1, status: "STORED" }] });
	});

	it("does not record a deadline audit transition when its insert fails", async () => {
		await env.ORG_DB!.prepare("DELETE FROM audit").run();
		await env.ORG_DB!.prepare(
			"UPDATE hackathons SET analysis_document_deadline=NULL,pull_request_deadline=NULL WHERE id='initial'",
		).run();
		await env.ORG_DB!.prepare(
			"CREATE TRIGGER reject_deadline_audit BEFORE INSERT ON audit WHEN NEW.action='hackathon.deadlines.updated' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
		).run();
		const response = await competition(
			request("/api/organization/manage/deadlines", "PUT", {
				analysisDocumentDeadline: "2030-01-01T00:00:00Z",
				pullRequestDeadline: null,
			}),
			env,
			ctx,
			services,
			"organizer:organizer-identity",
		);
		expect(response.status).toBe(409);
		expect(
			await env.ORG_DB!.prepare(
				"SELECT analysis_document_deadline AS deadline FROM hackathons WHERE id='initial'",
			).first(),
		).toMatchObject({ deadline: null });
	});

	it("does not update deadlines when the audit insert is ignored", async () => {
		await env.ORG_DB!.prepare("DELETE FROM audit").run();
		await env.ORG_DB!.prepare(
			"UPDATE hackathons SET analysis_document_deadline=?,pull_request_deadline=? WHERE id='initial'",
		).bind("2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z").run();
		await env.ORG_DB!.prepare(
			"CREATE TRIGGER ignore_deadline_audit BEFORE INSERT ON audit WHEN NEW.action='hackathon.deadlines.updated' BEGIN SELECT RAISE(IGNORE); END",
		).run();
		const response = await competition(
			request("/api/organization/manage/deadlines", "PUT", {
				analysisDocumentDeadline: "2031-01-01T00:00:00Z",
				pullRequestDeadline: null,
			}),
			env,
			ctx,
			services,
			"organizer:organizer-identity",
		);
		expect(response.status).toBe(409);
		expect(
			await env.ORG_DB!.prepare(
				"SELECT analysis_document_deadline AS analysisDocumentDeadline,pull_request_deadline AS pullRequestDeadline FROM hackathons WHERE id='initial'",
			).first(),
		).toEqual({
			analysisDocumentDeadline: "2030-01-01T00:00:00Z",
			pullRequestDeadline: "2030-01-02T00:00:00Z",
		});
	});

	it("keeps concurrent deadline audit transitions connected", async () => {
		const put = (analysisDocumentDeadline: string) =>
			competition(
				request("/api/organization/manage/deadlines", "PUT", {
					analysisDocumentDeadline,
					pullRequestDeadline: null,
				}),
				env,
				ctx,
				services,
				"organizer:organizer-identity",
			);
		await Promise.all([
			put("2030-01-01T00:00:00Z"),
			put("2031-01-01T00:00:00Z"),
		]);
		const audits = await env.ORG_DB!.prepare(
			"SELECT changes FROM audit WHERE action='hackathon.deadlines.updated' ORDER BY id",
		).all<{ changes: string }>();
		const transitions = audits.results.map(({ changes }) =>
			JSON.parse(changes)
		);
		expect(transitions).toHaveLength(2);
		expect(transitions[0].before).toEqual({
			analysisDocumentDeadline: null,
			pullRequestDeadline: null,
		});
		expect(transitions[1].before).toEqual(transitions[0].after);
		expect(transitions[1].after).toMatchObject({
			pullRequestDeadline: null,
		});
	});

	it("allows replacement before the analysis deadline and blocks it after", async () => {
		await env.ORG_DB!.prepare(
			"INSERT INTO team_documents(id,team_id,version,object_key,filename,content_type,bytes,sha256,status,uploaded_by_identity_id) VALUES('11111111-1111-4111-8111-111111111111','team-a',1,'old','old.pdf','application/pdf',8,?,'STORED','participant-identity')",
		)
			.bind("a".repeat(64)).run();
		await env.ORG_DB!.prepare(
			"UPDATE hackathons SET analysis_document_deadline='2999-01-01T00:00:00Z' WHERE id='initial'",
		).run();
		const beforeDeadline = await participantDocuments(
			upload(),
			env,
			participant,
		);
		expect(beforeDeadline.status).toBe(201);
		await env.ORG_DB!.prepare(
			"UPDATE hackathons SET analysis_document_deadline='2000-01-01T00:00:00Z' WHERE id='initial'",
		).run();
		const replacement = await participantDocuments(
			upload(),
			env,
			participant,
		);
		expect(replacement.status).toBe(409);
		expect(await replacement.json()).toEqual({
			error: "ANALYSIS_DOCUMENT_DEADLINE_PASSED",
		});
	});
});
