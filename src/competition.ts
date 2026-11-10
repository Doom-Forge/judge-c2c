import { evaluationMetrics } from "./evaluation-metrics";
import { competitionOverview } from "./competition-overview";
import { z } from "zod";
import { canonical } from "./domain";
import { boundedBody } from "./security";
import {
	eventPolicySchema,
	taxonomySchema,
	teamStatus,
} from "./competition-domain";
import {
	auditStatement,
	competitionDB,
	type CompetitionServices,
	eventSettings,
	selectedRepository,
} from "./competition-store";
import {
	addMember,
	assignRepository,
	changeTeam,
	createTeam,
	importTeams,
	removeMember,
} from "./competition-teams";
import {
	activateReservation,
	assignIssue,
	publishChallenge,
	reviewIssue,
	revokeAssignment,
	syncIssue,
} from "./competition-issues";
import { resolutionSchema, resolveSubmission } from "./competition-submissions";
import { maintainCompetition, reconcileRepository } from "./competition-sync";
import { decideCompletion } from "./competition-completion";
import {
	createSubmissionRelation,
	listSubmissionRelations,
} from "./submission-relations";
import type { Env } from "./env";
import { teamEmailSubjectSchema, teamEmailTemplateSchema } from "./team-email";
const issueWorkflow =
	`CASE WHEN i.official=0 OR i.review_status<>'APPROVED' THEN lower(replace(i.review_status,'_','-'))
 WHEN i.github_state='closed' AND NOT EXISTS(SELECT 1 FROM issue_assignments a WHERE a.repository_id=i.repository_id AND a.issue_number=i.number AND a.status='ACTIVE') THEN 'closed'
 WHEN NOT EXISTS(SELECT 1 FROM issue_assignments a WHERE a.repository_id=i.repository_id AND a.issue_number=i.number AND a.status='ACTIVE') THEN coalesce((SELECT lower(availability) FROM challenge_definitions d WHERE d.repository_id=i.repository_id AND d.issue_number=i.number),'blocked')
 WHEN NOT EXISTS(SELECT 1 FROM issue_assignments a WHERE a.repository_id=i.repository_id AND a.issue_number=i.number AND a.status='ACTIVE' AND a.progress<>'COMPLETED') THEN 'completed'
 WHEN EXISTS(SELECT 1 FROM issue_assignments a WHERE a.repository_id=i.repository_id AND a.issue_number=i.number AND a.status='ACTIVE' AND a.progress='EVALUATING') THEN 'evaluating'
 WHEN EXISTS(SELECT 1 FROM issue_assignments a WHERE a.repository_id=i.repository_id AND a.issue_number=i.number AND a.status='ACTIVE' AND a.progress='IN_PROGRESS') THEN 'in-progress' ELSE 'assigned' END`;
const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: { "cache-control": "no-store" } });
function decode(row: Record<string, unknown>) {
	const keys = [
		"metadata",
		"classification",
		"overrides",
		"labels",
		"issue_numbers",
		"assignment_ids",
		"override",
		"pr_snapshot",
		"definition_snapshot",
		"evidence_snapshot",
		"changes",
	];
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key,
			keys.includes(key) && typeof value === "string"
				? JSON.parse(value)
				: value,
		]),
	);
}
async function input(request: Request) {
	return JSON.parse(
		new TextDecoder().decode(await boundedBody(request, 200000)),
	);
}
export async function competition(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	services: CompetitionServices,
	actor: string,
) {
	const url = new URL(request.url),
		path = url.pathname.replace("/api/organization/manage", ""),
		method = request.method,
		db = competitionDB(env);
	const q = (url.searchParams.get("q") ?? "").slice(0, 100),
		like = "%" +
			q.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll(
				"_",
				"!_",
			) +
			"%";
	try {
		if (path === "/settings" && method === "GET") {
			return json({
				settings: await eventSettings(env),
				capabilities: services.capabilities
					? await services.capabilities().catch(() => ({
						issuesWrite: false,
						events: [],
						reason: "CAPABILITY_CHECK_UNAVAILABLE",
					}))
					: null,
			});
		}
		if (path === "/team-email" && method === "GET") {
			if (!actor.startsWith("organizer:")) {
				return json({ error: "ORGANIZER_REQUIRED" }, 403);
			}
			const row = await db
				.prepare(
					"SELECT status,team_email_enabled,team_email_subject,team_email_body FROM hackathons WHERE id='initial'",
				)
				.first<{
					status: string;
					team_email_enabled: number;
					team_email_subject: string;
					team_email_body: string;
				}>();
			const recentDeliveries = await db
				.prepare(
					"SELECT substr(idempotency_key,1,24) AS hour,status,recipient,attempts,last_error,created_at,updated_at FROM team_email_deliveries ORDER BY updated_at DESC LIMIT 20",
				)
				.all();
			return json({
				enabled: row?.team_email_enabled === 1,
				eventStatus: row?.status,
				senderConfigured: Boolean(env.TEAM_EMAIL_SENDER),
				subject: row?.team_email_subject ?? "",
				body: row?.team_email_body ?? "",
				lastDelivery: recentDeliveries.results[0] ?? null,
				recentDeliveries: recentDeliveries.results,
			});
		}
		if (path === "/deadlines" && method === "GET") {
			const deadlines = await db
				.prepare(
					"SELECT analysis_document_deadline AS analysisDocumentDeadline,pull_request_deadline AS pullRequestDeadline FROM hackathons WHERE id='initial'",
				)
				.first();
			if (!deadlines) {
				return json({ error: "HACKATHON_NOT_CONFIGURED" }, 404);
			}
			return json(deadlines);
		}
		if (path === "/deadlines" && method === "PUT") {
			if (!actor.startsWith("organizer:")) {
				return json({ error: "ORGANIZER_REQUIRED" }, 403);
			}
			const timestamp = z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
				.refine((value) => {
					const [date, time] = value.slice(0, -1).split("T");
					const [year, month, day] = date!.split("-").map(Number);
					const [hour, minute, second] = time!.split(/[:.]/).map(
						Number,
					);
					const parsed = new Date(value);
					return (
						Number.isFinite(parsed.getTime()) &&
						parsed.getUTCFullYear() === year &&
						parsed.getUTCMonth() + 1 === month &&
						parsed.getUTCDate() === day &&
						parsed.getUTCHours() === hour &&
						parsed.getUTCMinutes() === minute &&
						parsed.getUTCSeconds() === second
					);
				});
			let data: {
				analysisDocumentDeadline: string | null;
				pullRequestDeadline: string | null;
			};
			try {
				data = z.object({
					analysisDocumentDeadline: timestamp.nullable(),
					pullRequestDeadline: timestamp.nullable(),
				}).strict().parse(await input(request));
			} catch {
				return json({ error: "INVALID_DEADLINES" }, 400);
			}
			const eventId = crypto.randomUUID();
			let results: D1Result[];
			try {
				results = await db.batch([
					db
						.prepare(
							"INSERT INTO audit(action,entity,actor,changes) SELECT 'hackathon.deadlines.updated','initial',?,json_object('eventId',?,'before',json_object('analysisDocumentDeadline',analysis_document_deadline,'pullRequestDeadline',pull_request_deadline),'after',json_object('analysisDocumentDeadline',?,'pullRequestDeadline',?)) FROM hackathons WHERE id='initial'",
						)
						.bind(
							actor,
							eventId,
							data.analysisDocumentDeadline,
							data.pullRequestDeadline,
						),
					db
						.prepare(
							"UPDATE hackathons SET analysis_document_deadline=?,pull_request_deadline=? WHERE id='initial' AND EXISTS(SELECT 1 FROM audit WHERE action='hackathon.deadlines.updated' AND entity='initial' AND actor=? AND json_extract(changes,'$.eventId')=?)",
						)
						.bind(
							data.analysisDocumentDeadline,
							data.pullRequestDeadline,
							actor,
							eventId,
						),
				]);
			} catch {
				return json({ error: "AUDIT_INSERT_FAILED" }, 409);
			}
			if (!results[1]?.meta.changes) {
				return json({ error: "AUDIT_INSERT_FAILED" }, 409);
			}
			return json(data);
		}
		if (path === "/team-email" && method === "POST") {
			if (!actor.startsWith("organizer:")) {
				return json({ error: "ORGANIZER_REQUIRED" }, 403);
			}
			const settings = z
				.object({ enabled: z.boolean() })
				.extend({
					subject: teamEmailSubjectSchema.optional(),
					body: teamEmailTemplateSchema.optional(),
				})
				.partial({ enabled: true })
				.strict()
				.refine(
					(value) =>
						value.enabled !== undefined ||
						value.subject !== undefined ||
						value.body !== undefined,
				)
				.parse(await input(request));
			if (settings.enabled && !env.TEAM_EMAIL_SENDER) {
				return json({ error: "TEAM_EMAIL_SENDER_NOT_CONFIGURED" }, 409);
			}
			const before = await db
				.prepare(
					"SELECT team_email_enabled,team_email_subject,team_email_body FROM hackathons WHERE id='initial'",
				)
				.first<{
					team_email_enabled: number;
					team_email_subject: string;
					team_email_body: string;
				}>();
			const updated = {
				enabled: settings.enabled ?? before?.team_email_enabled === 1,
				subject: settings.subject ?? before?.team_email_subject ?? "",
				body: settings.body ?? before?.team_email_body ?? "",
			};
			await db.batch([
				db
					.prepare(
						"UPDATE hackathons SET team_email_enabled=?,team_email_subject=?,team_email_body=? WHERE id='initial'",
					)
					.bind(
						Number(updated.enabled),
						updated.subject,
						updated.body,
					),
				auditStatement(
					env,
					actor,
					"team-email.preference.updated",
					"initial",
					{
						enabled: before?.team_email_enabled === 1,
						subject: before?.team_email_subject,
						body: before?.team_email_body,
					},
					updated,
				),
			]);
			return json(updated);
		}
		if (path === "/settings" && method === "POST") {
			const data = z
					.object({
						name: z.string().trim().min(1).max(100),
						status: z.enum(["ACTIVE", "PAUSED", "COMPLETED"]),
						policy: eventPolicySchema,
						taxonomy: taxonomySchema,
					})
					.strict()
					.parse(await input(request)),
				before = await eventSettings(env);
			const required = [
				"judge:status:needs-triage",
				"judge:source:participant",
				"judge:source:organizer",
				"judge:source:unknown",
				"judge:evaluation:not-scored",
				"judge:evaluation:approved-challenge",
			];
			if (
				required.some(
					(name) =>
						!data.taxonomy.some((label) => label.name === name),
				)
			) {
				throw new Error("REQUIRED_TAXONOMY_LABEL_MISSING");
			}
			await db.batch([
				db
					.prepare(
						"UPDATE hackathons SET name=?,status=?,policy=?,taxonomy=? WHERE id=?",
					)
					.bind(
						data.name,
						data.status,
						canonical(data.policy),
						canonical(data.taxonomy),
						"initial",
					),
				auditStatement(
					env,
					actor,
					"hackathon.policy.updated",
					"initial",
					before,
					data,
				),
			]);
			return json(data);
		}
		if (path === "/overview" && method === "GET") {
			const counts = await competitionOverview(db);
			return json({ counts, metrics: await evaluationMetrics(db) });
		}
		if (path === "/teams" && method === "GET") {
			const status = url.searchParams.get("status"),
				cursor = (url.searchParams.get("cursor") ?? "").slice(0, 80);
			if (status) teamStatus.parse(status);
			const rows = await db
				.prepare(
					"SELECT t.*,(SELECT count(*) FROM team_members WHERE team_id=t.id AND active=1)+(SELECT count(*) FROM team_roster_members WHERE team_id=t.id AND active=1 AND linked_team_member_id IS NULL) AS member_count,(SELECT count(*) FROM team_repositories WHERE team_id=t.id AND active=1) AS repository_count,(SELECT count(*) FROM issue_assignments WHERE team_id=t.id AND status='ACTIVE') AS issue_count,(SELECT count(*) FROM submissions WHERE team_id=t.id) AS submission_count,(SELECT group_concat(member_name,', ') FROM (SELECT COALESCE(m.github_login,m.display_name) AS member_name FROM team_members m WHERE m.team_id=t.id AND m.active=1 AND NOT EXISTS(SELECT 1 FROM team_roster_members r WHERE r.linked_team_member_id=m.id AND r.active=1) UNION ALL SELECT COALESCE(m.github_login,r.display_name) AS member_name FROM team_roster_members r LEFT JOIN team_members m ON m.id=r.linked_team_member_id AND m.active=1 WHERE r.team_id=t.id AND r.active=1) roster) AS github_members FROM teams t WHERE t.id>? AND t.name LIKE ? ESCAPE '!' AND (? IS NULL OR t.status=?) ORDER BY t.id LIMIT 100",
				)
				.bind(cursor, like, status, status)
				.all<Record<string, unknown>>();
			return json({
				teams: rows.results.map(decode),
				nextCursor: rows.results.length === 100
					? rows.results.at(-1)!.id
					: null,
			});
		}
		if (path === "/teams" && method === "POST") {
			return json(
				await createTeam(env, services, actor, await input(request)),
				201,
			);
		}
		if (path === "/teams/import" && method === "POST") {
			return json(
				await importTeams(env, services, actor, await input(request)),
			);
		}
		const teamPath = path.match(/^\/teams\/([\w.-]{1,80})$/);
		if (teamPath && method === "PATCH") {
			return json(
				await changeTeam(
					env,
					actor,
					teamPath[1]!,
					await input(request),
				),
			);
		}
		if (teamPath && method === "GET") {
			const team = await db
				.prepare("SELECT * FROM teams WHERE id=?")
				.bind(teamPath[1])
				.first<Record<string, unknown>>();
			if (!team) throw new Error("TEAM_NOT_FOUND");
			const id = teamPath[1]!,
				[
					members,
					rosterMembers,
					repositories,
					assignments,
					submissions,
					raised,
					runs,
				] = await Promise.all([
					db
						.prepare(
							"SELECT * FROM team_members WHERE team_id=? ORDER BY active DESC,created_at",
						)
						.bind(id)
						.all(),
					db
						.prepare(
							"SELECT r.*,m.github_id,m.github_login FROM team_roster_members r LEFT JOIN team_members m ON m.id=r.linked_team_member_id WHERE r.team_id=? ORDER BY r.active DESC,r.created_at",
						)
						.bind(id)
						.all(),
					db
						.prepare(
							"SELECT tr.*,g.full_name FROM team_repositories tr JOIN github_repositories g ON g.id=tr.repository_id WHERE tr.team_id=?",
						)
						.bind(id)
						.all(),
					db
						.prepare(
							"SELECT a.*,i.title,r.full_name FROM issue_assignments a JOIN github_issues i ON i.repository_id=a.repository_id AND i.number=a.issue_number JOIN github_repositories r ON r.id=a.repository_id WHERE a.team_id=? ORDER BY a.assigned_at DESC",
						)
						.bind(id)
						.all(),
					db
						.prepare(
							"SELECT s.*,r.full_name,e.state AS evaluation_state FROM submissions s JOIN github_repositories r ON r.id=s.repository_id LEFT JOIN evaluations e ON e.id=s.latest_run_id AND e.head_sha=s.head_sha WHERE s.team_id=? ORDER BY s.github_updated_at DESC LIMIT 100",
						)
						.bind(id)
						.all(),
					db
						.prepare(
							"SELECT repository_id,number,title,source,review_status,official FROM github_issues WHERE reporter_team_id=? ORDER BY updated_at DESC LIMIT 100",
						)
						.bind(id)
						.all(),
					db
						.prepare(
							"SELECT e.id,e.repository_id,e.pr_number,e.head_sha,e.state,e.created_at,s.latest_run_id=e.id AS current FROM evaluations e LEFT JOIN submissions s ON s.repository_id=e.repository_id AND s.pr_number=e.pr_number WHERE json_extract(e.assignment_snapshot,'$.team_id')=? ORDER BY e.created_at DESC LIMIT 100",
						)
						.bind(id)
						.all(),
				]);
			return json({
				team: decode(team),
				members: [
					...members.results,
					...rosterMembers.results.filter(
						(member) => !(member as { linked_team_member_id?: string }).linked_team_member_id,
					),
				],
				repositories: repositories.results,
				assignments: assignments.results,
				submissions: submissions.results.map(decode),
				raisedIssues: raised.results,
				evaluations: runs.results,
			});
		}
		const memberPath = path.match(
			/^\/teams\/([\w.-]+)\/members(?:\/([\w.-]+))?$/,
		);
		if (memberPath && method === "POST") {
			return json(
				await addMember(
					env,
					services,
					actor,
					memberPath[1]!,
					await input(request),
					memberPath[2],
				),
				201,
			);
		}
		if (memberPath?.[2] && method === "DELETE") {
			await removeMember(env, actor, memberPath[1]!, memberPath[2]);
			return json({ status: "REMOVED" });
		}
		const repositoryPath = path.match(
			/^\/teams\/([\w.-]+)\/repositories\/(\d+)$/,
		);
		if (repositoryPath && ["POST", "DELETE"].includes(method)) {
			await assignRepository(
				env,
				actor,
				repositoryPath[1]!,
				Number(repositoryPath[2]),
				method === "DELETE",
			);
			return json({
				status: method === "DELETE" ? "REVOKED" : "ASSIGNED",
			});
		}
		if (path === "/issues" && method === "GET") {
			const repository = url.searchParams.get("repository"),
				source = url.searchParams.get("source"),
				status = url.searchParams.get("status"),
				type = url.searchParams.get("type"),
				official = url.searchParams.get("official"),
				team = url.searchParams.get("team"),
				label = url.searchParams.get("label"),
				workflow = url.searchParams.get("workflow"),
				priority = url.searchParams.get("priority"),
				difficulty = url.searchParams.get("difficulty"),
				cursor = Number(url.searchParams.get("offset") ?? 0);
			if (!Number.isInteger(cursor) || cursor < 0 || cursor > 100000) {
				throw new Error("INVALID_PAGINATION");
			}
			const rows = await db
				.prepare(
					`WITH classified_issues AS (SELECT i.*, ${issueWorkflow} AS workflow_status FROM github_issues i) SELECT i.repository_id,i.number,i.title,i.github_state,i.author_login,i.reporter_team_id,i.source,i.labels,i.classification,i.review_status,i.official,i.updated_at,i.workflow_status,r.full_name FROM classified_issues i JOIN github_repositories r ON r.id=i.repository_id WHERE i.title LIKE ? ESCAPE '!' AND (? IS NULL OR i.repository_id=?) AND (? IS NULL OR i.source=?) AND (? IS NULL OR i.review_status=?) AND (? IS NULL OR json_extract(i.classification,'$.type')=?) AND (? IS NULL OR i.official=?) AND (? IS NULL OR i.reporter_team_id=? OR EXISTS(SELECT 1 FROM issue_assignments a WHERE a.repository_id=i.repository_id AND a.issue_number=i.number AND a.team_id=? AND a.status='ACTIVE')) AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(i.labels) WHERE value=?)) AND (? IS NULL OR i.workflow_status=?) AND (? IS NULL OR json_extract(i.classification,'$.priority')=?) AND (? IS NULL OR json_extract(i.classification,'$.difficulty')=?) ORDER BY i.updated_at DESC,i.repository_id,i.number LIMIT 100 OFFSET ?`,
				)
				.bind(
					like,
					repository,
					repository,
					source,
					source,
					status,
					status,
					type,
					type,
					official,
					official,
					team,
					team,
					team,
					label,
					label,
					workflow,
					workflow,
					priority,
					priority,
					difficulty,
					difficulty,
					cursor,
				)
				.all<Record<string, unknown>>();
			return json({
				issues: rows.results.map(decode),
				nextOffset: rows.results.length === 100 ? cursor + 100 : null,
			});
		}
		const issuePath = path.match(
			/^\/issues\/(\d+)\/(\d+)(?:\/(sync|review))?$/,
		);
		if (issuePath && method === "POST") {
			const repositoryId = Number(issuePath[1]),
				number = Number(issuePath[2]);
			if (issuePath[3] === "sync") {
				return json(
					await syncIssue(env, services, repositoryId, number, actor),
				);
			}
			if (issuePath[3] === "review") {
				return json(
					await reviewIssue(
						env,
						actor,
						repositoryId,
						number,
						await input(request),
					),
				);
			}
		}
		if (issuePath && !issuePath[3] && method === "GET") {
			const repositoryId = Number(issuePath[1]),
				number = Number(issuePath[2]),
				issue = await db
					.prepare(
						"SELECT * FROM github_issues WHERE repository_id=? AND number=?",
					)
					.bind(repositoryId, number)
					.first<Record<string, unknown>>();
			if (!issue) throw new Error("ISSUE_NOT_FOUND");
			const [definition, versions, assignments, submissions, decisions] =
				await Promise.all([
					db
						.prepare(
							"SELECT * FROM challenge_definitions WHERE repository_id=? AND issue_number=?",
						)
						.bind(repositoryId, number)
						.first(),
					db
						.prepare(
							"SELECT v.*,c.document FROM challenge_versions v JOIN contracts c ON c.hash=v.contract_hash WHERE v.repository_id=? AND v.issue_number=? ORDER BY v.created_at DESC",
						)
						.bind(repositoryId, number)
						.all(),
					db
						.prepare(
							"SELECT a.*,t.name AS team_name FROM issue_assignments a JOIN teams t ON t.id=a.team_id WHERE a.repository_id=? AND a.issue_number=? ORDER BY a.assigned_at DESC",
						)
						.bind(repositoryId, number)
						.all(),
					db
						.prepare(
							"SELECT s.*,t.name AS team_name,e.state AS evaluation_state FROM submissions s LEFT JOIN teams t ON t.id=s.team_id LEFT JOIN evaluations e ON e.id=s.latest_run_id AND e.head_sha=s.head_sha WHERE s.repository_id=? AND EXISTS(SELECT 1 FROM json_each(s.issue_numbers) WHERE value=?) ORDER BY s.github_updated_at DESC",
						)
						.bind(repositoryId, number)
						.all(),
					db
						.prepare(
							"SELECT d.* FROM completion_decisions d JOIN issue_assignments a ON a.id=d.assignment_id WHERE a.repository_id=? AND a.issue_number=? ORDER BY d.sequence DESC",
						)
						.bind(repositoryId, number)
						.all(),
				]);
			return json({
				reviews: (
					await db
						.prepare(
							"SELECT id,actor,changes,created_at FROM audit WHERE action='issue.reviewed' AND entity=? ORDER BY id",
						)
						.bind(repositoryId + ":" + number)
						.all<Record<string, unknown>>()
				).results.map(decode),
				issue: decode(issue),
				definition,
				versions: versions.results,
				assignments: assignments.results,
				submissions: submissions.results.map(decode),
				decisions: decisions.results.map(decode),
			});
		}
		if (path === "/challenges" && method === "POST") {
			return json(
				await publishChallenge(
					env,
					services,
					actor,
					await input(request),
				),
				201,
			);
		}
		if (path === "/assignments" && method === "POST") {
			return json(
				await assignIssue(env, actor, await input(request)),
				201,
			);
		}
		const assignmentPath = path.match(
			/^\/assignments\/([\w.-]+)(?:\/(activate|completion))?$/,
		);
		if (assignmentPath && method === "DELETE") {
			const data = z
				.object({ reason: z.string().min(10).max(1000) })
				.strict()
				.parse(await input(request));
			await revokeAssignment(env, actor, assignmentPath[1]!, data.reason);
			return json({ status: "REVOKED" });
		}
		if (assignmentPath?.[2] === "completion" && method === "POST") {
			return json(
				await decideCompletion(
					env,
					actor,
					assignmentPath[1]!,
					await input(request),
				),
				201,
			);
		}
		if (assignmentPath?.[2] === "activate" && method === "POST") {
			z.object({})
				.strict()
				.parse(await input(request));
			await activateReservation(env, actor, assignmentPath[1]!);
			return json({ status: "ACTIVE" });
		}
		if (path === "/submissions" && method === "GET") {
			const team = url.searchParams.get("team"),
				repo = url.searchParams.get("repository"),
				status = url.searchParams.get("status"),
				issue = url.searchParams.has("issue")
					? z.coerce
						.number()
						.int()
						.positive()
						.parse(url.searchParams.get("issue"))
					: null,
				state = url.searchParams.get("evaluationState"),
				notSubmitted = url.searchParams.get("notSubmitted") === "1",
				sort = z
					.enum(["newest", "oldest"])
					.parse(url.searchParams.get("sort") ?? "newest");
			if (notSubmitted || status === "NOT_SUBMITTED") {
				return json({
					teams: (
						await db
							.prepare(
								"SELECT t.id,t.name,t.status FROM teams t WHERE t.name LIKE ? ESCAPE '!' AND (? IS NULL OR t.id=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM team_repositories r WHERE r.team_id=t.id AND r.repository_id=? AND r.active=1)) AND NOT EXISTS(SELECT 1 FROM submissions s WHERE s.team_id=t.id AND (? IS NULL OR s.repository_id=?)) ORDER BY t.name LIMIT 200",
							)
							.bind(like, team, team, repo, repo, repo, repo)
							.all()
					).results,
				});
			}
			const rows = await db
				.prepare(
					"SELECT s.*,t.name AS team_name,r.full_name,e.state AS evaluation_state,e.head_sha AS evaluation_head,e.ai_status FROM submissions s LEFT JOIN teams t ON t.id=s.team_id JOIN github_repositories r ON r.id=s.repository_id LEFT JOIN evaluations e ON e.id=s.latest_run_id AND e.head_sha=s.head_sha WHERE (s.author_login LIKE ? ESCAPE '!' OR r.full_name LIKE ? ESCAPE '!' OR t.name LIKE ? ESCAPE '!') AND (? IS NULL OR s.team_id=?) AND (? IS NULL OR s.repository_id=?) AND (? IS NULL OR s.status=?) AND (? IS NULL OR e.state=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(s.issue_numbers) WHERE value=?)) AND (?=0 OR s.status NOT IN('VALID','CLOSED') OR e.state='FAILED' OR (e.state='COMPLETED' AND coalesce(e.ai_status,'')<>'COMPLETED') OR json_extract(coalesce(e.report,'{}'),'$.aiTrace.requiresHumanAttention')=1 OR (e.ai_status='COMPLETED' AND coalesce(json_extract(coalesce(e.report,'{}'),'$.aiTrace.groundingPolicy'),'')<>'objective-facts-unverified-narratives-v1') OR EXISTS(SELECT 1 FROM json_each(coalesce(e.evidence,'[]')) WHERE json_extract(value,'$.status') IN('FAIL','UNVERIFIED'))) AND (?=0 OR EXISTS(SELECT 1 FROM json_each(coalesce(e.report,'{}'),'$.findings') WHERE lower(json_extract(value,'$.category')) LIKE '%security%') OR EXISTS(SELECT 1 FROM json_each(coalesce(e.evidence,'[]')) WHERE (json_extract(value,'$.id') LIKE 'security-%' OR json_extract(value,'$.id') LIKE 'dependency-%') AND json_extract(value,'$.status')<>'PASS')) AND (?=0 OR EXISTS(SELECT 1 FROM json_each(coalesce(e.evidence,'[]')) WHERE json_extract(value,'$.status')='FAIL' AND json_extract(value,'$.baselineStatus')='PASS')) ORDER BY CASE WHEN ?='oldest' THEN s.github_updated_at END ASC, CASE WHEN ?='newest' THEN s.github_updated_at END DESC,s.repository_id,s.pr_number LIMIT 200",
				)
				.bind(
					like,
					like,
					like,
					team,
					team,
					repo,
					repo,
					status,
					status,
					state,
					state,
					issue,
					issue,
					Number(url.searchParams.get("attention") === "1"),
					Number(url.searchParams.get("security") === "1"),
					Number(url.searchParams.get("regression") === "1"),
					sort,
					sort,
				)
				.all<Record<string, unknown>>();
			return json({ submissions: rows.results.map(decode) });
		}
		if (path === "/submission-relations" && method === "POST") {
			const result = await createSubmissionRelation(
				env,
				actor,
				await input(request),
			);
			return json(result.body, result.status);
		}
		const submissionPath = path.match(
			/^\/submissions\/(\d+)\/(\d+)(?:\/(resolve|sync))?$/,
		);
		if (submissionPath && method === "POST") {
			const manual = submissionPath[3] === "resolve"
				? resolutionSchema.parse(await input(request))
				: undefined;
			const delivery = "organizer-" + crypto.randomUUID();
			return json(
				await resolveSubmission(
					env,
					services,
					ctx,
					Number(submissionPath[1]),
					Number(submissionPath[2]),
					delivery,
					delivery,
					actor,
					manual,
				),
			);
		}
		if (submissionPath && !submissionPath[3] && method === "GET") {
			const row = await db
				.prepare(
					"SELECT * FROM submissions WHERE repository_id=? AND pr_number=?",
				)
				.bind(Number(submissionPath[1]), Number(submissionPath[2]))
				.first<Record<string, unknown>>();
			if (!row) throw new Error("SUBMISSION_NOT_FOUND");
			const runs = await db
				.prepare(
					"SELECT id,head_sha,baseline_sha,contract_hash,state,ai_status,created_at FROM evaluations WHERE repository_id=? AND pr_number=? ORDER BY created_at DESC",
				)
				.bind(Number(submissionPath[1]), Number(submissionPath[2]))
				.all();
			return json({
				submission: decode(row),
				evaluations: runs.results,
				relations: await listSubmissionRelations(
					db,
					Number(submissionPath[1]),
					Number(submissionPath[2]),
				),
			});
		}
		if (path === "/reconcile" && method === "POST") {
			const data = z
				.object({
					repositoryId: z.number().int().positive(),
					page: z.number().int().min(1).max(1000).default(1),
				})
				.strict()
				.parse(await input(request));
			return json(
				await reconcileRepository(
					env,
					services,
					ctx,
					data.repositoryId,
					data.page,
				),
			);
		}
		if (path === "/retry-sync" && method === "POST") {
			await db.batch([
				db.prepare(
					"UPDATE github_sync_actions SET status='PENDING',attempts=0 WHERE status IN('FAILED','BLOCKED')",
				),
				db.prepare(
					"UPDATE management_inbox SET status='PENDING',attempts=0 WHERE status='FAILED'",
				),
				auditStatement(
					env,
					actor,
					"synchronization.retry.requested",
					"initial",
					null,
					{ requested: true },
				),
			]);
			ctx.waitUntil(maintainCompetition(env, services, ctx));
			return json({ status: "QUEUED" });
		}
		if (path === "/operations" && method === "GET") {
			return json({
				events: (
					await db
						.prepare(
							"SELECT id,event,status,attempts,last_error,received_at FROM management_inbox ORDER BY received_at DESC LIMIT 100",
						)
						.all()
				).results,
				sync: (
					await db
						.prepare(
							"SELECT id,repository_id,issue_number,kind,status,attempts,last_error FROM github_sync_actions ORDER BY created_at DESC LIMIT 100",
						)
						.all()
				).results,
			});
		}
		if (path === "/audit" && method === "GET") {
			return json({
				audit: (
					await db
						.prepare(
							"SELECT * FROM audit WHERE entity LIKE ? ESCAPE '!' ORDER BY id DESC LIMIT 200",
						)
						.bind(like)
						.all<Record<string, unknown>>()
				).results.map(decode),
			});
		}
		return json({ error: "NOT_FOUND" }, 404);
	} catch (error) {
		if (error instanceof z.ZodError || error instanceof SyntaxError) {
			return json({ error: "INVALID_INPUT" }, 400);
		}
		const message = error instanceof Error ? error.message : "";
		if (message === "BODY_LIMIT") return json({ error: "BODY_LIMIT" }, 413);
		if (/constraint|UNIQUE|NOT NULL/i.test(message)) {
			return json({ error: "CONFLICT_OR_INELIGIBLE_ASSIGNMENT" }, 409);
		}
		if (/^[A-Z_0-9]+$/.test(message)) {
			return json(
				{ error: message },
				message.startsWith("GITHUB_HTTP_") ? 502 : 409,
			);
		}
		return json({ error: "MANAGEMENT_UNAVAILABLE" }, 503);
	}
}
