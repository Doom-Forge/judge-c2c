import { z } from "zod";
import { boundedBody } from "./security";
import { roundTwoEvaluations } from "./round-two-evaluations";
import { roundTwoRubrics } from "./round-two-rubrics";
import { roundTwoResults } from "./round-two-results";
import { roundTwoGitHubEvidence, type EvidenceClientFactory } from "./round-two-github";
import type { ConsoleSession } from "./console-identities";
import type { Env } from "./env";

const json = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: { "cache-control": "no-store" },
	});
const assignmentInput = z
	.object({
		judgeIdentityId: z.string().uuid(),
		teamId: z.string().min(1).max(80),
	})
	.strict();
const revocationInput = z
	.object({ reason: z.string().trim().min(10).max(1000) })
	.strict();

async function input(request: Request) {
	return JSON.parse(
		new TextDecoder().decode(await boundedBody(request, 5000)),
	);
}

export async function roundTwoReview(
	request: Request,
	env: Env,
	session: ConsoleSession,
	clientFactory?: EvidenceClientFactory,
) {
	const db = env.ORG_DB;
	if (!db) return json({ error: "ORGANIZATION_NOT_CONFIGURED" }, 503);
	if (session.role !== "organizer" && session.role !== "judge") {
		return json({ error: "REVIEW_ACCESS_REQUIRED" }, 403);
	}
	const path = new URL(request.url).pathname.replace(
		"/api/organization/round-two",
		"",
	);
	if (path === "/results" || path.startsWith("/results/")) {
		return roundTwoResults(request, env, session);
	}
	if (path === "/reviews" || path.startsWith("/reviews/")) {
		return roundTwoEvaluations(request, env, session);
	}
	if (path === "/rubrics") {
		return roundTwoRubrics(request, env, session);
	}
	if (
		request.method === "GET" &&
		/^\/teams\/[\w.-]{1,80}\/pull-requests\/\d{1,12}\/\d{1,12}$/.test(path)
	) {
		return roundTwoGitHubEvidence(request, env, session, clientFactory);
	}
	const documentPath = path.match(
		/^\/teams\/([\w.-]{1,80})\/documents\/([a-f0-9-]{36})$/,
	);
	if (documentPath && request.method === "GET") {
		const [, teamId, documentId] = documentPath;
		if (
			session.role === "judge" &&
			(!session.identity_id ||
				!(await db
					.prepare(
						"SELECT id FROM round_two_judge_assignments WHERE judge_identity_id=? AND team_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM teams WHERE id=? AND hackathon_id='initial' AND status='ACTIVE')",
					)
					.bind(session.identity_id, teamId, teamId)
					.first()))
		) {
			return json({ error: "NOT_FOUND" }, 404);
		}
		const document = await db
			.prepare(
				"SELECT object_key,filename,content_type FROM team_documents WHERE id=? AND team_id=? AND status='STORED' AND EXISTS(SELECT 1 FROM teams WHERE id=? AND hackathon_id='initial' AND status='ACTIVE')",
			)
			.bind(documentId, teamId, teamId)
			.first<{
				object_key: string;
				filename: string;
				content_type: string;
			}>();
		if (!document) return json({ error: "NOT_FOUND" }, 404);
		if (!env.ARTIFACTS) {
			return json({ error: "DOCUMENT_STORAGE_UNAVAILABLE" }, 503);
		}
		const object = await env.ARTIFACTS.get(document.object_key);
		if (!object) {
			return json({ error: "DOCUMENT_STORAGE_UNAVAILABLE" }, 503);
		}
		const safeName = document.filename.replace(
			/[\u0000-\u001f\u007f-\uffff"\\]/g,
			"_",
		);
		return new Response(await object.arrayBuffer(), {
			headers: {
				"cache-control": "private, no-store",
				"content-disposition":
					`attachment; filename="${safeName}"; filename*=UTF-8''${
						encodeURIComponent(
							document.filename,
						)
					}`,
				"content-type": document.content_type,
				"x-content-type-options": "nosniff",
			},
		});
	}
	if (path === "/assignments" && request.method === "GET") {
		if (session.role === "judge" && !session.identity_id) {
			return json({ error: "JUDGE_IDENTITY_REQUIRED" }, 403);
		}
		const judge = session.role === "judge" ? session.identity_id : null;
		const assignments = await db
			.prepare(
				"SELECT a.id,a.judge_identity_id,j.name AS judge_name,a.team_id,t.name AS team_name,a.assigned_by,a.assigned_at,a.revoked_at,a.revoked_by,a.reason FROM round_two_judge_assignments a JOIN console_identities j ON j.id=a.judge_identity_id JOIN teams t ON t.id=a.team_id WHERE (? IS NULL OR a.judge_identity_id=?) ORDER BY a.assigned_at DESC,a.id LIMIT 500",
			)
			.bind(judge, judge)
			.all();
		return json({ assignments: assignments.results });
	}
	if (path === "/assignments" && request.method === "POST") {
		if (session.role !== "organizer") {
			return json({ error: "ORGANIZER_REQUIRED" }, 403);
		}
		let data: z.infer<typeof assignmentInput>;
		try {
			data = assignmentInput.parse(await input(request));
		} catch {
			return json({ error: "INVALID_INPUT" }, 400);
		}
		const [judge, team] = await Promise.all([
			db
				.prepare(
					"SELECT id FROM console_identities WHERE id=? AND role='judge' AND revoked_at IS NULL",
				)
				.bind(data.judgeIdentityId)
				.first(),
			db
				.prepare(
					"SELECT id FROM teams WHERE id=? AND status='ACTIVE' AND hackathon_id='initial'",
				)
				.bind(data.teamId)
				.first(),
		]);
		if (!judge) return json({ error: "ACTIVE_JUDGE_REQUIRED" }, 404);
		if (!team) return json({ error: "ACTIVE_TEAM_REQUIRED" }, 404);
		const id = crypto.randomUUID(),
			actor = "organizer:" + (session.identity_id ?? session.hash),
			results = await db.batch([
				db
					.prepare(
						"INSERT OR IGNORE INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES(?,?,?,?)",
					)
					.bind(id, data.judgeIdentityId, data.teamId, actor),
				db
					.prepare(
						"INSERT INTO audit(action,entity,actor,changes) SELECT 'round_two.judge_assigned',?,?,? WHERE changes()=1",
					)
					.bind(
						id,
						actor,
						JSON.stringify({
							judgeIdentityId: data.judgeIdentityId,
							teamId: data.teamId,
						}),
					),
			]);
		if (!results[0]?.meta.changes) {
			return json({ error: "ASSIGNMENT_ALREADY_ACTIVE" }, 409);
		}
		return json(
			{
				assignment: {
					id,
					judgeIdentityId: data.judgeIdentityId,
					teamId: data.teamId,
				},
			},
			201,
		);
	}
	const revoke = path.match(/^\/assignments\/([a-f0-9-]{36})$/);
	if (revoke && request.method === "DELETE") {
		if (session.role !== "organizer") {
			return json({ error: "ORGANIZER_REQUIRED" }, 403);
		}
		let data: z.infer<typeof revocationInput>;
		try {
			data = revocationInput.parse(await input(request));
		} catch {
			return json({ error: "INVALID_INPUT" }, 400);
		}
		const actor = "organizer:" + (session.identity_id ?? session.hash),
			results = await db.batch([
				db
					.prepare(
						"UPDATE round_two_judge_assignments SET revoked_at=CURRENT_TIMESTAMP,revoked_by=?,reason=? WHERE id=? AND revoked_at IS NULL",
					)
					.bind(actor, data.reason, revoke[1]),
				db
					.prepare(
						"INSERT INTO audit(action,entity,actor,changes) SELECT 'round_two.judge_assignment_revoked',?,?,? WHERE changes()=1",
					)
					.bind(
						revoke[1],
						actor,
						JSON.stringify({ reason: data.reason }),
					),
			]);
		if (!results[0]?.meta.changes) {
			return json({ error: "ASSIGNMENT_NOT_ACTIVE" }, 404);
		}
		return json({ id: revoke[1], revoked: true });
	}
	if (path === "/teams" && request.method === "GET") {
		if (session.role === "judge" && !session.identity_id) {
			return json({ error: "JUDGE_IDENTITY_REQUIRED" }, 403);
		}
		const teams = await db
			.prepare(
				"SELECT t.id,t.name,t.status,(SELECT count(*) FROM submissions s WHERE s.team_id=t.id) AS submission_count,(SELECT count(*) FROM team_documents d WHERE d.team_id=t.id AND d.status='STORED') AS document_count FROM teams t WHERE t.hackathon_id='initial' AND t.status='ACTIVE' AND (? IS NULL OR EXISTS(SELECT 1 FROM round_two_judge_assignments a WHERE a.judge_identity_id=? AND a.team_id=t.id AND a.revoked_at IS NULL)) ORDER BY t.name LIMIT 500",
			)
			.bind(
				session.role === "judge" ? session.identity_id : null,
				session.role === "judge" ? session.identity_id : null,
			)
			.all();
		const deadlines = await db
			.prepare(
				"SELECT analysis_document_deadline AS analysisDocumentDeadline,pull_request_deadline AS pullRequestDeadline FROM hackathons WHERE id='initial'",
			)
			.first();
		return json({ teams: teams.results, deadlines });
	}
	const teamPath = path.match(/^\/teams\/([\w.-]{1,80})$/);
	if (teamPath && request.method === "GET") {
		if (
			session.role === "judge" &&
			(!session.identity_id ||
				!(await db
					.prepare(
						"SELECT id FROM round_two_judge_assignments WHERE judge_identity_id=? AND team_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM teams WHERE id=? AND status='ACTIVE')",
					)
					.bind(session.identity_id, teamPath[1], teamPath[1])
					.first()))
		) {
			return json({ error: "NOT_FOUND" }, 404);
		}
		const team = await db
			.prepare(
				"SELECT id,name,status FROM teams WHERE id=? AND hackathon_id='initial' AND status='ACTIVE'",
			)
			.bind(teamPath[1])
			.first();
		if (!team) return json({ error: "NOT_FOUND" }, 404);
		const [
			members,
			repositories,
			submissions,
			documents,
			matrixSubmissions,
			unverifiedPullRequests,
		] = await Promise.all([
			db
				.prepare(
						"SELECT id,github_login,display_name FROM (SELECT m.id,m.github_login,m.display_name,m.created_at FROM team_members m WHERE m.team_id=? AND m.active=1 AND NOT EXISTS(SELECT 1 FROM team_roster_members r WHERE r.linked_team_member_id=m.id AND r.active=1) UNION ALL SELECT COALESCE(r.linked_team_member_id,r.id) AS id,m.github_login,r.display_name,r.created_at FROM team_roster_members r LEFT JOIN team_members m ON m.id=r.linked_team_member_id AND m.active=1 WHERE r.team_id=? AND r.active=1) ORDER BY created_at",
				)
					.bind(teamPath[1], teamPath[1])
				.all(),
			db
				.prepare(
					"SELECT g.id,g.full_name,g.default_branch FROM team_repositories tr JOIN github_repositories g ON g.id=tr.repository_id WHERE tr.team_id=? AND tr.active=1 ORDER BY g.full_name",
				)
				.bind(teamPath[1])
				.all(),
			db
				.prepare(
					"SELECT s.repository_id,s.pr_number,s.head_sha,s.author_login,s.status,s.mapping_reason,s.github_updated_at,r.full_name FROM submissions s JOIN github_repositories r ON r.id=s.repository_id WHERE s.team_id=? ORDER BY s.github_updated_at DESC LIMIT 100",
				)
				.bind(teamPath[1])
				.all(),
			db
				.prepare(
					"SELECT id,version,filename,content_type,bytes,sha256,status,created_at FROM team_documents WHERE team_id=? AND status='STORED' ORDER BY version DESC",
				)
				.bind(teamPath[1])
				.all(),
			db
				.prepare(
					"SELECT s.repository_id,r.full_name,s.pr_number,s.head_sha,s.author_id,s.author_login,s.mapping_status,s.updated_at,s.closed,s.latest_run_id,m.state AS evaluation_status,m.failure_code,m.report FROM matrix_submissions s JOIN github_repositories r ON r.id=s.repository_id LEFT JOIN matrix_runs m ON m.id=s.latest_run_id WHERE s.team_id=? ORDER BY s.updated_at DESC LIMIT 100",
				)
				.bind(teamPath[1])
				.all<{
					repository_id: number;
					full_name: string;
					pr_number: number;
					head_sha: string;
					author_id: number | null;
					author_login: string | null;
					mapping_status: string;
					updated_at: string;
					closed: number;
					latest_run_id: string;
					evaluation_status: string | null;
					failure_code: string | null;
					report: string | null;
				}>(),
			db
				.prepare(
					"SELECT s.repository_id,r.full_name,s.pr_number,s.head_sha,s.github_updated_at,s.closed,s.author_id,s.author_login,s.mapping_status,s.check_status FROM unverified_pr_submissions s JOIN github_repositories r ON r.id=s.repository_id AND r.accessible=1 JOIN team_repositories tr ON tr.team_id=s.team_id AND tr.repository_id=s.repository_id AND tr.active=1 WHERE s.team_id=? AND s.mapping_status='MAPPED' ORDER BY s.github_updated_at DESC LIMIT 100",
				)
				.bind(teamPath[1])
				.all<{
					repository_id: number;
					full_name: string;
					pr_number: number;
					head_sha: string;
					github_updated_at: string;
					closed: number;
					author_id: number;
					author_login: string;
					mapping_status: string;
					check_status: string;
				}>(),
		]);
		const deadlines = await db
			.prepare(
				"SELECT analysis_document_deadline AS analysisDocumentDeadline,pull_request_deadline AS pullRequestDeadline FROM hackathons WHERE id='initial'",
			)
			.first();
		return json({
			team,
			members: members.results,
			repositories: repositories.results,
			submissions: submissions.results,
			matrixSubmissions: matrixSubmissions.results.map((submission) => ({
				...submission,
				report: submission.report
					? JSON.parse(submission.report)
					: null,
			})),
			unverifiedPullRequests: unverifiedPullRequests.results.map((submission) => ({
				...submission,
				htmlUrl: `https://github.com/${submission.full_name}/pull/${submission.pr_number}`,
				evaluationStatus: "UNVERIFIED",
				categories: {
					functionalCorrectness: "UNVERIFIED",
					security: "UNVERIFIED",
					performanceAndScalability: "UNVERIFIED",
					codeQuality: "UNVERIFIED",
					innovationAndUsefulness: "UNVERIFIED",
					reproducibility: "UNVERIFIED",
				},
				marks: null,
			})),
			documents: documents.results,
			deadlines,
		});
	}
	return json({ error: "NOT_FOUND" }, 404);
}
