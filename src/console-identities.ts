import { z } from "zod";
import { boundedBody } from "./security";
import { contractSchema, digest, type Evidence } from "./domain";
import { requirementOutcomes } from "./requirement-assessment";
import { participantDocuments } from "./round-two-documents";
import { arenaGithubIdentity } from "./participant-github";
import { participantSharedScores } from "./round-two-score-sharing";
import { teamAccessKey } from "./team-invitations";
import type { Env } from "./env";
export type ConsoleRole = "organizer" | "judge" | "security" | "participant";
export type ConsoleSession = {
	hash: string;
	role: ConsoleRole;
	identity_id: string | null;
	name: string;
	team_id: string | null;
};
const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: { "cache-control": "no-store" } });
const eligible =
	"i.revoked_at IS NULL AND (i.role<>'participant' OR (EXISTS(SELECT 1 FROM teams t WHERE t.id=i.team_id AND t.status='ACTIVE') AND ((i.team_member_id IS NOT NULL AND EXISTS(SELECT 1 FROM team_members m WHERE m.id=i.team_member_id AND m.team_id=i.team_id AND m.active=1)) OR (i.team_member_id IS NULL AND i.team_roster_member_id IS NOT NULL AND EXISTS(SELECT 1 FROM team_roster_members r LEFT JOIN team_members linked ON linked.id=r.linked_team_member_id WHERE r.id=i.team_roster_member_id AND r.team_id=i.team_id AND r.active=1 AND (r.linked_team_member_id IS NULL OR linked.active=1))) OR (i.team_member_id IS NULL AND i.team_roster_member_id IS NULL))))";
const participantTracks = [
	"180DC-VIT-CHENNAI/mazhai-cover",
	"180DC-VIT-CHENNAI/pricingpulse",
	"180DC-VIT-CHENNAI/veera-footwear",
	"180DC-VIT-CHENNAI/janus",
] as const;
export async function credentialIdentity(env: Env, token: string) {
	return env
		.ORG_DB!.prepare(
			`SELECT i.id,i.role FROM console_identities i WHERE i.credential_hash=? AND ${eligible}`,
		)
		.bind(await digest(token))
		.first<{ id: string; role: ConsoleRole }>();
}
export const identitySessionQuery =
	`SELECT s.hash,i.role,i.id AS identity_id,i.name,i.team_id FROM console_identity_sessions s JOIN console_identities i ON i.id=s.identity_id WHERE s.hash=? AND s.expires_at>? AND ${eligible}`;
const identityInput = z
	.object({
		name: z.string().trim().min(2).max(80),
		role: z.enum(["organizer", "judge", "security", "participant"]),
		teamId: z.string().min(1).max(80).optional(),
	})
	.strict();
export async function manageIdentities(
	request: Request,
	env: Env,
	session: ConsoleSession,
) {
	if (session.role !== "organizer") {
		return json({ error: "ORGANIZER_REQUIRED" }, 403);
	}
	const db = env.ORG_DB!,
		actor = "organizer:" + (session.identity_id ?? session.hash);
	const path = new URL(request.url).pathname.replace(
		"/api/organization/identities",
		"",
	);
	try {
		if (!path && request.method === "GET") {
			return json({
				identities: (
					await db
						.prepare(
							"SELECT id,name,role,team_id,created_at,revoked_at FROM console_identities ORDER BY created_at DESC,id LIMIT 200",
						)
						.all()
				).results,
			});
		}
		if (!path && request.method === "POST") {
			const data = identityInput.parse(
				JSON.parse(
					new TextDecoder().decode(await boundedBody(request, 4000)),
				),
			);
			if (data.role === "participant") {
				if (
					!data.teamId ||
					!(await db
						.prepare(
							"SELECT id FROM teams WHERE id=? AND status='ACTIVE'",
						)
						.bind(data.teamId)
						.first())
				) {
					return json({ error: "ACTIVE_TEAM_REQUIRED" }, 403);
				}
			} else if (data.teamId) {
				return json({ error: "TEAM_SCOPE_NOT_ALLOWED" }, 400);
			}
			const id = crypto.randomUUID();
			const bytes = crypto.getRandomValues(new Uint8Array(32));
			const credential = Array.from(
				bytes,
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
			await db.batch([
				db
					.prepare(
						"INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES(?,?,?,?,?)",
					)
					.bind(
						id,
						data.name,
						data.role,
						data.teamId ?? null,
						await digest(credential),
					),
				db
					.prepare(
						"INSERT INTO audit(action,entity,actor,changes) VALUES('identity.created',?,?,?)",
					)
					.bind(
						id,
						actor,
						JSON.stringify({
							name: data.name,
							role: data.role,
							teamId: data.teamId ?? null,
						}),
					),
			]);
			return json(
				{
					id,
					name: data.name,
					role: data.role,
					teamId: data.teamId ?? null,
					credential,
				},
				201,
			);
		}
		const revoke = path.match(/^\/([a-f0-9-]{36})\/revoke$/);
		if (revoke && request.method === "POST") {
			if (
				!(await db
					.prepare("SELECT id FROM console_identities WHERE id=?")
					.bind(revoke[1])
					.first())
			) {
				return json({ error: "NOT_FOUND" }, 404);
			}
			await db.batch([
				db
					.prepare(
						"UPDATE console_identities SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND revoked_at IS NULL",
					)
					.bind(revoke[1]),
				db
					.prepare(
						"DELETE FROM console_identity_sessions WHERE identity_id=?",
					)
					.bind(revoke[1]),
				db
					.prepare(
						"INSERT INTO audit(action,entity,actor) VALUES('identity.revoked',?,?)",
					)
					.bind(revoke[1], actor),
			]);
			return json({ id: revoke[1], revoked: true });
		}
		return json({ error: "NOT_FOUND" }, 404);
	} catch (error) {
		if (error instanceof z.ZodError || error instanceof SyntaxError) {
			return json({ error: "INVALID_INPUT" }, 400);
		}
		if (error instanceof Error && error.message === "BODY_LIMIT") {
			return json({ error: "BODY_LIMIT" }, 413);
		}
		return json({ error: "IDENTITY_MANAGEMENT_UNAVAILABLE" }, 503);
	}
}
export async function participantConsole(
	request: Request,
	env: Env,
	session: ConsoleSession,
) {
	if (session.role !== "participant" || !session.team_id) {
		return json({ error: "PARTICIPANT_REQUIRED" }, 403);
	}
	const db = env.ORG_DB!,
		path = new URL(request.url).pathname.replace(
			"/api/organization/participant",
			"",
		);
	const onboarding = session.identity_id
		? await db.prepare(
			"SELECT t.lead_email,COALESCE(m.email,r.email) AS email,t.track_finalized,(SELECT count(*) FROM team_repositories tr WHERE tr.team_id=t.id AND tr.active=1) AS selected_count,i.github_verified_at FROM console_identities i JOIN teams t ON t.id=i.team_id LEFT JOIN team_roster_members r ON r.id=i.team_roster_member_id AND r.active=1 LEFT JOIN team_members m ON m.id=COALESCE(i.team_member_id,r.linked_team_member_id) AND m.active=1 WHERE i.id=? AND i.role='participant' AND i.team_id=? AND i.revoked_at IS NULL AND t.status='ACTIVE' AND t.hackathon_id='initial'",
		).bind(session.identity_id, session.team_id).first<{
			lead_email: string | null;
			email: string | null;
			track_finalized: number;
			selected_count: number;
			github_verified_at: string | null;
		}>()
		: null;
	if (!onboarding) return json({ error: "TEAM_MEMBER_REQUIRED" }, 409);
	const isTeamLead = !!onboarding.lead_email && onboarding.email?.trim().toLowerCase() === onboarding.lead_email.trim().toLowerCase();
	const trackSelected = onboarding.track_finalized === 1 && onboarding.selected_count === 1;
	const githubLinked = !!onboarding.github_verified_at;
	if (path === "/status" && request.method === "GET") {
		return json({ isTeamLead, trackSelected, githubLinked, canEnterDashboard: trackSelected && githubLinked });
	}
	if (path === "/team-key" && request.method === "GET") {
		if (!isTeamLead || !trackSelected || !githubLinked) return json({ error: "TEAM_LEAD_ONBOARDING_REQUIRED" }, 403);
		const key = await teamAccessKey(env, session.team_id);
		return key ? json({ teamKey: key }) : json({ error: "TEAM_KEY_UNAVAILABLE" }, 503);
	}
	const onboardingRoutes = path === "/status" || path === "/github/link" || path === "/track-options" || (path === "/track" && request.method === "POST");
	if (path === "/track" && request.method === "POST" && !isTeamLead) return json({ error: "TEAM_LEAD_REQUIRED" }, 403);
	if (!onboardingRoutes && (!trackSelected || !githubLinked)) return json({ error: "PARTICIPANT_ONBOARDING_REQUIRED" }, 428);
	if (path === "/documents" || path.startsWith("/documents/")) {
		return participantDocuments(request, env, session);
	}
	if (path === "/github/link" && request.method === "POST") {
		if (!session.identity_id) {
			return json({ error: "PARTICIPANT_REQUIRED" }, 401);
		}
		const member = await db
			.prepare(
				"SELECT i.team_id,COALESCE(i.team_member_id,r.linked_team_member_id) AS member_id,i.team_roster_member_id,r.display_name AS roster_display_name,r.email AS roster_email,r.external_id AS roster_external_id,m.github_id,m.github_login FROM console_identities i LEFT JOIN team_roster_members r ON r.id=i.team_roster_member_id AND r.team_id=i.team_id AND r.active=1 LEFT JOIN team_members m ON m.id=COALESCE(i.team_member_id,r.linked_team_member_id) AND m.team_id=i.team_id AND m.active=1 WHERE i.id=? AND i.role='participant' AND i.team_id=? AND EXISTS(SELECT 1 FROM teams t WHERE t.id=i.team_id AND t.status='ACTIVE' AND t.hackathon_id='initial')",
			)
			.bind(session.identity_id, session.team_id)
			.first<{
				team_id: string;
				member_id: string | null;
				team_roster_member_id: string | null;
				roster_display_name: string | null;
				roster_email: string | null;
				roster_external_id: string | null;
				github_id: number | null;
				github_login: string | null;
			}>();
		if (!member) return json({ error: "TEAM_MEMBER_REQUIRED" }, 409);
		const linked = await arenaGithubIdentity(request, env);
		if (linked.status !== 200) {
			return json(
				{
					error: linked.status === 401
						? "GITHUB_SESSION_REQUIRED"
						: linked.status === 403
							? "GITHUB_IDENTITY_NOT_LINKED"
							: "GITHUB_LINK_UNAVAILABLE",
				},
				linked.status,
			);
		}
		let requestedLogin: string;
		try {
			requestedLogin = z.object({ login: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/) }).strict().parse(
				JSON.parse(new TextDecoder().decode(await boundedBody(request, 2000))),
			).login;
		} catch {
			return json({ error: "GITHUB_USERNAME_REQUIRED" }, 400);
		}
		if (requestedLogin.toLowerCase() !== linked.identity.login.toLowerCase()) {
			return json({ error: "GITHUB_USERNAME_MISMATCH" }, 409);
		}
		if (member.github_id !== null) {
			if (member.github_id !== linked.identity.id) {
				return json({ error: "GITHUB_IDENTITY_CHANGE_REQUIRES_ORGANIZER" }, 409);
			}
			if (member.github_login !== linked.identity.login) {
				const actor = "participant:" + session.identity_id;
				await db.batch([
					db.prepare("UPDATE team_members SET github_login=? WHERE id=? AND team_id=? AND active=1 AND github_id=?")
						.bind(linked.identity.login, member.member_id, member.team_id, linked.identity.id),
					db.prepare("INSERT INTO audit(action,entity,actor,changes) VALUES('team.github_identity_refreshed',?,?,?)")
						.bind(member.team_id, actor, JSON.stringify({ githubId: linked.identity.id, githubLogin: linked.identity.login })),
				]);
			}
			await db.prepare("UPDATE console_identities SET github_verified_at=COALESCE(github_verified_at,CURRENT_TIMESTAMP) WHERE id=? AND team_id=?").bind(session.identity_id, member.team_id).run();
			return json({ linked: true, github: { login: linked.identity.login }, unchanged: true });
		}
		const actor = "participant:" + session.identity_id;
		const conflict = await db
			.prepare(
				"SELECT id FROM team_members WHERE hackathon_id='initial' AND github_id=? AND active=1 AND (? IS NULL OR id<>?)",
			)
			.bind(linked.identity.id, member.member_id, member.member_id)
			.first();
		if (conflict) {
			return json({ error: "GITHUB_IDENTITY_ALREADY_ASSIGNED" }, 409);
		}
		let result: D1Result[];
		try {
			if (member.member_id) {
				result = await db.batch([
					db.prepare(
						"UPDATE team_members AS target SET github_id=?,github_login=? WHERE target.id=? AND target.team_id=? AND target.active=1 AND target.github_id IS NULL AND NOT EXISTS(SELECT 1 FROM team_members existing WHERE existing.hackathon_id=target.hackathon_id AND existing.github_id=? AND existing.active=1)",
					)
						.bind(linked.identity.id, linked.identity.login, member.member_id, member.team_id, linked.identity.id),
					db.prepare(
						"INSERT INTO audit(action,entity,actor,changes) SELECT 'team.github_identity_linked',?,?,? WHERE changes()>0",
					)
						.bind(member.team_id, actor, JSON.stringify({ githubId: linked.identity.id, githubLogin: linked.identity.login })),
				]);
			} else if (member.team_roster_member_id && member.roster_email) {
				const newMemberId = "member-" + crypto.randomUUID();
				result = await db.batch([
					db.prepare(
						"INSERT INTO team_members(id,team_id,hackathon_id,github_id,github_login,display_name,email,external_id) SELECT ?,r.team_id,r.hackathon_id,?,?,r.display_name,r.email,r.external_id FROM team_roster_members r WHERE r.id=? AND r.team_id=? AND r.active=1 AND r.linked_team_member_id IS NULL AND NOT EXISTS(SELECT 1 FROM team_members existing WHERE existing.hackathon_id=r.hackathon_id AND existing.github_id=? AND existing.active=1)",
					)
						.bind(newMemberId, linked.identity.id, linked.identity.login, member.team_roster_member_id, member.team_id, linked.identity.id),
					db.prepare(
						"UPDATE team_roster_members SET linked_team_member_id=? WHERE id=? AND team_id=? AND active=1 AND linked_team_member_id IS NULL AND EXISTS(SELECT 1 FROM team_members WHERE id=? AND team_id=? AND active=1)",
					)
						.bind(newMemberId, member.team_roster_member_id, member.team_id, newMemberId, member.team_id),
					db.prepare(
						"UPDATE console_identities SET team_member_id=? WHERE id=? AND role='participant' AND team_id=? AND team_roster_member_id=? AND team_member_id IS NULL AND EXISTS(SELECT 1 FROM team_roster_members WHERE id=? AND linked_team_member_id=?)",
					)
						.bind(newMemberId, session.identity_id, member.team_id, member.team_roster_member_id, member.team_roster_member_id, newMemberId),
					db.prepare(
						"INSERT INTO audit(action,entity,actor,changes) SELECT 'team.github_identity_linked',?,?,? WHERE changes()>0",
					)
						.bind(member.team_id, actor, JSON.stringify({ githubId: linked.identity.id, githubLogin: linked.identity.login })),
				]);
			} else {
				return json({ error: "TEAM_MEMBER_REQUIRED" }, 409);
			}
		} catch {
			return json({ error: "GITHUB_IDENTITY_ALREADY_ASSIGNED" }, 409);
		}
		if (!result[0]?.meta.changes) {
			const current = await db
				.prepare("SELECT m.github_id,m.github_login FROM console_identities i JOIN team_members m ON m.id=i.team_member_id WHERE i.id=? AND i.team_id=? AND m.active=1")
				.bind(session.identity_id, member.team_id)
				.first<{ github_id: number | null; github_login: string | null }>();
			if (current?.github_id === linked.identity.id) {
				await db.prepare("UPDATE console_identities SET github_verified_at=COALESCE(github_verified_at,CURRENT_TIMESTAMP) WHERE id=? AND team_id=?").bind(session.identity_id, member.team_id).run();
				return json({ linked: true, github: { login: current.github_login ?? linked.identity.login }, unchanged: true });
			}
			return json({ error: "GITHUB_IDENTITY_ALREADY_ASSIGNED" }, 409);
		}
		await db.prepare("UPDATE console_identities SET github_verified_at=CURRENT_TIMESTAMP WHERE id=? AND team_id=? AND role='participant' AND EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=? AND m.github_id=? AND m.active=1)").bind(session.identity_id, member.team_id, member.team_id, linked.identity.id).run();
		return json({ linked: true, github: { login: linked.identity.login } });
	}
	if (path === "/track" && request.method === "POST") {
		if (!isTeamLead) return json({ error: "TEAM_LEAD_REQUIRED" }, 403);
		let repositoryId: number;
		try {
			repositoryId = z
				.object({ repositoryId: z.number().int().positive() })
				.strict()
				.parse(
					JSON.parse(
						new TextDecoder().decode(
							await boundedBody(request, 2000),
						),
					),
				).repositoryId;
		} catch {
			return json({ error: "INVALID_INPUT" }, 400);
		}
		const requested = await db.prepare(
			"SELECT id,full_name FROM github_repositories WHERE id=? AND accessible=1 AND full_name IN('180DC-VIT-CHENNAI/mazhai-cover','180DC-VIT-CHENNAI/pricingpulse','180DC-VIT-CHENNAI/veera-footwear','180DC-VIT-CHENNAI/janus')",
		).bind(repositoryId).first<{ id: number; full_name: string }>();
		if (!requested) return json({ error: "TRACK_NOT_ALLOWED" }, 403);
		const current = await db.prepare(
			"SELECT t.track_finalized,r.id AS repository_id,r.full_name FROM teams t LEFT JOIN team_repositories tr ON tr.team_id=t.id AND tr.active=1 LEFT JOIN github_repositories r ON r.id=tr.repository_id WHERE t.id=? AND t.hackathon_id='initial' AND t.status='ACTIVE'",
		).bind(session.team_id).first<{ track_finalized: number; repository_id: number | null; full_name: string | null }>();
		if (!current) return json({ error: "UNAUTHORIZED" }, 401);
		if (current.track_finalized === 1) {
			return current.repository_id === requested.id
				? json({ track: { repositoryId: requested.id, fullName: requested.full_name }, unchanged: true })
				: json({ error: "TRACK_FINALIZED" }, 409);
		}
		const actor = "participant:" + session.identity_id;
		const eventId = crypto.randomUUID();
		try {
			const saved = await db.batch([
				db.prepare("INSERT INTO audit(action,entity,actor,changes) VALUES('team.track_selected',?,?,?)").bind(session.team_id, actor, JSON.stringify({ eventId, previousRepositoryIds: current.repository_id === null ? [] : [current.repository_id], repositoryId: requested.id, fullName: requested.full_name })),
				db.prepare("UPDATE team_repositories SET active=0,actor=?,assigned_at=CURRENT_TIMESTAMP WHERE team_id=? AND active=1 AND EXISTS(SELECT 1 FROM audit WHERE action='team.track_selected' AND entity=? AND actor=? AND json_extract(changes,'$.eventId')=?)").bind(actor, session.team_id, session.team_id, actor, eventId),
				db.prepare("INSERT INTO team_repositories(team_id,repository_id,actor) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM github_repositories r WHERE r.id=? AND r.accessible=1 AND r.full_name IN('180DC-VIT-CHENNAI/mazhai-cover','180DC-VIT-CHENNAI/pricingpulse','180DC-VIT-CHENNAI/veera-footwear','180DC-VIT-CHENNAI/janus')) AND EXISTS(SELECT 1 FROM audit WHERE action='team.track_selected' AND entity=? AND actor=? AND json_extract(changes,'$.eventId')=?) ON CONFLICT(team_id,repository_id) DO UPDATE SET active=1,actor=excluded.actor,assigned_at=CURRENT_TIMESTAMP").bind(session.team_id, requested.id, actor, requested.id, session.team_id, actor, eventId),
				db.prepare("UPDATE teams SET track_finalized=1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND track_finalized=0 AND status='ACTIVE' AND (SELECT count(*) FROM team_repositories WHERE team_id=? AND active=1)=1 AND EXISTS(SELECT 1 FROM team_repositories tr JOIN github_repositories r ON r.id=tr.repository_id WHERE tr.team_id=? AND tr.repository_id=? AND tr.active=1 AND r.accessible=1 AND r.full_name IN('180DC-VIT-CHENNAI/mazhai-cover','180DC-VIT-CHENNAI/pricingpulse','180DC-VIT-CHENNAI/veera-footwear','180DC-VIT-CHENNAI/janus')) AND EXISTS(SELECT 1 FROM audit WHERE action='team.track_selected' AND entity=? AND actor=? AND json_extract(changes,'$.eventId')=?)").bind(session.team_id, session.team_id, session.team_id, requested.id, session.team_id, actor, eventId),
			]);
			if (!saved[0]?.meta.changes) return json({ error: "SERVICE_UNAVAILABLE" }, 503);
			if (!saved[3]?.meta.changes) return json({ error: "TRACK_FINALIZED" }, 409);
		} catch {
			return json({ error: "TRACK_FINALIZED" }, 409);
		}
		return json({ track: { repositoryId: requested.id, fullName: requested.full_name } });
	}
	if (path === "/track-options" && request.method === "GET") {
		const repositories = await db
			.prepare(
				"SELECT id AS repositoryId,full_name AS fullName FROM github_repositories WHERE accessible=1 AND full_name IN(?,?,?,?) ORDER BY id",
			)
			.bind(...participantTracks)
			.all<{ repositoryId: number; fullName: string }>();
		return json({ repositories: repositories.results });
	}
	if (path === "/results" && request.method === "GET") {
		const team = await db
			.prepare(
				"SELECT id FROM teams WHERE id=? AND hackathon_id='initial' AND status='ACTIVE'",
			)
			.bind(session.team_id)
			.first();
		if (!team) return json({ error: "UNAUTHORIZED" }, 401);
		const publication = await db
			.prepare(
				"SELECT s.id AS snapshotId,s.snapshot FROM round_two_result_publication p JOIN round_two_result_snapshots s ON s.id=p.snapshot_id WHERE p.id=1 AND p.snapshot_id IS NOT NULL AND p.published_at IS NOT NULL",
			)
			.first<{ snapshotId: string; snapshot: string }>();
		if (!publication) return json({ published: false });
		try {
			const snapshot = JSON.parse(publication.snapshot) as {
				results?: Array<Record<string, unknown> & { teamId?: string }>;
				ranking?: Array<Record<string, unknown> & { teamId?: string }>;
			};
			const results = (snapshot.results ?? [])
				.filter((result) => result.teamId === session.team_id)
				.map((result) => Object.fromEntries(
					["teamId", "teamName", "track", "repositorySelection", "analysisAverage", "engineeringAverage", "status", "finalScore", "feedback", "feedbackTruncated"]
						.filter((key) => key in result)
						.map((key) => [key, result[key]]),
				));
			const ranking = (snapshot.ranking ?? [])
				.filter((result) => result.teamId === session.team_id)
				.map((result) => Object.fromEntries(
					["teamId", "teamName", "track", "rank", "finalScore", "status"]
						.filter((key) => key in result)
						.map((key) => [key, result[key]]),
				));
			const response: {
				published: true;
				results: typeof results;
				ranking: typeof ranking;
				sharedStageScores?: Awaited<ReturnType<typeof participantSharedScores>>;
			} = {
				published: true,
				results,
				ranking,
			};
			const sharedStageScores = await participantSharedScores(
				db,
				session.team_id,
				publication.snapshotId,
			);
			if (sharedStageScores.length) response.sharedStageScores = sharedStageScores;
			return json(response);
		} catch {
			return json({ error: "RESULTS_UNAVAILABLE" }, 503);
		}
	}
	if (request.method !== "GET") {
		return json({ error: "READ_ONLY_SCOPE" }, 403);
	}
	if (!path) {
		const team = await db
			.prepare(
				"SELECT id,name,status FROM teams WHERE id=? AND status='ACTIVE'",
			)
			.bind(session.team_id)
			.first();
		if (!team) return json({ error: "UNAUTHORIZED" }, 401);
		const track = await db
			.prepare(
				"SELECT r.id,r.full_name FROM team_repositories t JOIN github_repositories r ON r.id=t.repository_id WHERE t.team_id=? AND t.active=1 ORDER BY t.assigned_at DESC LIMIT 1",
			)
			.bind(session.team_id)
			.first<{ id: number; full_name: string }>();
		const submissions = (
			await db
				.prepare(
					"SELECT s.repository_id,s.pr_number,s.head_sha,s.latest_run_id,s.status,s.issue_numbers,s.github_updated_at,r.full_name FROM submissions s JOIN github_repositories r ON r.id=s.repository_id WHERE s.team_id=? ORDER BY s.github_updated_at DESC LIMIT 100",
				)
				.bind(session.team_id)
				.all()
		).results;
		const evaluations = (
			await db
				.prepare(
					"SELECT e.id,e.repository_id,e.pr_number,e.head_sha,e.baseline_sha,e.state,e.ai_status,e.created_at FROM evaluations e JOIN submissions s ON s.repository_id=e.repository_id AND s.pr_number=e.pr_number WHERE s.team_id=? AND json_extract(e.assignment_snapshot,'$.team_id')=? ORDER BY e.created_at DESC,e.id LIMIT 100",
				)
				.bind(session.team_id, session.team_id)
				.all()
		).results;
		const members = (
			await db
				.prepare(
					"SELECT id,display_name,email,github_login,github_linked FROM (SELECT m.id,m.display_name,m.email,m.github_login,m.github_id IS NOT NULL AS github_linked,m.created_at FROM team_members m WHERE m.team_id=? AND m.active=1 AND NOT EXISTS(SELECT 1 FROM team_roster_members r WHERE r.linked_team_member_id=m.id AND r.active=1) UNION ALL SELECT r.id,r.display_name,r.email,m.github_login,COALESCE(m.github_id IS NOT NULL,0) AS github_linked,r.created_at FROM team_roster_members r LEFT JOIN team_members m ON m.id=r.linked_team_member_id AND m.active=1 WHERE r.team_id=? AND r.active=1) ORDER BY created_at,id",
				)
				.bind(session.team_id, session.team_id)
				.all<{
					id: string;
					display_name: string;
					email: string | null;
					github_login: string | null;
					github_linked: number;
				}>()
		).results.map((member) => ({
			displayName: member.display_name,
			email: member.email,
			githubLogin: member.github_login,
			githubLinked: Boolean(member.github_linked),
		}));
		const currentMember = session.identity_id
			? await db
				.prepare(
					"SELECT COALESCE(m.display_name,r.display_name) AS display_name,COALESCE(m.email,r.email) AS email,m.github_login,COALESCE(m.github_id IS NOT NULL,0) AS github_linked FROM console_identities i LEFT JOIN team_roster_members r ON r.id=i.team_roster_member_id AND r.team_id=i.team_id AND r.active=1 LEFT JOIN team_members m ON m.id=COALESCE(i.team_member_id,r.linked_team_member_id) AND m.team_id=i.team_id AND m.active=1 WHERE i.id=? AND i.team_id=? AND (m.id IS NOT NULL OR r.id IS NOT NULL)",
				)
				.bind(session.identity_id, session.team_id)
				.first<{
					display_name: string;
					email: string | null;
					github_login: string | null;
					github_linked: number;
				}>()
			: null;
		return json({
			team,
			members,
			currentMember: currentMember
				? {
					displayName: currentMember.display_name,
					email: currentMember.email,
					githubLogin: currentMember.github_login,
					githubLinked: Boolean(currentMember.github_linked),
				}
				: null,
			track: track
				? { repositoryId: track.id, fullName: track.full_name }
				: null,
			submissions,
			evaluations,
		});
	}
	const match = path.match(/^\/evaluations\/([a-f0-9]{64})$/);
	if (!match) return json({ error: "NOT_FOUND" }, 404);
	const run = await db
		.prepare(
			"SELECT e.id,e.repository_id,e.pr_number,e.head_sha,e.baseline_sha,e.state,e.ai_status,e.contract_snapshot,e.evidence FROM evaluations e JOIN submissions s ON s.repository_id=e.repository_id AND s.pr_number=e.pr_number WHERE e.id=? AND s.team_id=? AND json_extract(e.assignment_snapshot,'$.team_id')=?",
		)
		.bind(match[1], session.team_id, session.team_id)
		.first<{
			id: string;
			repository_id: number;
			pr_number: number;
			head_sha: string;
			baseline_sha: string;
			state: string;
			ai_status: string | null;
			contract_snapshot: string;
			evidence: string | null;
		}>();
	if (!run) return json({ error: "NOT_FOUND" }, 404);
	try {
		const contract = contractSchema.parse(
			JSON.parse(run.contract_snapshot),
		);
		const evidence = JSON.parse(run.evidence ?? "[]") as Evidence[];
		return json({
			evaluation: {
				id: run.id,
				repositoryId: run.repository_id,
				prNumber: run.pr_number,
				headSha: run.head_sha,
				baselineSha: run.baseline_sha,
				state: run.state,
				aiStatus: run.ai_status,
			},
			requirements: requirementOutcomes(contract, evidence),
		});
	} catch {
		return json({ error: "EVALUATION_UNAVAILABLE" }, 503);
	}
}
