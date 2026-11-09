import { z } from "zod";
import { boundedBody } from "./security";
import {
	normalizeEngineeringScore,
	type TrackRubricCriterion,
	validateTrackRubric,
} from "./round-two-scoring";
import type { ConsoleSession } from "./console-identities";
import type { Env } from "./env";

const json = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
const stageSchema = z.enum(["ANALYSIS", "ENGINEERING"]);
const analysisFeedbackSchema = z
	.object({
		problemUnderstanding: z.string().trim().max(5000),
		remediation: z.string().trim().max(5000),
		innovationImpact: z.string().trim().max(5000),
		overall: z.string().trim().max(5000),
	})
	.strict();
const criterionFeedbackSchema = z
	.object({
		criterionId: z.string().min(1).max(80),
		score: z.number().finite().min(0).max(100),
		comment: z.string().trim().max(5000),
	})
	.strict();
const reviewInput = z
	.object({
		action: z.enum(["SAVE_DRAFT", "SUBMIT", "REVISE"]),
		teamId: z.string().min(1).max(80),
		stage: stageSchema,
		score: z.number().finite().min(0).max(100).optional(),
		feedback: analysisFeedbackSchema.optional(),
		criteriaScores: z.array(criterionFeedbackSchema).max(50).optional(),
		overall: z.string().trim().max(5000).optional(),
		documentId: z.string().min(1).max(100).optional(),
		reason: z.string().trim().min(10).max(1000).optional(),
	})
	.strict();

async function input(request: Request) {
	return JSON.parse(
		new TextDecoder().decode(await boundedBody(request, 20_000)),
	);
}

async function assigned(db: D1Database, judgeId: string, teamId: string) {
	return db
		.prepare(
			"SELECT a.id FROM round_two_judge_assignments a JOIN teams t ON t.id=a.team_id WHERE a.judge_identity_id=? AND a.team_id=? AND a.revoked_at IS NULL AND t.status='ACTIVE' AND t.hackathon_id='initial'",
		)
		.bind(judgeId, teamId)
		.first();
}

function decode<T extends { payload: string }>(row: T) {
	return { ...row, payload: JSON.parse(row.payload) as unknown };
}

type RubricResult =
	| {
		error:
			| "TEAM_REPOSITORY_SELECTION_REQUIRED"
			| "RUBRIC_NOT_CONFIGURED"
			| "RUBRIC_UNAVAILABLE";
	}
	| {
		rubric: {
			id: string;
			repositoryId: number;
			version: number;
			criteria: TrackRubricCriterion[];
		};
	};

async function repositoryRubric(
	db: D1Database,
	teamId: string,
): Promise<RubricResult> {
	const repositories = await db
		.prepare(
			"SELECT repository_id FROM team_repositories WHERE team_id=? AND active=1",
		)
		.bind(teamId)
		.all<{ repository_id: number }>();
	if (repositories.results.length !== 1) {
		return { error: "TEAM_REPOSITORY_SELECTION_REQUIRED" };
	}
	const rubric = await db
		.prepare(
			"SELECT v.id,v.repository_id,v.version,v.criteria FROM round_two_active_repository_rubrics a JOIN round_two_repository_rubric_versions v ON v.id=a.rubric_id WHERE a.repository_id=?",
		)
		.bind(repositories.results[0]!.repository_id)
		.first<{
			id: string;
			repository_id: number;
			version: number;
			criteria: string;
		}>();
	if (!rubric) return { error: "RUBRIC_NOT_CONFIGURED" };
	try {
		return {
			rubric: {
				id: rubric.id,
				repositoryId: rubric.repository_id,
				version: rubric.version,
				criteria: validateTrackRubric(JSON.parse(rubric.criteria)),
			},
		};
	} catch {
		return { error: "RUBRIC_UNAVAILABLE" };
	}
}

async function rubricByVersion(db: D1Database, id: string | null) {
	if (!id) return null;
	const rubric = await db
		.prepare(
			"SELECT id,repository_id,version,criteria FROM round_two_repository_rubric_versions WHERE id=?",
		)
		.bind(id)
		.first<{
			id: string;
			repository_id: number;
			version: number;
			criteria: string;
		}>();
	if (!rubric) return null;
	try {
		return {
			id: rubric.id,
			repositoryId: rubric.repository_id,
			version: rubric.version,
			criteria: validateTrackRubric(JSON.parse(rubric.criteria)),
		};
	} catch {
		return null;
	}
}

async function engineeringReview(
	db: D1Database,
	data: z.infer<typeof reviewInput>,
	session: ConsoleSession,
) {
	const judgeId = session.identity_id!;
	if (data.action === "SUBMIT") {
		const draft = await db
			.prepare(
				"SELECT score,payload,rubric_version_id FROM round_two_review_drafts WHERE team_id=? AND judge_identity_id=? AND stage='ENGINEERING'",
			)
			.bind(data.teamId, judgeId)
			.first<{
				score: number | null;
				payload: string;
				rubric_version_id: string | null;
			}>();
		if (!draft || draft.score === null || !draft.rubric_version_id) {
			return json({ error: "ENGINEERING_DRAFT_REQUIRED" }, 409);
		}
		const id = crypto.randomUUID(),
			actor = "judge:" + judgeId,
			results = await db.batch([
				db
					.prepare(
						"INSERT OR IGNORE INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason,rubric_version_id) SELECT ?,?,?,'ENGINEERING',1,?,?,NULL,'Initial submission',? WHERE EXISTS(SELECT 1 FROM round_two_judge_assignments WHERE judge_identity_id=? AND team_id=? AND revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM round_two_review_submissions WHERE team_id=? AND judge_identity_id=? AND stage='ENGINEERING')",
					)
					.bind(
						id,
						data.teamId,
						judgeId,
						draft.score,
						draft.payload,
						draft.rubric_version_id,
						judgeId,
						data.teamId,
						data.teamId,
						judgeId,
					),
				db
					.prepare(
						"DELETE FROM round_two_review_drafts WHERE team_id=? AND judge_identity_id=? AND stage='ENGINEERING' AND changes()=1",
					)
					.bind(data.teamId, judgeId),
				db
					.prepare(
						"INSERT INTO audit(action,entity,actor,changes) SELECT 'review.submitted',?,?,? WHERE changes()=1",
					)
					.bind(
						data.teamId + ":" + judgeId + ":ENGINEERING",
						actor,
						JSON.stringify({
							score: draft.score,
							rubricVersionId: draft.rubric_version_id,
						}),
					),
			]);
		if (!results[0]?.meta.changes) {
			return json({ error: "REVIEW_ALREADY_SUBMITTED" }, 409);
		}
		return json(
			{ id, revision: 1, score: draft.score, status: "FINAL" },
			201,
		);
	}
	if (
		!data.criteriaScores ||
		!data.overall ||
		data.score !== undefined ||
		data.feedback ||
		data.documentId
	) {
		return json({ error: "ENGINEERING_REVIEW_REQUIRED" }, 400);
	}
	let rubric: Awaited<ReturnType<typeof rubricByVersion>>;
	if (data.action === "REVISE") {
		if (!data.reason) {
			return json({ error: "REVISION_REASON_REQUIRED" }, 400);
		}
		const latest = await db
			.prepare(
				"SELECT rubric_version_id FROM round_two_review_submissions WHERE team_id=? AND judge_identity_id=? AND stage='ENGINEERING' ORDER BY revision DESC LIMIT 1",
			)
			.bind(data.teamId, judgeId)
			.first<{ rubric_version_id: string | null }>();
		if (!latest?.rubric_version_id) {
			return json({ error: "FINAL_REVIEW_REQUIRED" }, 409);
		}
		rubric = await rubricByVersion(db, latest.rubric_version_id);
	} else {
		const active = await repositoryRubric(db, data.teamId);
		if ("error" in active) return json({ error: active.error }, 409);
		rubric = active.rubric;
	}
	if (!rubric) return json({ error: "RUBRIC_UNAVAILABLE" }, 503);
	let score: number;
	try {
		score = normalizeEngineeringScore(
			rubric.criteria,
			data.criteriaScores.map(({ criterionId, score }) => ({
				criterionId,
				score,
			})),
		);
	} catch {
		return json({ error: "INVALID_CRITERION_SCORES" }, 400);
	}
	const payload = JSON.stringify({
			criteriaScores: data.criteriaScores,
			overall: data.overall,
		}),
		actor = "judge:" + judgeId;
	if (data.action === "SAVE_DRAFT") {
		const saved = await db
			.prepare(
				"INSERT INTO round_two_review_drafts(team_id,judge_identity_id,stage,score,payload,document_id,rubric_version_id) SELECT ?,?,'ENGINEERING',?,?,NULL,? WHERE EXISTS(SELECT 1 FROM round_two_judge_assignments WHERE judge_identity_id=? AND team_id=? AND revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM round_two_review_submissions WHERE team_id=? AND judge_identity_id=? AND stage='ENGINEERING') ON CONFLICT(team_id,judge_identity_id,stage) DO UPDATE SET score=excluded.score,payload=excluded.payload,document_id=NULL,rubric_version_id=excluded.rubric_version_id,updated_at=CURRENT_TIMESTAMP WHERE NOT EXISTS(SELECT 1 FROM round_two_review_submissions WHERE team_id=excluded.team_id AND judge_identity_id=excluded.judge_identity_id AND stage='ENGINEERING') RETURNING team_id",
			)
			.bind(
				data.teamId,
				judgeId,
				score,
				payload,
				rubric.id,
				judgeId,
				data.teamId,
				data.teamId,
				judgeId,
			)
			.first();
		if (!saved) return json({ error: "REVIEW_FINAL_LOCKED" }, 409);
		await db
			.prepare(
				"INSERT INTO audit(action,entity,actor,changes) VALUES('review.draft_saved',?,?,?)",
			)
			.bind(
				data.teamId + ":" + judgeId + ":ENGINEERING",
				actor,
				JSON.stringify({ score, rubricVersionId: rubric.id }),
			)
			.run();
		return json({
			status: "DRAFT_SAVED",
			score,
			rubricVersionId: rubric.id,
		});
	}
	const previous = await db
		.prepare(
			"SELECT COALESCE(MAX(revision),0) AS revision FROM round_two_review_submissions WHERE team_id=? AND judge_identity_id=? AND stage='ENGINEERING'",
		)
		.bind(data.teamId, judgeId)
		.first<{ revision: number }>();
	if (!previous?.revision) {
		return json({ error: "FINAL_REVIEW_REQUIRED" }, 409);
	}
	const id = crypto.randomUUID(),
		revision = previous.revision + 1,
		results = await db.batch([
			db
				.prepare(
					"INSERT OR IGNORE INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason,rubric_version_id) SELECT ?,?,?,'ENGINEERING',?,?,?,NULL,?,? WHERE EXISTS(SELECT 1 FROM round_two_judge_assignments WHERE judge_identity_id=? AND team_id=? AND revoked_at IS NULL)",
				)
				.bind(
					id,
					data.teamId,
					judgeId,
					revision,
					score,
					payload,
					data.reason,
					rubric.id,
					judgeId,
					data.teamId,
				),
			db
				.prepare(
					"INSERT INTO audit(action,entity,actor,changes) SELECT 'review.revised',?,?,? WHERE changes()=1",
				)
				.bind(
					data.teamId + ":" + judgeId + ":ENGINEERING",
					actor,
					JSON.stringify({
						revision,
						score,
						rubricVersionId: rubric.id,
						reason: data.reason,
					}),
				),
		]);
	if (!results[0]?.meta.changes) {
		return json({ error: "REVIEW_REVISION_CONFLICT" }, 409);
	}
	return json({ id, revision, score, status: "FINAL" }, 201);
}

export async function roundTwoEvaluations(
	request: Request,
	env: Env,
	session: ConsoleSession,
) {
	const db = env.ORG_DB;
	if (!db) return json({ error: "ORGANIZATION_NOT_CONFIGURED" }, 503);
	if (session.role !== "organizer" && session.role !== "judge") {
		return json({ error: "REVIEW_ACCESS_REQUIRED" }, 403);
	}
	const url = new URL(request.url),
		path = url.pathname.replace(
			"/api/organization/round-two/reviews",
			"",
		);
	if (path === "" && request.method === "GET") {
		const teamId = url.searchParams.get("teamId"),
			stageResult = stageSchema.safeParse(url.searchParams.get("stage"));
		if (!teamId || !stageResult.success) {
			return json({ error: "INVALID_REVIEW_SCOPE" }, 400);
		}
		const stage = stageResult.data;
		if (
			session.role === "judge" &&
			(!session.identity_id ||
				!(await assigned(db, session.identity_id, teamId)))
		) {
			return json({ error: "NOT_FOUND" }, 404);
		}
		if (
			!(await db
				.prepare(
					"SELECT id FROM teams WHERE id=? AND status='ACTIVE' AND hackathon_id='initial'",
				)
				.bind(teamId)
				.first())
		) {
			return json({ error: "NOT_FOUND" }, 404);
		}
		const judgeId = session.role === "judge"
				? session.identity_id
				: url.searchParams.get("judgeIdentityId"),
			[drafts, submissions, currentDocument] = await Promise.all([
				db
					.prepare(
						"SELECT team_id,judge_identity_id,stage,score,payload,document_id,rubric_version_id,updated_at FROM round_two_review_drafts WHERE team_id=? AND stage=? AND (? IS NULL OR judge_identity_id=?) ORDER BY updated_at DESC LIMIT 100",
					)
					.bind(teamId, stage, judgeId, judgeId)
					.all<{
						team_id: string;
						judge_identity_id: string;
						stage: string;
						score: number | null;
						payload: string;
						document_id: string | null;
						rubric_version_id: string | null;
						updated_at: string;
					}>(),
				db
					.prepare(
						"SELECT id,team_id,judge_identity_id,stage,revision,score,payload,document_id,rubric_version_id,reason,submitted_at FROM round_two_review_submissions WHERE team_id=? AND stage=? AND (? IS NULL OR judge_identity_id=?) ORDER BY submitted_at DESC,revision DESC LIMIT 200",
					)
					.bind(teamId, stage, judgeId, judgeId)
					.all<{
						id: string;
						team_id: string;
						judge_identity_id: string;
						stage: string;
						revision: number;
						score: number;
						payload: string;
						document_id: string | null;
						rubric_version_id: string | null;
						reason: string;
						submitted_at: string;
					}>(),
				stage === "ANALYSIS"
					? db
						.prepare(
							"SELECT id,version,filename,created_at FROM team_documents WHERE team_id=? AND status='STORED' ORDER BY version DESC LIMIT 1",
						)
						.bind(teamId)
						.first<{
							id: string;
							version: number;
							filename: string;
							created_at: string;
						}>()
					: Promise.resolve(null),
			]);
		const activeRubricResult = stage === "ENGINEERING"
				? await repositoryRubric(db, teamId)
				: null,
			currentRubric = activeRubricResult && "rubric" in activeRubricResult
				? activeRubricResult.rubric
				: null,
			rubricError = activeRubricResult && "error" in activeRubricResult
				? activeRubricResult.error
				: null;
		const latestByJudge = new Map<string, string | null>();
		for (const submission of submissions.results) {
			if (!latestByJudge.has(submission.judge_identity_id)) {
				latestByJudge.set(
					submission.judge_identity_id,
					submission.document_id,
				);
			}
		}
		return json({
			currentDocument: currentDocument ?? null,
			rubric: currentRubric,
			rubricError,
			documentStale: stage === "ANALYSIS" &&
				[...latestByJudge.values()].some(
					(documentId) =>
						documentId !== (currentDocument?.id ?? null),
				),
			drafts: drafts.results.map(decode),
			draft: judgeId
				? (drafts.results[0] ? decode(drafts.results[0]) : null)
				: null,
			submissions: submissions.results.map(decode),
		});
	}
	if (path !== "" || request.method !== "POST") {
		return json({ error: "NOT_FOUND" }, 404);
	}
	if (session.role !== "judge" || !session.identity_id) {
		return json({ error: "JUDGE_REQUIRED" }, 403);
	}
	let data: z.infer<typeof reviewInput>;
	try {
		data = reviewInput.parse(await input(request));
	} catch (error) {
		return error instanceof Error && error.message === "BODY_LIMIT"
			? json({ error: "BODY_LIMIT" }, 413)
			: json({ error: "INVALID_INPUT" }, 400);
	}
	if (!(await assigned(db, session.identity_id, data.teamId))) {
		return json({ error: "NOT_FOUND" }, 404);
	}
	if (data.stage === "ENGINEERING") {
		return engineeringReview(db, data, session);
	}
	if (
		(data.action === "SAVE_DRAFT" || data.action === "REVISE") &&
		(data.score === undefined || !data.feedback || !data.documentId)
	) {
		return json({ error: "ANALYSIS_REVIEW_REQUIRED" }, 400);
	}
	if (data.action === "REVISE" && !data.reason) {
		return json({ error: "REVISION_REASON_REQUIRED" }, 400);
	}
	if (data.action === "SUBMIT") {
		const draft = await db
			.prepare(
				"SELECT score,payload,document_id FROM round_two_review_drafts WHERE team_id=? AND judge_identity_id=? AND stage='ANALYSIS'",
			)
			.bind(data.teamId, session.identity_id)
			.first<{
				score: number | null;
				payload: string;
				document_id: string | null;
			}>();
		if (!draft || draft.score === null || !draft.document_id) {
			return json({ error: "ANALYSIS_DRAFT_REQUIRED" }, 409);
		}
		const id = crypto.randomUUID(),
			actor = "judge:" + session.identity_id,
			results = await db.batch([
				db
					.prepare(
						"INSERT OR IGNORE INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason) SELECT ?,?,?, 'ANALYSIS',1,?,?,?,'Initial submission' WHERE EXISTS(SELECT 1 FROM round_two_judge_assignments WHERE judge_identity_id=? AND team_id=? AND revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM round_two_review_submissions WHERE team_id=? AND judge_identity_id=? AND stage='ANALYSIS')",
					)
					.bind(
						id,
						data.teamId,
						session.identity_id,
						draft.score,
						draft.payload,
						draft.document_id,
						session.identity_id,
						data.teamId,
						data.teamId,
						session.identity_id,
					),
				db
					.prepare(
						"DELETE FROM round_two_review_drafts WHERE team_id=? AND judge_identity_id=? AND stage='ANALYSIS' AND changes()=1",
					)
					.bind(data.teamId, session.identity_id),
				db
					.prepare(
						"INSERT INTO audit(action,entity,actor,changes) SELECT 'review.submitted',?,?,? WHERE changes()=1",
					)
					.bind(
						data.teamId + ":" + session.identity_id + ":ANALYSIS",
						actor,
						JSON.stringify({
							score: draft.score,
							documentId: draft.document_id,
						}),
					),
			]);
		if (!results[0]?.meta.changes) {
			return json({ error: "REVIEW_ALREADY_SUBMITTED" }, 409);
		}
		return json({ id, revision: 1, status: "FINAL" }, 201);
	}
	const document = await db
		.prepare(
			"SELECT id FROM team_documents WHERE id=? AND team_id=? AND status='STORED'",
		)
		.bind(data.documentId, data.teamId)
		.first<{ id: string }>();
	if (!document) return json({ error: "DOCUMENT_REQUIRED" }, 409);
	const actor = "judge:" + session.identity_id;
	if (data.action === "SAVE_DRAFT") {
		const id = await db
			.prepare(
				"INSERT INTO round_two_review_drafts(team_id,judge_identity_id,stage,score,payload,document_id) SELECT ?,?,'ANALYSIS',?,?,? WHERE EXISTS(SELECT 1 FROM round_two_judge_assignments WHERE judge_identity_id=? AND team_id=? AND revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM round_two_review_submissions WHERE team_id=? AND judge_identity_id=? AND stage='ANALYSIS') ON CONFLICT(team_id,judge_identity_id,stage) DO UPDATE SET score=excluded.score,payload=excluded.payload,document_id=excluded.document_id,updated_at=CURRENT_TIMESTAMP WHERE NOT EXISTS(SELECT 1 FROM round_two_review_submissions WHERE team_id=excluded.team_id AND judge_identity_id=excluded.judge_identity_id AND stage='ANALYSIS') RETURNING team_id",
			)
			.bind(
				data.teamId,
				session.identity_id,
				data.score!,
				JSON.stringify(data.feedback),
				data.documentId,
				session.identity_id,
				data.teamId,
				data.teamId,
				session.identity_id,
			)
			.first<{ team_id: string }>();
		if (!id) return json({ error: "REVIEW_FINAL_LOCKED" }, 409);
		await db
			.prepare(
				"INSERT INTO audit(action,entity,actor,changes) VALUES('review.draft_saved',?,?,?)",
			)
			.bind(
				data.teamId + ":" + session.identity_id + ":ANALYSIS",
				actor,
				JSON.stringify({
					score: data.score,
					documentId: data.documentId,
				}),
			)
			.run();
		return json({ status: "DRAFT_SAVED" });
	}
	const previous = await db
		.prepare(
			"SELECT COALESCE(MAX(revision),0) AS revision FROM round_two_review_submissions WHERE team_id=? AND judge_identity_id=? AND stage='ANALYSIS'",
		)
		.bind(data.teamId, session.identity_id)
		.first<{ revision: number }>();
	if (!previous?.revision) {
		return json({ error: "FINAL_REVIEW_REQUIRED" }, 409);
	}
	const id = crypto.randomUUID(),
		revision = previous.revision + 1,
		results = await db.batch([
			db
				.prepare(
					"INSERT OR IGNORE INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,document_id,reason) SELECT ?,?,?,'ANALYSIS',?,?,?, ?,? WHERE EXISTS(SELECT 1 FROM round_two_judge_assignments WHERE judge_identity_id=? AND team_id=? AND revoked_at IS NULL)",
				)
				.bind(
					id,
					data.teamId,
					session.identity_id,
					revision,
					data.score,
					JSON.stringify(data.feedback),
					data.documentId,
					data.reason,
					session.identity_id,
					data.teamId,
				),
			db
				.prepare(
					"INSERT INTO audit(action,entity,actor,changes) SELECT 'review.revised',?,?,? WHERE changes()=1",
				)
				.bind(
					data.teamId + ":" + session.identity_id + ":ANALYSIS",
					actor,
					JSON.stringify({
						revision,
						score: data.score,
						documentId: data.documentId,
						reason: data.reason,
					}),
				),
		]);
	if (!results[0]?.meta.changes) {
		return json({ error: "REVIEW_REVISION_CONFLICT" }, 409);
	}
	return json({ id, revision, status: "FINAL" }, 201);
}
