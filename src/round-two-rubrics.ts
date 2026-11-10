import { z } from "zod";
import { selectedRepository } from "./competition-store";
import { canonical } from "./domain";
import { boundedBody } from "./security";
import { validateTrackRubric } from "./round-two-scoring";
import type { ConsoleSession } from "./console-identities";
import type { Env } from "./env";

const json = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});

async function input(request: Request) {
	return JSON.parse(
		new TextDecoder().decode(await boundedBody(request, 20_000)),
	);
}

export async function roundTwoRubrics(
	request: Request,
	env: Env,
	session: ConsoleSession,
) {
	const db = env.ORG_DB;
	if (!db) return json({ error: "ORGANIZATION_NOT_CONFIGURED" }, 503);
	if (session.role !== "organizer") {
		return json({ error: "ORGANIZER_REQUIRED" }, 403);
	}
	const path = new URL(request.url).pathname.replace(
		"/api/organization/round-two/rubrics",
		"",
	);
	if (path || (request.method !== "GET" && request.method !== "POST")) {
		return json({ error: "NOT_FOUND" }, 404);
	}
	if (request.method === "GET") {
		const repositoryResult = z.coerce
			.number()
			.int()
			.positive()
			.safeParse(new URL(request.url).searchParams.get("repositoryId"));
		if (!repositoryResult.success) {
			return json({ error: "INVALID_REPOSITORY" }, 400);
		}
		const repository = await selectedRepository(env, repositoryResult.data),
			[active, versions] = await Promise.all([
				db
					.prepare(
						"SELECT v.id,v.repository_id,v.version,v.criteria,v.actor,v.created_at FROM round_two_active_repository_rubrics a JOIN round_two_repository_rubric_versions v ON v.id=a.rubric_id WHERE a.repository_id=?",
					)
					.bind(repository.id)
					.first<Record<string, unknown>>(),
				db
					.prepare(
						"SELECT id,repository_id,version,criteria,actor,created_at FROM round_two_repository_rubric_versions WHERE repository_id=? ORDER BY version DESC LIMIT 100",
					)
					.bind(repository.id)
					.all<Record<string, unknown>>(),
			]),
			decode = (row: Record<string, unknown> | null) =>
				row
					? {
						...row,
						criteria: typeof row.criteria === "string"
							? JSON.parse(row.criteria)
							: row.criteria,
					}
					: null;
		return json({
			repository,
			active: decode(active),
			versions: versions.results.map((row) => decode(row)!),
		});
	}

	let data: { repositoryId: number; criteria: unknown };
	try {
		data = z
			.object({
				repositoryId: z.number().int().positive(),
				criteria: z.unknown(),
			})
			.strict()
			.parse(await input(request));
	} catch {
		return json({ error: "INVALID_INPUT" }, 400);
	}
	let criteria: ReturnType<typeof validateTrackRubric>;
	try {
		criteria = validateTrackRubric(data.criteria);
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error &&
						error.message === "RUBRIC_WEIGHT_TOTAL"
						? "RUBRIC_WEIGHT_TOTAL"
						: "INVALID_RUBRIC",
			},
			400,
		);
	}
	const repository = await selectedRepository(env, data.repositoryId),
		next = await db
			.prepare(
				"SELECT COALESCE(MAX(version),0)+1 AS version FROM round_two_repository_rubric_versions WHERE repository_id=?",
			)
			.bind(repository.id)
			.first<{ version: number }>(),
		id = crypto.randomUUID(),
		actor = "organizer:" + (session.identity_id ?? session.hash),
		version = next?.version ?? 1;
	await db.batch([
		db
			.prepare(
				"INSERT INTO round_two_repository_rubric_versions(id,repository_id,version,criteria,actor) VALUES(?,?,?,?,?)",
			)
			.bind(id, repository.id, version, canonical(criteria), actor),
		db
			.prepare(
				"INSERT INTO round_two_active_repository_rubrics(repository_id,rubric_id,actor) VALUES(?,?,?) ON CONFLICT(repository_id) DO UPDATE SET rubric_id=excluded.rubric_id,actor=excluded.actor,updated_at=CURRENT_TIMESTAMP",
			)
			.bind(repository.id, id, actor),
		db
			.prepare(
				"INSERT INTO audit(action,entity,actor,changes) VALUES('rubric.published',?,?,?)",
			)
			.bind(
				repository.id.toString(),
				actor,
				canonical({
					repositoryId: repository.id,
					rubricId: id,
					version,
				}),
			),
	]);
	return json(
		{
			rubric: {
				id,
				repositoryId: repository.id,
				version,
				criteria,
			},
		},
		201,
	);
}
