import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "./miniflare";
import { migrate } from "./database";
import { digest } from "../src/domain";
import worker from "../src/index";
import type { Env } from "../src/env";

const origin = "https://organization.test",
	participantToken = "a".repeat(64),
	organizerToken = "d".repeat(64),
	participantId = "participant-identity",
	organizerId = "organizer-identity",
	ctx = {
		waitUntil() {},
		passThroughOnException() {},
	} as unknown as ExecutionContext;
let mf: Miniflare, env: Env;

function request(
	path: string,
	method = "GET",
	data?: unknown,
	token: string | null = participantToken,
) {
	return new Request(origin + path, {
		method,
		headers: {
			origin,
			"content-type": "application/json",
			...(token ? { cookie: "judge_organizer=" + token } : {}),
		},
		...(data === undefined ? {} : { body: JSON.stringify(data) }),
	});
}

async function activeRepositoryIds(db: D1Database) {
	return (
		await db
			.prepare(
				"SELECT repository_id FROM team_repositories WHERE team_id='team-a' AND active=1 ORDER BY repository_id",
			)
			.all<{ repository_id: number }>()
	).results;
}

function pauseFirstTrackOperation(db: D1Database) {
	const activeQuery =
		"SELECT repository_id FROM team_repositories WHERE team_id=? AND active=1";
	let operationStarted: () => void = () => {},
		releaseOperation: () => void = () => {};
	let paused = false;
	const started = new Promise<void>((resolve) => {
		operationStarted = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		releaseOperation = resolve;
	});
	const pause = async () => {
		if (paused) return;
		paused = true;
		operationStarted();
		await gate;
	};
	const wrapStatement = (
		statement: D1PreparedStatement,
	): D1PreparedStatement =>
		new Proxy(statement, {
			get(target, property) {
				if (property === "bind") {
					return (...values: unknown[]) =>
						wrapStatement(target.bind(...values));
				}
				if (property === "all") {
					return async <T = Record<string, unknown>>() => {
						const result = await target.all<T>();
						await pause();
						return result;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	const database = new Proxy(db, {
		get(target, property) {
			if (property === "prepare") {
				return (query: string) => {
					const statement = target.prepare(query);
					return query === activeQuery
						? wrapStatement(statement)
						: statement;
				};
			}
			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					await pause();
					return target.batch(statements);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { database, started, release: releaseOperation };
}

beforeEach(async () => {
	mf = new Miniflare({
		modules: true,
		script: 'export default{fetch(){return new Response("ok")}}',
		d1Databases: ["DB"],
		compatibilityDate: "2026-08-01",
	});
	const db = (await mf.getD1Database("DB")) as unknown as D1Database;
	await migrate(db);
	await db
		.prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A')")
		.run();
	await db.prepare("UPDATE teams SET hackathon_id='initial',status='ACTIVE',lead_email='lead@example.test' WHERE id='team-a'").run();
	await db.prepare("INSERT INTO team_roster_members(id,team_id,hackathon_id,display_name,email) VALUES('lead-roster','team-a','initial','Team Lead','lead@example.test')").run();
	for (
		const [index, name] of [
			"mazhai-cover",
			"pricingpulse",
			"veera-footwear",
			"janus",
			"noyyal-treasury",
		].entries()
	) {
		await db
			.prepare(
				"INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(?,? ,0,'main')",
			)
			.bind(index + 10, "180DC-VIT-CHENNAI/" + name)
			.run();
	}
	await db
		.prepare(
			"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',14,'organizer:test')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO console_identities(id,name,role,team_id,team_roster_member_id,credential_hash) VALUES(?, 'Team A','participant','team-a','lead-roster',?),(?, 'Organizer','organizer',NULL,NULL,?)",
		)
		.bind(participantId, "b".repeat(64), organizerId, "c".repeat(64))
		.run();
	await db
		.prepare(
			"INSERT INTO console_identity_sessions(hash,identity_id,expires_at) VALUES(?,?,?),(?,?,?)",
		)
		.bind(
			await digest(participantToken),
			participantId,
			Date.now() + 3600000,
			await digest(organizerToken),
			organizerId,
			Date.now() + 3600000,
		)
		.run();
	env = {
		DB: db,
		ORG_DB: db,
		ORG_ADMIN_TOKEN: "x".repeat(40),
		ORG_VAULT_KEY: "12".repeat(32),
		ORG_NAME: "Doomforge",
		ORG_PUBLIC_ORIGIN: origin,
	} as unknown as Env;
});

afterEach(async () => {
	await mf.dispose();
});

describe("participant repository selection through the Worker fetch surface", () => {
	it("lists only accessible configured repositories for participant sessions", async () => {
		await env.ORG_DB!
			.prepare("UPDATE github_repositories SET accessible=0 WHERE id=12")
			.run();
		const response = await worker.fetch(
			request("/api/organization/participant/track-options"),
			env,
			ctx,
		);
		expect({
			status: response.status,
			options: await response.json(),
		}).toEqual({
			status: 200,
			options: {
				repositories: [
					{
						repositoryId: 10,
						fullName: "180DC-VIT-CHENNAI/mazhai-cover",
					},
					{
						repositoryId: 11,
						fullName: "180DC-VIT-CHENNAI/pricingpulse",
					},
					{ repositoryId: 13, fullName: "180DC-VIT-CHENNAI/janus" },
				],
			},
		});
	});

	it("finalizes the lead's first selection even when an engineering review draft exists", async () => {
		const repositoryB = await env.ORG_DB!.prepare(
			"SELECT id FROM github_repositories WHERE full_name='180DC-VIT-CHENNAI/mazhai-cover'",
		).first<{ id: number }>();
		await env.ORG_DB!.prepare("UPDATE team_repositories SET active=0 WHERE team_id='team-a'").run();
		await env.ORG_DB!.prepare(
			"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',11,'organizer:test')",
		).run();
		await env.ORG_DB!.prepare(
			"INSERT INTO console_identities(id,name,role,credential_hash) VALUES('judge-a','Judge','judge',?)",
		).bind("e".repeat(64)).run();
		await env.ORG_DB!.prepare(
			"INSERT INTO round_two_review_drafts(team_id,judge_identity_id,stage,score,payload) VALUES('team-a','judge-a','ENGINEERING',85,'{}')",
		).run();
		const selected = await worker.fetch(
			request("/api/organization/participant/track", "POST", { repositoryId: repositoryB!.id }),
			env,
			ctx,
		);
		const rejectedSwitch = await worker.fetch(
			request("/api/organization/participant/track", "POST", { repositoryId: 11 }),
			env,
			ctx,
		);
		expect([selected.status, await selected.json(), rejectedSwitch.status, await rejectedSwitch.json()]).toEqual([
			200,
			{ track: { repositoryId: repositoryB!.id, fullName: "180DC-VIT-CHENNAI/mazhai-cover" } },
			409,
			{ error: "TRACK_FINALIZED" },
		]);
		expect(await activeRepositoryIds(env.ORG_DB!)).toEqual([{ repository_id: repositoryB!.id }]);
	});

	it("allows the lead to finalize their first selection after an engineering final review", async () => {
		const repositoryB = await env.ORG_DB!.prepare(
			"SELECT id FROM github_repositories WHERE full_name='180DC-VIT-CHENNAI/mazhai-cover'",
		).first<{ id: number }>();
		await env.ORG_DB!.prepare("UPDATE team_repositories SET active=0 WHERE team_id='team-a'").run();
		await env.ORG_DB!.prepare(
			"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',11,'organizer:test')",
		).run();
		await env.ORG_DB!.prepare(
			"INSERT INTO console_identities(id,name,role,credential_hash) VALUES('judge-final','Judge','judge',?)",
		).bind("f".repeat(64)).run();
		await env.ORG_DB!.prepare(
			"INSERT INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,reason) VALUES('final','team-a','judge-final','ENGINEERING',1,90,'{}','Submitted')",
		).run();
		const response = await worker.fetch(
			request("/api/organization/participant/track", "POST", { repositoryId: repositoryB!.id }),
			env,
			ctx,
		);
		expect([response.status, await response.json()]).toEqual([200, { track: { repositoryId: repositoryB!.id, fullName: "180DC-VIT-CHENNAI/mazhai-cover" } }]);
	});

	it("denies track options to organizer and anonymous sessions", async () => {
		const organizer = await worker.fetch(
			request(
				"/api/organization/participant/track-options",
				"GET",
				undefined,
				organizerToken,
			),
			env,
			ctx,
		);
		const anonymous = await worker.fetch(
			request(
				"/api/organization/participant/track-options",
				"GET",
				undefined,
				null,
			),
			env,
			ctx,
		);
		expect([
			organizer.status,
			(await organizer.json() as { error: string }).error,
			anonymous.status,
			(await anonymous.json() as { error: string }).error,
		]).toEqual([403, "PARTICIPANT_REQUIRED", 401, "UNAUTHORIZED"]);
	});

	it("selects one allowed track, audits the switch, and exposes it in the dashboard", async () => {
		const response = await worker.fetch(
			request("/api/organization/participant/track", "POST", {
				repositoryId: 11,
			}),
			env,
			ctx,
		);
		const body = (await response.json()) as {
			track: { repositoryId: number; fullName: string };
		};
		const dashboardResponse = await worker.fetch(
			request("/api/organization/participant"),
			env,
			ctx,
		);
		const dashboard = await dashboardResponse.json() as { error: string };
		const audit = await env.ORG_DB!.prepare(
			"SELECT changes FROM audit WHERE action='team.track_selected'",
		).first<string>("changes");
		expect({
			status: response.status,
			cacheControl: response.headers.get("cache-control"),
			track: body.track,
			active: await activeRepositoryIds(env.ORG_DB!),
			dashboardStatus: dashboardResponse.status,
			dashboardError: dashboard.error,
			audit: JSON.parse(audit ?? "{}"),
		}).toEqual({
			status: 200,
			cacheControl: "no-store",
			track: {
				repositoryId: 11,
				fullName: "180DC-VIT-CHENNAI/pricingpulse",
			},
			active: [{ repository_id: 11 }],
			dashboardStatus: 428,
			dashboardError: "PARTICIPANT_ONBOARDING_REQUIRED",
			audit: {
				eventId: expect.any(String),
				previousRepositoryIds: [14],
				repositoryId: 11,
				fullName: "180DC-VIT-CHENNAI/pricingpulse",
			},
		});
	});

	it("denies an outside repository and preserves the current track", async () => {
		const response = await worker.fetch(
			request("/api/organization/participant/track", "POST", {
				repositoryId: 14,
			}),
			env,
			ctx,
		);
		expect({
			status: response.status,
			error: ((await response.json()) as { error: string }).error,
			active: await activeRepositoryIds(env.ORG_DB!),
		}).toEqual({
			status: 403,
			error: "TRACK_NOT_ALLOWED",
			active: [{ repository_id: 14 }],
		});
	});

	it("preserves the current track and reports failure when the audit insert fails", async () => {
		const db = env.ORG_DB!;
		await db
			.prepare(
				"CREATE TRIGGER fail_track_audit BEFORE INSERT ON audit WHEN NEW.action='team.track_selected' BEGIN SELECT RAISE(IGNORE); END",
			)
			.run();

		const response = await worker.fetch(
			request("/api/organization/participant/track", "POST", {
				repositoryId: 11,
			}),
			env,
			ctx,
		);

		expect({
			status: response.status,
			body: ((await response.json()) as { error: string }).error,
			active: await activeRepositoryIds(db),
		}).toEqual({
			status: 503,
			body: "SERVICE_UNAVAILABLE",
			active: [{ repository_id: 14 }],
		});
	});

	it("rejects missing and non-participant sessions without mutation", async () => {
		const anonymous = await worker.fetch(
			request("/api/organization/participant/track", "POST", {
				repositoryId: 11,
			}, null),
			env,
			ctx,
		);
		const organizer = await worker.fetch(
			request("/api/organization/participant/track", "POST", {
				repositoryId: 11,
			}, organizerToken),
			env,
			ctx,
		);
		expect({
			anonymousStatus: anonymous.status,
			anonymousError:
				((await anonymous.json()) as { error: string }).error,
			organizerStatus: organizer.status,
			organizerError:
				((await organizer.json()) as { error: string }).error,
			active: await activeRepositoryIds(env.ORG_DB!),
		}).toEqual({
			anonymousStatus: 401,
			anonymousError: "UNAUTHORIZED",
			organizerStatus: 403,
			organizerError: "PARTICIPANT_REQUIRED",
			active: [{ repository_id: 14 }],
		});
	});

	it("leaves one active track when two selections race", async () => {
		const db = env.ORG_DB!;
		const [firstResponse, secondResponse] = await Promise.all([
		worker.fetch(
			request("/api/organization/participant/track", "POST", {
				repositoryId: 11,
			}),
			env,
			ctx,
		),
		worker.fetch(
			request("/api/organization/participant/track", "POST", {
				repositoryId: 12,
			}),
			env,
			ctx,
		),
		]);
		const changes = (
			await db
				.prepare(
					"SELECT changes FROM audit WHERE action='team.track_selected' ORDER BY rowid",
				)
				.all<{ changes: string }>()
		).results.map((row) =>
			JSON.parse(row.changes) as {
				previousRepositoryIds: number[];
				repositoryId: number;
			}
		);
		expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 409]);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.previousRepositoryIds).toEqual([14]);
		expect(await activeRepositoryIds(db)).toEqual([
			{ repository_id: changes[0]?.repositoryId },
		]);
	});

	it("reapplies a same-track selection if another request switches away first", async () => {
		const db = env.ORG_DB!;
		await db
			.prepare(
				"UPDATE team_repositories SET active=0 WHERE team_id='team-a'",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',11,'organizer:test')",
			)
			.run();
		const [sameTrackResponse, switchResponse] = await Promise.all([
		worker.fetch(
			request("/api/organization/participant/track", "POST", {
				repositoryId: 11,
			}),
			env,
			ctx,
		),
		worker.fetch(
			request("/api/organization/participant/track", "POST", {
				repositoryId: 12,
			}),
			env,
			ctx,
		),
		]);
		const sameTrackBody = await sameTrackResponse.json();
		expect([
			switchResponse.status,
			sameTrackResponse.status,
			sameTrackBody,
			await activeRepositoryIds(db),
		]).toEqual([
			409,
			200,
			{ track: { repositoryId: 11, fullName: "180DC-VIT-CHENNAI/pricingpulse" } },
			[{ repository_id: 11 }],
		]);
	});

	it("uses the repository name current at the selection transaction", async () => {
		const db = env.ORG_DB!;
		const operation = pauseFirstTrackOperation(db);
		env.ORG_DB = operation.database;
		const selection = worker.fetch(
			request("/api/organization/participant/track", "POST", {
				repositoryId: 11,
			}),
			env,
			ctx,
		);
		await operation.started;
		await db
			.prepare("UPDATE github_repositories SET full_name=? WHERE id=10")
			.bind("180DC-VIT-CHENNAI/archived-track")
			.run();
		await db
			.prepare("UPDATE github_repositories SET full_name=? WHERE id=11")
			.bind("180DC-VIT-CHENNAI/mazhai-cover")
			.run();
		operation.release();
		const response = await selection;
		env.ORG_DB = db;
		const body = (await response.json()) as {
			track: { repositoryId: number; fullName: string };
		};
		const audit = await db
			.prepare(
				"SELECT changes FROM audit WHERE action='team.track_selected'",
			)
			.first<string>("changes");
		expect({
			status: response.status,
			track: body.track,
			audit: JSON.parse(audit ?? "{}"),
			active: await activeRepositoryIds(db),
		}).toEqual({
			status: 200,
			track: {
				repositoryId: 11,
				fullName: "180DC-VIT-CHENNAI/pricingpulse",
			},
			audit: {
				eventId: expect.any(String),
				previousRepositoryIds: [14],
				repositoryId: 11,
				fullName: "180DC-VIT-CHENNAI/pricingpulse",
			},
			active: [{ repository_id: 11 }],
		});
	});
});
