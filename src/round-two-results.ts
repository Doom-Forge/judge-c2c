import { z } from "zod";
import { boundedBody } from "./security";
import type { ConsoleSession } from "./console-identities";
import type { Env } from "./env";
import { calculateTeamScore } from "./round-two-scoring";
import { competitionRepositoriesFor } from "./organization-selection";

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
const finalScoreInput = z.object({
	teamId: z.string().min(1).max(80),
	score: z.number().finite().min(0).max(100),
	reason: z.string().trim().min(10).max(1000),
}).strict();

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

async function aggregateResults(db: D1Database, env: Env) {
	const activeTracks = competitionRepositoriesFor(env);
	const [teams, reviews, repositories, finalScores, unverifiedPullRequests] = await db.batch([
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
				"SELECT tr.team_id,current.id AS repository_id,current.full_name FROM team_repositories tr JOIN github_repositories selected ON selected.id=tr.repository_id JOIN github_repositories current ON current.accessible=1 AND current.full_name IN(?,?,?,?) AND substr(current.full_name,instr(current.full_name,'/'))=substr(selected.full_name,instr(selected.full_name,'/')) WHERE tr.active=1",
			).bind(...activeTracks),
		db.prepare(
			"SELECT team_id,score,judge_identity_id,reason,created_at FROM round_two_team_final_scores",
		),
		db.prepare(
			"SELECT u.team_id,count(*) AS pull_request_count FROM unverified_pr_submissions u JOIN github_repositories r ON r.id=u.repository_id WHERE u.team_id IS NOT NULL AND r.full_name IN(?,?,?,?) GROUP BY u.team_id",
		).bind(...activeTracks),
	]);
	if (!teams || !reviews || !repositories || !finalScores || !unverifiedPullRequests) {
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
	const officialScores = new Map((finalScores.results as {
		team_id: string; score: number; judge_identity_id: string; reason: string; created_at: string;
	}[]).map((item) => [item.team_id, item]));
	const unverifiedCounts = new Map((unverifiedPullRequests.results as {
		team_id: string; pull_request_count: number;
	}[]).map((item) => [item.team_id, item.pull_request_count]));
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
		const official = officialScores.get(team.id);
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
			status: official ? "READY" : "PENDING",
			manualAggregateScore: calculated.finalScore,
			finalScore: official?.score ?? null,
			finalScoreBy: official?.judge_identity_id ?? null,
			finalScoreAt: official?.created_at ?? null,
			finalScoreReason: official?.reason ?? null,
			automatedEvidence: {
				status: "UNVERIFIED",
				marks: null,
				pullRequestCount: unverifiedCounts.get(team.id) ?? 0,
			},
			...(boundedFeedback.feedback ? { feedback: boundedFeedback.feedback } : {}),
			...(boundedFeedback.feedbackTruncated ? { feedbackTruncated: true } : {}),
		};
	});
	return {
		teams: results.length,
		completed: results.filter((result) => result.finalScore !== null).length,
		pending: results.filter((result) => result.finalScore === null).length,
		scoreSource: "EXPLICIT_JUDGE",
		results,
		reviewSources,
	};
}

async function finalScoreContext(db: D1Database, teamId: string, env: Env) {
	const activeTracks = competitionRepositoriesFor(env);
	const [team, reviews, prs, score] = await db.batch([
		db.prepare("SELECT id,name FROM teams WHERE id=? AND hackathon_id='initial' AND status='ACTIVE'").bind(teamId),
		db.prepare("SELECT s.stage,count(*) AS review_count,round(avg(s.score),1) AS average FROM round_two_review_submissions s LEFT JOIN round_two_repository_rubric_versions rv ON rv.id=s.rubric_version_id WHERE s.team_id=? AND s.revision=(SELECT max(latest.revision) FROM round_two_review_submissions latest WHERE latest.team_id=s.team_id AND latest.judge_identity_id=s.judge_identity_id AND latest.stage=s.stage) AND (s.stage<>'ENGINEERING' OR EXISTS(SELECT 1 FROM team_repositories tr JOIN github_repositories selected ON selected.id=tr.repository_id JOIN github_repositories current ON current.id=rv.repository_id AND current.accessible=1 AND current.full_name IN(?,?,?,?) AND substr(current.full_name,instr(current.full_name,'/'))=substr(selected.full_name,instr(selected.full_name,'/')) WHERE tr.team_id=s.team_id AND tr.active=1)) GROUP BY s.stage").bind(teamId, ...activeTracks),
		db.prepare("SELECT u.repository_id,u.pr_number,u.head_sha,u.author_login,u.github_updated_at,u.closed,r.full_name FROM unverified_pr_submissions u JOIN github_repositories r ON r.id=u.repository_id AND r.full_name IN(?,?,?,?) JOIN team_repositories tr ON tr.team_id=u.team_id AND tr.active=1 JOIN github_repositories selected ON selected.id=tr.repository_id AND substr(selected.full_name,instr(selected.full_name,'/'))=substr(r.full_name,instr(r.full_name,'/')) WHERE u.team_id=? ORDER BY u.github_updated_at DESC,u.repository_id,u.pr_number LIMIT 100").bind(...activeTracks, teamId),
		db.prepare("SELECT team_id,score,judge_identity_id,reason,created_at FROM round_two_team_final_scores WHERE team_id=?").bind(teamId),
	]);
	if (!team || !reviews || !prs || !score) return null;
	const teamRow = team.results[0] as { id: string; name: string } | undefined;
	if (!teamRow) return null;
	const byStage = Object.fromEntries((reviews.results as { stage: string; review_count: number; average: number | null }[]).map((row) => [row.stage, { reviewCount: row.review_count, average: row.average }]));
	const engineering = byStage.ENGINEERING ?? { reviewCount: 0, average: null };
	const latestScore = score.results[0] as { team_id: string; score: number; judge_identity_id: string; reason: string; created_at: string } | undefined;
	const pullRequests = (prs.results as { repository_id: number; pr_number: number; head_sha: string; author_login: string; github_updated_at: string; closed: number; full_name: string }[]).map((pr) => ({
		repositoryId: pr.repository_id,
		repository: pr.full_name,
		prNumber: pr.pr_number,
		headSha: pr.head_sha,
		authorLogin: pr.author_login,
		updatedAt: pr.github_updated_at,
		closed: pr.closed === 1,
		evaluationStatus: "UNVERIFIED" as const,
		marks: null,
		categories: ["Functional correctness", "Security", "Performance and scalability", "Code quality", "Innovation and usefulness", "Reproducibility"].map((category) => ({ category, status: "UNVERIFIED" as const, score: null })),
	}));
	return {
		team: teamRow,
		manualReviews: {
			analysis: byStage.ANALYSIS ?? { reviewCount: 0, average: null },
			engineering,
		},
		machineEvidence: { status: "UNVERIFIED" as const, marks: null, pullRequests },
		finalScore: latestScore ? { score: latestScore.score, judgeIdentityId: latestScore.judge_identity_id, reason: latestScore.reason, createdAt: latestScore.created_at } : null,
		canFinalize: !latestScore && engineering.reviewCount > 0,
	};
}

async function explicitTeamFinalScore(request: Request, db: D1Database, env: Env, session: ConsoleSession) {
	const url = new URL(request.url);
	if (request.method === "GET") {
		if (session.role !== "judge" || !session.identity_id) return json({ error: "JUDGE_REQUIRED" }, 403);
		const teamId = url.searchParams.get("teamId");
		if (!teamId || teamId.length > 80) return json({ error: "INVALID_FINAL_SCORE_SCOPE" }, 400);
		const assignment = await db.prepare("SELECT a.id FROM round_two_judge_assignments a JOIN teams t ON t.id=a.team_id WHERE a.judge_identity_id=? AND a.team_id=? AND a.revoked_at IS NULL AND t.status='ACTIVE' AND t.hackathon_id='initial'").bind(session.identity_id, teamId).first();
		if (!assignment) return json({ error: "NOT_FOUND" }, 404);
		const context = await finalScoreContext(db, teamId, env);
		return context ? json(context) : json({ error: "NOT_FOUND" }, 404);
	}
	if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
	if (session.role !== "judge" || !session.identity_id) return json({ error: "JUDGE_REQUIRED" }, 403);
	let data: z.infer<typeof finalScoreInput>;
	try { data = finalScoreInput.parse(JSON.parse(new TextDecoder().decode(await boundedBody(request, 5000)))); }
	catch { return json({ error: "INVALID_INPUT" }, 400); }
	const assignment = await db.prepare("SELECT a.id FROM round_two_judge_assignments a JOIN teams t ON t.id=a.team_id WHERE a.judge_identity_id=? AND a.team_id=? AND a.revoked_at IS NULL AND t.status='ACTIVE' AND t.hackathon_id='initial'").bind(session.identity_id, data.teamId).first();
	if (!assignment) return json({ error: "NOT_FOUND" }, 404);
	const context = await finalScoreContext(db, data.teamId, env);
	if (!context) return json({ error: "NOT_FOUND" }, 404);
	if (context.finalScore) return json({ error: "FINAL_SCORE_ALREADY_SET", finalScore: context.finalScore }, 409);
	if (!context.manualReviews.engineering.reviewCount) return json({ error: "ENGINEERING_REVIEW_REQUIRED" }, 409);
	const evidenceSummary = {
		manualReviews: context.manualReviews,
		machineEvidence: { status: context.machineEvidence.status, marks: null, pullRequestCount: context.machineEvidence.pullRequests.length },
	};
	const actor = "judge:" + session.identity_id;
	const changes = await db.batch([
		db.prepare("INSERT INTO round_two_team_final_scores(team_id,judge_identity_id,score,reason,evidence_summary) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM round_two_judge_assignments a JOIN teams t ON t.id=a.team_id WHERE a.judge_identity_id=? AND a.team_id=? AND a.revoked_at IS NULL AND t.status='ACTIVE' AND t.hackathon_id='initial') AND EXISTS(SELECT 1 FROM round_two_review_submissions s WHERE s.team_id=? AND s.stage='ENGINEERING') AND NOT EXISTS(SELECT 1 FROM round_two_team_final_scores WHERE team_id=?)").bind(data.teamId, session.identity_id, data.score, data.reason, JSON.stringify(evidenceSummary), session.identity_id, data.teamId, data.teamId, data.teamId),
		db.prepare("INSERT INTO audit(action,entity,actor,changes) SELECT 'round_two.team_final_score.set',?,?,? WHERE changes()=1").bind(data.teamId, actor, JSON.stringify({ score: data.score, reason: data.reason, evidenceSummary })),
	]);
	if (!changes[0]?.meta.changes) {
		const latest = await finalScoreContext(db, data.teamId, env);
		return latest?.finalScore ? json({ error: "FINAL_SCORE_ALREADY_SET", finalScore: latest.finalScore }, 409) : json({ error: "ENGINEERING_REVIEW_REQUIRED" }, 409);
	}
	return json({ teamId: data.teamId, finalScore: { score: data.score, judgeIdentityId: session.identity_id, reason: data.reason, createdAt: new Date().toISOString() } }, 201);
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
	env: Env,
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
	const results = await aggregateResults(db, env);
	if (results.pending > 0) return json({ error: "FINAL_SCORES_REQUIRED", pendingTeams: results.pending }, 409);
	const ready = results.results
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
	const snapshot = { ...results, ranking, scoreSource: "EXPLICIT_JUDGE" },
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
			manualAggregateScore?: number | null;
			automatedEvidence?: { status: string; marks: number | null };
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
		"manualAggregateScore",
		"automatedEvidenceStatus",
		"automatedMarks",
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
				team.manualAggregateScore,
				team.automatedEvidence?.status ?? "UNVERIFIED",
				team.automatedEvidence?.marks ?? null,
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
			scoreSource?: string;
		};
		if (snapshot.scoreSource !== "EXPLICIT_JUDGE" && current?.snapshot_id !== data.snapshotId) {
			return json({ error: "EXPLICIT_FINAL_SCORES_REQUIRED" }, 409);
		}
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
	env: Env,
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
		const results = await aggregateResults(db, env);
		if (results.pending > 0) return json({ error: "FINAL_SCORES_REQUIRED", pendingTeams: results.pending }, 409);
		const ready = results.results
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
		const snapshot = { ...results, ranking, scoreSource: "EXPLICIT_JUDGE" };
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
	const db = env.ORG_DB;
	if (!db) return json({ error: "ORGANIZATION_NOT_CONFIGURED" }, 503);
	const path = new URL(request.url).pathname;
	if (path.endsWith("/results/final-score")) return explicitTeamFinalScore(request, db, env, session);
	if (session.role !== "organizer") {
		return json({ error: "ORGANIZER_REQUIRED" }, 403);
	}
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
			return createSnapshot(request, db, env, session);
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
			return setFreeze(request, db, env, session, true);
		}
		if (request.method === "DELETE") {
			return setFreeze(request, db, env, session, false);
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
			...(await aggregateResults(db, env)),
			frozen: false,
			freeze: null,
			publication: await publication(db),
		});
}
