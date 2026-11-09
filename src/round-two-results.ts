import { z } from "zod";
import { boundedBody } from "./security";
import type { ConsoleSession } from "./console-identities";
import type { Env } from "./env";
import { calculateTeamScore } from "./round-two-scoring";

const json = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
const snapshotInput = z
	.object({ reason: z.string().trim().min(10).max(1000) })
	.strict();
const publicationInput = z
	.object({
		snapshotId: z.string().uuid().nullable(),
		reason: z.string().trim().min(10).max(1000),
	})
	.strict();

function boundedText(value: string, maxBytes = 512): { text: string; truncated: boolean } {
	const encoder = new TextEncoder();
	if (encoder.encode(value).byteLength <= maxBytes) return { text: value, truncated: false };
	const points = Array.from(value);
	let low = 0, high = points.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (encoder.encode(points.slice(0, middle).join("") + "…").byteLength <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return { text: points.slice(0, low).join("") + "…", truncated: true };
}

function releasedFeedback(raw: string, stage: string): Record<string, unknown> | null {
	let payload: unknown;
	try { payload = JSON.parse(raw); } catch { return null; }
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const data = payload as Record<string, unknown>;
	let truncated = false;
	const text = (key: string) => {
		if (typeof data[key] !== "string") return "";
		const result = boundedText((data[key] as string).trim());
		truncated ||= result.truncated;
		return result.text;
	};
	if (stage === "ANALYSIS") {
		const feedback = {
			problemUnderstanding: text("problemUnderstanding"),
			remediation: text("remediation"),
			innovationImpact: text("innovationImpact"),
			overall: text("overall"),
		};
		return Object.values(feedback).some(Boolean) ? { ...feedback, truncated } : null;
	}
	const sourceCriteria = Array.isArray(data.criteriaScores) ? data.criteriaScores : [];
	if (sourceCriteria.length > 12) truncated = true;
	const criteriaScores = sourceCriteria.slice(0, 12).flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>;
		if (typeof row.criterionId !== "string" || typeof row.comment !== "string" || !row.comment.trim()) return [];
		const criterionId = boundedText(row.criterionId, 80), comment = boundedText(row.comment.trim());
		truncated ||= criterionId.truncated || comment.truncated;
		return [{ criterionId: criterionId.text, comment: comment.text }];
	});
	const feedback = { overall: text("overall"), criteriaScores };
	return feedback.overall || criteriaScores.length ? { ...feedback, truncated } : null;
}

const MAX_FEEDBACK_BYTES = 512 * 1024;
const MAX_TEAM_FEEDBACK_BYTES = 8 * 1024;

function fitTeamFeedback(
	input: { analysis: Array<Record<string, unknown>>; engineering: Array<Record<string, unknown>>; truncated: boolean },
	byteLimit: number,
) {
	const output: { analysis: Array<Record<string, unknown>>; engineering: Array<Record<string, unknown>> } = { analysis: [], engineering: [] };
	let truncated = input.truncated, stopped = false;
	for (const stage of ["analysis", "engineering"] as const) {
		for (const item of input[stage]) {
			const { truncated: itemTruncated, ...safeItem } = item;
			if (itemTruncated === true) truncated = true;
			const candidate = { ...output, [stage]: [...output[stage], safeItem] };
			if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > byteLimit) {
				truncated = true;
				stopped = true;
				break;
			}
			output[stage].push(safeItem);
		}
		if (stopped) break;
	}
	const hasFeedback = output.analysis.length > 0 || output.engineering.length > 0;
	return {
		...(hasFeedback ? { feedback: output } : {}),
		feedbackTruncated: truncated,
		bytes: hasFeedback ? new TextEncoder().encode(JSON.stringify(output)).byteLength : 0,
	};
}

async function aggregateResults(db: D1Database) {
	const [teams, reviews, repositories] = await db.batch([
		db
			.prepare(
				"SELECT id,name,status FROM teams WHERE hackathon_id='initial' AND status='ACTIVE' ORDER BY name LIMIT 500",
			),
		db
			.prepare(
				"SELECT s.id,s.team_id,s.judge_identity_id,s.stage,s.revision,s.score,s.payload,s.rubric_version_id,rv.repository_id AS rubric_repository_id FROM round_two_review_submissions s LEFT JOIN round_two_repository_rubric_versions rv ON rv.id=s.rubric_version_id WHERE s.revision=(SELECT MAX(latest.revision) FROM round_two_review_submissions latest WHERE latest.team_id=s.team_id AND latest.judge_identity_id=s.judge_identity_id AND latest.stage=s.stage) AND EXISTS(SELECT 1 FROM teams t WHERE t.id=s.team_id AND t.hackathon_id='initial' AND t.status='ACTIVE') ORDER BY s.team_id,s.stage,s.judge_identity_id",
			),
		db
			.prepare(
				"SELECT tr.team_id,tr.repository_id,r.full_name FROM team_repositories tr JOIN github_repositories r ON r.id=tr.repository_id WHERE tr.active=1",
			),
	]);
	if (!teams || !reviews || !repositories) {
		throw new Error("D1 batch returned incomplete result inputs");
	}
	const scores = new Map<
			string,
			{ analysis: number[]; engineering: number[] }
		>(),
		feedback = new Map<string, { analysis: Array<Record<string, unknown>>; engineering: Array<Record<string, unknown>>; truncated: boolean }>(),
		track = new Map<string, {
			repositoryId: number;
			fullName: string;
		}[]>();
	const reviewSources: Array<{
		teamId: string;
		stage: string;
		judgeIdentityId: string;
		reviewId: string;
	}> = [];
	for (
		const team of teams.results as {
			id: string;
			name: string;
			status: string;
		}[]
	) {
		scores.set(team.id, { analysis: [], engineering: [] });
		feedback.set(team.id, { analysis: [], engineering: [], truncated: false });
	}
	for (
		const repository of repositories.results as {
			team_id: string;
			repository_id: number;
			full_name: string;
		}[]
	) {
		const selected = track.get(repository.team_id) ?? [];
		selected.push({
			repositoryId: repository.repository_id,
			fullName: repository.full_name,
		});
		track.set(repository.team_id, selected);
	}
	for (
		const review of reviews.results as {
			id: string;
			team_id: string;
			judge_identity_id: string;
			stage: string;
			revision: number;
			score: number;
			payload: string;
			rubric_version_id: string | null;
			rubric_repository_id: number | null;
		}[]
	) {
		const current = scores.get(review.team_id);
		if (!current) continue;
		const safeFeedback = releasedFeedback(review.payload, review.stage),
			teamFeedback = feedback.get(review.team_id);
		if (review.stage === "ANALYSIS") {
			current.analysis.push(review.score);
			reviewSources.push({
				teamId: review.team_id,
				stage: review.stage,
				judgeIdentityId: review.judge_identity_id,
				reviewId: review.id,
			});
			if (safeFeedback && teamFeedback) teamFeedback.analysis.push(safeFeedback);
		}
		else if (review.stage === "ENGINEERING") {
			const selected = track.get(review.team_id) ?? [];
			if (selected.length !== 1) continue;
			if (review.rubric_repository_id !== selected[0]!.repositoryId) {
				continue;
			}
			current.engineering.push(review.score);
			reviewSources.push({
				teamId: review.team_id,
				stage: review.stage,
				judgeIdentityId: review.judge_identity_id,
				reviewId: review.id,
			});
			if (safeFeedback && teamFeedback) teamFeedback.engineering.push(safeFeedback);
		}
	}
	let remainingFeedbackBytes = MAX_FEEDBACK_BYTES;
	const results = (teams.results as {
		id: string;
		name: string;
		status: string;
	}[]).map((team) => {
		const current = scores.get(team.id) ?? {
				analysis: [],
				engineering: [],
			},
			calculated = calculateTeamScore(
				current.analysis,
				current.engineering,
			),
				repositories = track.get(team.id) ?? [],
			teamFeedback = feedback.get(team.id) ?? { analysis: [], engineering: [], truncated: false },
			boundedFeedback = fitTeamFeedback(
				teamFeedback,
				Math.max(0, Math.min(MAX_TEAM_FEEDBACK_BYTES, remainingFeedbackBytes)),
			);
		remainingFeedbackBytes -= boundedFeedback.bytes;
		return {
			teamId: team.id,
			teamName: team.name,
			track: repositories.length === 1 ? repositories[0]!.fullName : null,
			repositorySelection: repositories.length === 0
				? "NOT_SELECTED"
				: repositories.length === 1
				? "SELECTED"
				: "CONFLICT",
			analysisAverage: calculated.analysisAverage,
			analysisJudgeCount: current.analysis.length,
			engineeringAverage: calculated.engineeringAverage,
			engineeringJudgeCount: current.engineering.length,
			status: calculated.status,
			finalScore: calculated.finalScore,
			...(boundedFeedback.feedback ? { feedback: boundedFeedback.feedback } : {}),
			...(boundedFeedback.feedbackTruncated ? { feedbackTruncated: true } : {}),
		};
	});
	return {
		teams: results.length,
		completed: results.filter((result) => result.status === "READY").length,
		pending: results.filter((result) => result.status === "PENDING").length,
		results,
		reviewSources,
	};
}

function rankingEntry<T extends Record<string, unknown>>(team: T, rank: number) {
	const { feedback: _feedback, feedbackTruncated: _feedbackTruncated, ...scores } = team;
	return { ...scores, rank };
}

async function publication(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT p.snapshot_id,p.updated_by,p.published_at,p.updated_at,s.snapshot FROM round_two_result_publication p LEFT JOIN round_two_result_snapshots s ON s.id=p.snapshot_id WHERE p.id=1",
		)
		.first<{
			snapshot_id: string | null;
			updated_by: string;
			published_at: string | null;
			updated_at: string;
			snapshot: string | null;
		}>();
	if (!row) return null;
	return {
		snapshotId: row.snapshot_id,
		published: row.snapshot_id !== null,
		updatedBy: row.updated_by,
		publishedAt: row.published_at,
		updatedAt: row.updated_at,
		snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
	};
}

async function frozenSnapshot(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT f.snapshot_id,s.snapshot,f.frozen_by,f.frozen_at FROM round_two_result_freeze f JOIN round_two_result_snapshots s ON s.id=f.snapshot_id WHERE f.id=1",
		)
		.first<{
			snapshot_id: string;
			snapshot: string;
			frozen_by: string;
			frozen_at: string;
		}>();
	return row
		? {
			snapshotId: row.snapshot_id,
			snapshot: JSON.parse(row.snapshot),
			frozenBy: row.frozen_by,
			frozenAt: row.frozen_at,
		}
		: null;
}

async function createSnapshot(
	request: Request,
	db: D1Database,
	session: ConsoleSession,
) {
	let data: z.infer<typeof snapshotInput>;
	try {
		data = snapshotInput.parse(
			JSON.parse(
				new TextDecoder().decode(await boundedBody(request, 5000)),
			),
		);
	} catch {
		return json({ error: "INVALID_INPUT" }, 400);
	}
	const results = await aggregateResults(db),
		ready = results.results
			.filter((result) =>
				result.status === "READY" && result.finalScore !== null
			)
			.sort(
				(a, b) =>
					(b.finalScore ?? 0) - (a.finalScore ?? 0) ||
					a.teamName.localeCompare(b.teamName),
			);
	let rank = 0,
		previousScore: number | null = null;
	const ranking = ready.map((team, index) => {
		if (team.finalScore !== previousScore) rank = index + 1;
		previousScore = team.finalScore;
		return rankingEntry(team, rank);
	});
	const snapshot = { ...results, ranking },
		id = crypto.randomUUID(),
		actor = "organizer:" + (session.identity_id ?? session.hash);
	await db.batch([
		db
			.prepare(
				"INSERT INTO round_two_result_snapshots(id,snapshot,created_by) VALUES(?,?,?)",
			)
			.bind(id, JSON.stringify(snapshot), actor),
		db
			.prepare(
				"INSERT INTO audit(action,entity,actor,changes) VALUES('round_two.results.snapshot_created',?,?,?)",
			)
			.bind(id, actor, JSON.stringify({ reason: data.reason })),
	]);
	return json(
		{ id, snapshot, createdBy: actor, createdAt: new Date().toISOString() },
		201,
	);
}

async function exportSnapshot(db: D1Database, snapshotId: string) {
	const row = await db
		.prepare("SELECT snapshot FROM round_two_result_snapshots WHERE id=?")
		.bind(snapshotId)
		.first<{ snapshot: string }>();
	if (!row) return json({ error: "NOT_FOUND" }, 404);
	const snapshot = JSON.parse(row.snapshot) as {
		results?: {
			teamId: string;
				teamName: string;
			track: string | null;
			repositorySelection: string;
			analysisAverage: number | null;
			analysisJudgeCount: number;
			engineeringAverage: number | null;
			engineeringJudgeCount: number;
			status: string;
			finalScore: number | null;
		}[];
		ranking?: { teamId: string; rank: number }[];
	};
	const ranks = new Map(
		(snapshot.ranking ?? []).map((team) => [team.teamId, team.rank]),
	);
	const fields = [
		"teamId",
		"teamName",
		"track",
		"repositorySelection",
		"analysisAverage",
		"analysisJudgeCount",
		"engineeringAverage",
		"engineeringJudgeCount",
		"status",
		"finalScore",
		"rank",
	];
	const csvField = (value: unknown) =>
		'"' + (value === null || value === undefined ? "" : String(value))
			.replaceAll('"', '""') +
		'"';
	const csv = [
		fields.map(csvField).join(","),
		...(snapshot.results ?? []).map((team) =>
			[
				team.teamId,
				team.teamName,
				team.track,
				team.repositorySelection,
				team.analysisAverage,
				team.analysisJudgeCount,
				team.engineeringAverage,
				team.engineeringJudgeCount,
				team.status,
				team.finalScore,
				ranks.get(team.teamId) ?? null,
			].map(csvField).join(",")
		),
	].join("\r\n") + "\r\n";
	return new Response(csv, {
		headers: {
			"cache-control": "no-store",
			"content-disposition":
				`attachment; filename="round-two-results-${snapshotId}.csv"`,
			"content-type": "text/csv; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

async function listSnapshots(db: D1Database) {
	const rows = await db
		.prepare(
			"SELECT id,snapshot,created_by,created_at FROM round_two_result_snapshots ORDER BY created_at DESC,id DESC LIMIT 50",
		)
		.all<{
			id: string;
			snapshot: string;
			created_by: string;
			created_at: string;
		}>();
	return json({
		snapshots: rows.results.map((row) => ({
			id: row.id,
			snapshot: JSON.parse(row.snapshot),
			createdBy: row.created_by,
			createdAt: row.created_at,
		})),
	});
}

async function setPublication(
	request: Request,
	db: D1Database,
	session: ConsoleSession,
) {
	let data: z.infer<typeof publicationInput>;
	try {
		data = publicationInput.parse(
			JSON.parse(
				new TextDecoder().decode(await boundedBody(request, 5000)),
			),
		);
	} catch {
		return json({ error: "INVALID_INPUT" }, 400);
	}
	const actor = "organizer:" + (session.identity_id ?? session.hash),
		current = await db
			.prepare(
				"SELECT snapshot_id FROM round_two_result_publication WHERE id=1",
			)
			.first<{ snapshot_id: string | null }>();
	if (data.snapshotId === null) {
		if (!current?.snapshot_id) {
			return json({ error: "RESULTS_NOT_PUBLISHED" }, 409);
		}
	} else {
		const selected = await db
			.prepare(
				"SELECT snapshot FROM round_two_result_snapshots WHERE id=?",
			)
			.bind(data.snapshotId)
			.first<{ snapshot: string }>();
		if (!selected) return json({ error: "SNAPSHOT_NOT_FOUND" }, 404);
		const snapshot = JSON.parse(selected.snapshot) as {
			teams: number;
			completed: number;
			pending: number;
		};
		if (
			snapshot.pending !== 0 ||
			snapshot.completed !== snapshot.teams
		) {
			return json({ error: "INCOMPLETE_RESULTS" }, 409);
		}
		if (current?.snapshot_id === data.snapshotId) {
			return json({
				published: true,
				snapshotId: data.snapshotId,
				unchanged: true,
			});
		}
	}
	const action = data.snapshotId ? "PUBLISHED" : "WITHDRAWN",
		eventSnapshotId = data.snapshotId ?? current?.snapshot_id ?? null,
		eventId = crypto.randomUUID();
	await db.batch([
		db
			.prepare(
				"INSERT INTO round_two_result_publication(id,snapshot_id,updated_by,published_at) VALUES(1,?,?,CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END) ON CONFLICT(id) DO UPDATE SET snapshot_id=excluded.snapshot_id,updated_by=excluded.updated_by,published_at=excluded.published_at,updated_at=CURRENT_TIMESTAMP",
			)
			.bind(data.snapshotId, actor, data.snapshotId),
		db
			.prepare(
				"INSERT INTO round_two_result_publication_history(id,snapshot_id,action,actor,reason) VALUES(?,?,?,?,?)",
			)
			.bind(eventId, eventSnapshotId, action, actor, data.reason),
		db
			.prepare(
				"INSERT INTO audit(action,entity,actor,changes) VALUES(?,?,?,?)",
			)
			.bind(
				"round_two.results." +
					(data.snapshotId ? "published" : "withdrawn"),
				eventId,
				actor,
				JSON.stringify({
					snapshotId: eventSnapshotId,
					reason: data.reason,
				}),
			),
	]);
	return json({
		published: data.snapshotId !== null,
		snapshotId: data.snapshotId,
	});
}

async function setFreeze(
	request: Request,
	db: D1Database,
	session: ConsoleSession,
	freeze: boolean,
) {
	let data: z.infer<typeof snapshotInput>;
	try {
		data = snapshotInput.parse(
			JSON.parse(
				new TextDecoder().decode(await boundedBody(request, 5000)),
			),
		);
	} catch {
		return json({ error: "INVALID_INPUT" }, 400);
	}
	const actor = "organizer:" + (session.identity_id ?? session.hash),
		current = await frozenSnapshot(db);
	if (freeze && current) {
		return json({
			frozen: true,
			snapshotId: current.snapshotId,
			unchanged: true,
		});
	}
	if (!freeze && !current) return json({ error: "RESULTS_NOT_FROZEN" }, 409);
	let snapshotId: string;
	if (freeze) {
		const results = await aggregateResults(db),
			ready = results.results
				.filter((result) =>
					result.status === "READY" && result.finalScore !== null
				)
				.sort(
					(a, b) =>
						(b.finalScore ?? 0) - (a.finalScore ?? 0) ||
						a.teamName.localeCompare(b.teamName),
				);
		let rank = 0,
			previousScore: number | null = null;
		const ranking = ready.map((team, index) => {
			if (team.finalScore !== previousScore) rank = index + 1;
			previousScore = team.finalScore;
			return rankingEntry(team, rank);
		});
		const snapshot = { ...results, ranking };
		snapshotId = crypto.randomUUID();
		const eventId = crypto.randomUUID();
		const transition = await db.batch([
			db.prepare(
				"INSERT INTO round_two_result_snapshots(id,snapshot,created_by) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM round_two_result_freeze WHERE id=1)",
			).bind(snapshotId, JSON.stringify(snapshot), actor),
			db.prepare(
				"INSERT INTO round_two_result_freeze(id,snapshot_id,frozen_by) SELECT 1,?,? WHERE NOT EXISTS(SELECT 1 FROM round_two_result_freeze WHERE id=1)",
			).bind(snapshotId, actor),
			db.prepare(
				"INSERT INTO round_two_result_freeze_history(id,snapshot_id,action,actor,reason) SELECT ?,?,'FROZEN',?,? WHERE changes()=1",
			).bind(eventId, snapshotId, actor, data.reason),
			db.prepare(
				"INSERT INTO audit(action,entity,actor,changes) SELECT 'round_two.results.frozen',?,?,? WHERE EXISTS(SELECT 1 FROM round_two_result_freeze_history WHERE id=?)",
			).bind(
				eventId,
				actor,
				JSON.stringify({ snapshotId, reason: data.reason }),
				eventId,
			),
		]);
		if (transition[1]?.meta.changes !== 1) {
			const latest = await frozenSnapshot(db);
			return latest
				? json({
					frozen: true,
					snapshotId: latest.snapshotId,
					unchanged: true,
				})
				: json({ error: "RESULTS_NOT_FROZEN" }, 409);
		}
	} else {
		snapshotId = current!.snapshotId;
		const eventId = crypto.randomUUID();
		const transition = await db.batch([
			db.prepare(
				"DELETE FROM round_two_result_freeze WHERE id=1 AND snapshot_id=?",
			).bind(snapshotId),
			db.prepare(
				"INSERT INTO round_two_result_freeze_history(id,snapshot_id,action,actor,reason) SELECT ?,?,'UNFROZEN',?,? WHERE changes()=1",
			).bind(eventId, snapshotId, actor, data.reason),
			db.prepare(
				"INSERT INTO audit(action,entity,actor,changes) SELECT 'round_two.results.unfrozen',?,?,? WHERE EXISTS(SELECT 1 FROM round_two_result_freeze_history WHERE id=?)",
			).bind(
				eventId,
				actor,
				JSON.stringify({ snapshotId, reason: data.reason }),
				eventId,
			),
		]);
		if (transition[0]?.meta.changes !== 1) {
			return json({ error: "RESULTS_NOT_FROZEN" }, 409);
		}
	}
	return json({ frozen: freeze, snapshotId });
}

export async function roundTwoResults(
	request: Request,
	env: Env,
	session: ConsoleSession,
) {
	if (session.role !== "organizer") {
		return json({ error: "ORGANIZER_REQUIRED" }, 403);
	}
	const db = env.ORG_DB;
	if (!db) return json({ error: "ORGANIZATION_NOT_CONFIGURED" }, 503);
	const path = new URL(request.url).pathname;
	const exportMatch = path.match(
		/\/results\/snapshots\/([^/]+)\/export$/,
	);
	if (exportMatch) {
		if (request.method !== "GET") {
			return json({ error: "METHOD_NOT_ALLOWED" }, 405);
		}
		return exportSnapshot(db, exportMatch[1]!);
	}
	if (path.endsWith("/results/snapshots")) {
		if (request.method === "GET") return listSnapshots(db);
		if (request.method === "POST") {
			return createSnapshot(request, db, session);
		}
		return json({ error: "METHOD_NOT_ALLOWED" }, 405);
	}
	if (path.endsWith("/results/publication")) {
		if (request.method === "GET") {
			return json({ publication: await publication(db) });
		}
		if (request.method === "POST") {
			return setPublication(request, db, session);
		}
		return json({ error: "METHOD_NOT_ALLOWED" }, 405);
	}
	if (path.endsWith("/results/freeze")) {
		if (request.method === "POST") {
			return setFreeze(request, db, session, true);
		}
		if (request.method === "DELETE") {
			return setFreeze(request, db, session, false);
		}
		return json({ error: "METHOD_NOT_ALLOWED" }, 405);
	}
	if (!path.endsWith("/results") || request.method !== "GET") {
		return json({ error: "NOT_FOUND" }, 404);
	}
	const frozen = await frozenSnapshot(db);
	return frozen
		? json({
			...frozen.snapshot,
			frozen: true,
			freeze: frozen,
			publication: await publication(db),
		})
		: json({
			...(await aggregateResults(db)),
			frozen: false,
			freeze: null,
			publication: await publication(db),
		});
}
