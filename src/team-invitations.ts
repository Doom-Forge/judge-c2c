import type { Env } from "./env";
import { digest } from "./domain";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function constantTimeEqual(left: string, right: string) {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index++) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}
const hex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
async function overRateLimit(db: D1Database, bucket: string, limit: number, expiresAt: number) {
	await db.prepare("INSERT INTO participant_verification_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1,expires_at=excluded.expires_at").bind(bucket, expiresAt).run();
	const row = await db.prepare("SELECT count FROM participant_verification_limits WHERE bucket=?").bind(bucket).first<{ count: number }>();
	return (row?.count ?? 0) > limit;
}
async function inviteCode(env: Env, teamId: string, nonce: string) {
	const value = env.ORG_VAULT_KEY;
	if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
		throw new Error("ORG_VAULT_KEY_REQUIRED");
	}
	const key = await crypto.subtle.importKey(
		"raw",
		Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(
				`team-invite:${env.ORG_NAME}:${teamId}:${nonce}`,
			),
		),
	);
	return Array.from(bytes.slice(0, 12), (byte) => alphabet[byte & 31]).join(
		"",
	);
}
export async function teamAccessKey(env: Env, teamId: string) {
	const row = await env.ORG_DB!.prepare(
		"SELECT c.nonce FROM team_invitation_codes c JOIN teams t ON t.id=c.team_id WHERE c.team_id=? AND t.track_finalized=1 AND (SELECT count(*) FROM team_repositories r WHERE r.team_id=t.id AND r.active=1)=1",
	).bind(teamId).first<{ nonce: string }>();
	if (!row) return null;
	return inviteCode(env, teamId, row.nonce);
}
export async function onboardingStatements(
	env: Env,
	team: { id: string; leadEmail?: string },
) {
	if (!team.leadEmail) return [];
	const db = env.ORG_DB!;
	const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
	const code = await inviteCode(env, team.id, nonce);
	return [
		db.prepare(
			"INSERT INTO team_invitation_codes(team_id,code_hash,nonce,expires_at) VALUES(?,?,?,?)",
		).bind(
			team.id,
			await digest(code),
			nonce,
			Date.now() + 7 * 24 * 60 * 60_000,
		),
		db.prepare(
			"INSERT INTO team_invitations(idempotency_key,team_id,recipient,status) VALUES(?,?,?,'PENDING')",
		).bind(
			"team-invite:" + team.id,
			team.id,
			team.leadEmail.trim().toLowerCase(),
		),
	];
}
export async function dispatchTeamInvitations(env: Env, now = Date.now()) {
	if (!env.ORG_DB || !env.TEAM_EMAIL_SENDER) return;
	const db = env.ORG_DB;
	const rows = await db.prepare(
		"SELECT i.idempotency_key,i.team_id,i.recipient,c.nonce,t.name FROM team_invitations i JOIN team_invitation_codes c ON c.team_id=i.team_id JOIN teams t ON t.id=i.team_id WHERE (i.status IN('PENDING','FAILED') OR (i.status='SENDING' AND i.lease_until<=?)) AND c.expires_at>? ORDER BY i.created_at LIMIT 50",
	).bind(now, now).all<{
		idempotency_key: string;
		team_id: string;
		recipient: string;
		nonce: string;
		name: string;
	}>();
	for (const row of rows.results) {
		const claim = await db.prepare(
			"UPDATE team_invitations SET status='SENDING',attempts=attempts+1,lease_until=?,last_error=NULL,updated_at=? WHERE idempotency_key=? AND attempts<5 AND (status IN('PENDING','FAILED') OR lease_until<=?)",
		).bind(now + 600_000, now, row.idempotency_key, now).run();
		if (!claim.meta.changes) continue;
		try {
			const response = await env.TEAM_EMAIL_SENDER.fetch(
				new Request("https://team-email-sender.internal/send", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						idempotencyKey: row.idempotency_key,
						to: row.recipient,
						subject: `Doomforge team sign-in for ${row.name}`,
						body: `Your team is registered on Doomforge. Visit the dashboard and request a one-time sign-in code for this email address. The team access key will be shared by your verified team lead after repository selection.`,
					}),
				}),
			);
			if (!response.ok) throw new Error("SENDER_REJECTED");
			await db.prepare(
				"UPDATE team_invitations SET status='SENT',lease_until=NULL,last_error=NULL,updated_at=? WHERE idempotency_key=? AND status='SENDING'",
			).bind(now, row.idempotency_key).run();
		} catch {
			await db.prepare(
				"UPDATE team_invitations SET status='FAILED',lease_until=NULL,last_error='SENDER_REJECTED',updated_at=? WHERE idempotency_key=? AND status='SENDING'",
			).bind(now, row.idempotency_key).run();
		}
	}
}
export async function verifyParticipant(
	env: Env,
	rawEmail: string,
	code: string,
	now = new Date().toISOString(),
	bucketId = "test",
	rawTeamKey?: string,
) {
	const db = env.ORG_DB!;
	const timestamp = Date.parse(now);
	const email = rawEmail.trim().toLowerCase();
	const bucket = await digest(`participant-verify:ip:${bucketId}:${Math.floor(timestamp / 60_000)}`);
	const emailBucket = await digest(`participant-verify:email:${email}:${Math.floor(timestamp / 60_000)}`);
	await db.prepare(
		"DELETE FROM participant_verification_limits WHERE expires_at<=?",
	).bind(timestamp).run();
	if (await overRateLimit(db, bucket, 10, timestamp + 60_000) || await overRateLimit(db, emailBucket, 10, timestamp + 60_000)) return { status: 429 as const };
	const candidates = await db.prepare(
		"SELECT roster.*,c.code_hash,c.nonce,c.expires_at,t.lead_email,t.track_finalized,(SELECT count(*) FROM team_repositories tr WHERE tr.team_id=t.id AND tr.active=1) AS selected_count FROM (SELECT t.id AS team_id,t.name AS team_name,m.id AS member_id,NULL AS roster_member_id,m.display_name,m.email,m.github_id,m.github_login FROM teams t JOIN team_members m ON m.team_id=t.id AND m.active=1 WHERE t.hackathon_id='initial' AND t.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM team_roster_members r WHERE r.linked_team_member_id=m.id AND r.active=1) UNION ALL SELECT t.id AS team_id,t.name AS team_name,r.linked_team_member_id AS member_id,r.id AS roster_member_id,COALESCE(m.display_name,r.display_name) AS display_name,r.email,m.github_id,m.github_login FROM teams t JOIN team_roster_members r ON r.team_id=t.id AND r.active=1 LEFT JOIN team_members m ON m.id=r.linked_team_member_id AND m.active=1 WHERE t.hackathon_id='initial' AND t.status='ACTIVE' AND (r.linked_team_member_id IS NULL OR m.active=1)) roster JOIN teams t ON t.id=roster.team_id LEFT JOIN team_invitation_codes c ON c.team_id=roster.team_id WHERE lower(trim(roster.email))=?",
	).bind(email).all<{
		team_id: string;
		team_name: string;
		member_id: string | null;
		roster_member_id: string | null;
		display_name: string;
		email: string;
		github_id: number | null;
		github_login: string | null;
		code_hash: string | null;
		nonce: string | null;
		expires_at: number | null;
		lead_email: string | null;
		track_finalized: number;
		selected_count: number;
	}>();
	for (const row of candidates.results) {
		const codeHash = await digest(code);
		const loginCode = await db.prepare(
			"SELECT id FROM participant_email_login_codes WHERE email=? AND code_hash=? AND expires_at>? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
		).bind(email, codeHash, timestamp).first<{ id: string }>();
		if (loginCode && candidates.results.length !== 1) return { status: 409 as const };
		const isTeamLead = row.lead_email?.trim().toLowerCase() === email;
		if (!loginCode || (!isTeamLead && (row.track_finalized !== 1 || row.selected_count !== 1))) continue;
		const already = await db.prepare(
			"SELECT identity_id FROM team_invitation_uses WHERE team_id=? AND email=?",
		).bind(row.team_id, email).first();
		if (!isTeamLead) {
			if (!rawTeamKey || !row.code_hash || !row.nonce) continue;
			const teamKeyHash = await digest(rawTeamKey.trim().toUpperCase());
			if (!constantTimeEqual(teamKeyHash, row.code_hash)) continue;
		}
		if (already && loginCode) {
			const token = hex(crypto.getRandomValues(new Uint8Array(32)));
			const useNonce = crypto.randomUUID();
			const identity = await db.prepare(
				"SELECT i.id FROM console_identities i WHERE i.id=? AND i.team_id=? AND i.role='participant' AND i.revoked_at IS NULL",
			).bind((already as { identity_id: string }).identity_id, row.team_id).first<{ id: string }>();
			if (!identity) return { status: 409 as const };
			const result = await db.batch([
				db.prepare("UPDATE participant_email_login_codes SET used_at=?,used_nonce=? WHERE id=? AND used_at IS NULL AND expires_at>?").bind(timestamp, useNonce, loginCode.id, timestamp),
				db.prepare(`INSERT INTO console_identity_sessions(hash,identity_id,expires_at)
				 SELECT ?,?,?
				 WHERE EXISTS(SELECT 1 FROM participant_email_login_codes WHERE id=? AND used_nonce=?)
				 AND EXISTS(SELECT 1 FROM team_invitation_uses WHERE team_id=? AND email=? AND identity_id=?)
				 AND EXISTS(SELECT 1 FROM teams WHERE id=? AND status='ACTIVE' AND hackathon_id='initial')
				 AND (
				   (? IS NOT NULL AND EXISTS(SELECT 1 FROM team_members m WHERE m.id=? AND m.team_id=? AND m.active=1 AND lower(trim(m.email))=?))
				   OR (? IS NOT NULL AND EXISTS(
				     SELECT 1 FROM team_roster_members r WHERE r.id=? AND r.team_id=? AND r.active=1 AND lower(trim(r.email))=?
				     AND (r.linked_team_member_id IS NULL OR EXISTS(SELECT 1 FROM team_members m WHERE m.id=r.linked_team_member_id AND m.active=1))
				   ))
				 )`).bind(await digest(token), identity.id, timestamp + 28_800_000, loginCode.id, useNonce, row.team_id, email, identity.id, row.team_id, row.member_id, row.member_id, row.team_id, email, row.roster_member_id, row.roster_member_id, row.team_id, email),
			]);
			if (result[0]?.meta.changes && result[1]?.meta.changes) {
				return { status: 200 as const, identityId: identity.id, token, participant: { teamId: row.team_id, teamName: row.team_name, displayName: row.display_name, email: row.email, isTeamLead, trackSelected: row.track_finalized === 1 && row.selected_count === 1, githubLinked: false, githubLogin: null } };
			}
			return { status: 409 as const };
		}
		if (already) return { status: 409 as const };
		const identityId = crypto.randomUUID();
		const token = hex(crypto.getRandomValues(new Uint8Array(32)));
		const sessionHash = await digest(token);
		const identity = db.prepare(
		"INSERT INTO console_identities(id,name,role,team_id,team_member_id,team_roster_member_id,credential_hash) SELECT ?,?,'participant',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM team_invitation_uses WHERE team_id=? AND email=?) AND EXISTS(SELECT 1 FROM teams t WHERE t.id=? AND t.status='ACTIVE' AND t.hackathon_id='initial' AND EXISTS(SELECT 1 FROM participant_email_login_codes p WHERE p.id=? AND p.email=? AND p.used_at IS NULL AND p.expires_at>?) AND (?=1 OR (t.track_finalized=1 AND (SELECT count(*) FROM team_repositories tr WHERE tr.team_id=t.id AND tr.active=1)=1)) AND ((? IS NOT NULL AND EXISTS(SELECT 1 FROM team_members m WHERE m.id=? AND m.team_id=t.id AND m.active=1 AND lower(trim(m.email))=?)) OR (? IS NOT NULL AND EXISTS(SELECT 1 FROM team_roster_members r WHERE r.id=? AND r.team_id=t.id AND r.active=1 AND lower(trim(r.email))=?))) )",
		).bind(
			identityId,
			row.display_name,
			row.team_id,
			row.member_id,
			row.roster_member_id,
			await digest(token),
			row.team_id,
			email,
			row.team_id,
			loginCode?.id ?? null,
			email,
			timestamp,
			isTeamLead ? 1 : 0,
			row.member_id,
			row.member_id,
			email,
			row.roster_member_id,
			row.roster_member_id,
			email,
		);
		const used = db.prepare(
			"INSERT OR IGNORE INTO team_invitation_uses(team_id,email,identity_id) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM console_identities WHERE id=?)",
		).bind(row.team_id, email, identityId, identityId);
		const useNonce = crypto.randomUUID();
		const consumeCode = db.prepare(
			"UPDATE participant_email_login_codes SET used_at=?,used_nonce=? WHERE id=? AND used_at IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM team_invitation_uses WHERE team_id=? AND email=? AND identity_id=?)",
		).bind(timestamp, useNonce, loginCode?.id ?? null, timestamp, row.team_id, email, identityId);
		const session = db.prepare(
			`INSERT INTO console_identity_sessions(hash,identity_id,expires_at)
			 SELECT ?,?,?
			 WHERE EXISTS(SELECT 1 FROM team_invitation_uses WHERE team_id=? AND email=? AND identity_id=?)
			 AND (? IS NULL OR EXISTS(SELECT 1 FROM participant_email_login_codes WHERE id=? AND used_nonce=?))
			 AND EXISTS(
			   SELECT 1 FROM teams t WHERE t.id=? AND t.status='ACTIVE' AND t.hackathon_id='initial'
			   AND (
			     (? IS NOT NULL AND EXISTS(SELECT 1 FROM team_members m WHERE m.id=? AND m.team_id=t.id AND m.active=1 AND lower(trim(m.email))=?))
			     OR (? IS NOT NULL AND EXISTS(
			       SELECT 1 FROM team_roster_members r WHERE r.id=? AND r.team_id=t.id AND r.active=1 AND lower(trim(r.email))=?
			       AND (r.linked_team_member_id IS NULL OR EXISTS(SELECT 1 FROM team_members m WHERE m.id=r.linked_team_member_id AND m.active=1))
			     ))
			   )
			 )`,
		).bind(sessionHash, identityId, timestamp + 28_800_000, row.team_id, email, identityId, loginCode?.id ?? null, loginCode?.id ?? null, useNonce, row.team_id, row.member_id, row.member_id, email, row.roster_member_id, row.roster_member_id, email);
		const result = await db.batch([identity, used, consumeCode, session]);
		if (result[0]?.meta.changes && result[1]?.meta.changes) {
			return {
				status: 200 as const,
				identityId,
				token,
				participant: {
					teamId: row.team_id,
					teamName: row.team_name,
					displayName: row.display_name,
					email: row.email,
					isTeamLead,
					trackSelected: row.track_finalized === 1 && row.selected_count === 1,
					githubLinked: false,
					githubLogin: null,
				},
			};
		}
		return { status: 409 as const };
	}
	return { status: 401 as const };
}

export async function requestParticipantLoginCode(
	env: Env,
	rawEmail: string,
	now = Date.now(),
	bucketId = "local",
	rawTeamKey?: string,
) {
	const db = env.ORG_DB;
	if (!db || !env.TEAM_EMAIL_SENDER) return { status: 503 as const };
	const email = rawEmail.trim().toLowerCase();
	const window = Math.floor(now / 900_000);
	const ipBucket = await digest(`participant-login:ip:${bucketId}:${window}`);
	const emailBucket = await digest(`participant-login:email:${email}:${window}`);
	await db.prepare("DELETE FROM participant_verification_limits WHERE expires_at<=?").bind(now).run();
	const ipLimited = await overRateLimit(db, ipBucket, 30, now + 900_000);
	const emailLimited = await overRateLimit(db, emailBucket, 3, now + 900_000);
	if (ipLimited || emailLimited) return { status: 429 as const };
	const recipients = await db.prepare(
		"SELECT members.team_id,t.name AS team_name,t.lead_email,t.track_finalized,(SELECT count(*) FROM team_repositories tr WHERE tr.team_id=t.id AND tr.active=1) AS selected_count,c.code_hash,(SELECT identity_id FROM team_invitation_uses u WHERE u.team_id=t.id AND u.email=members.email) AS existing_identity FROM (SELECT t.id AS team_id,m.id AS participant_id,lower(trim(m.email)) AS email FROM teams t JOIN team_members m ON m.team_id=t.id AND m.active=1 WHERE t.hackathon_id='initial' AND t.status='ACTIVE' AND lower(trim(m.email))=? AND NOT EXISTS(SELECT 1 FROM team_roster_members r WHERE r.linked_team_member_id=m.id AND r.active=1) UNION ALL SELECT t.id AS team_id,r.id AS participant_id,lower(trim(r.email)) AS email FROM teams t JOIN team_roster_members r ON r.team_id=t.id AND r.active=1 LEFT JOIN team_members m ON m.id=r.linked_team_member_id AND m.active=1 WHERE t.hackathon_id='initial' AND t.status='ACTIVE' AND lower(trim(r.email))=? AND (r.linked_team_member_id IS NULL OR m.active=1)) members JOIN teams t ON t.id=members.team_id LEFT JOIN team_invitation_codes c ON c.team_id=t.id ORDER BY members.team_id,members.participant_id LIMIT 2",
	).bind(email, email).all<{ team_id: string; team_name: string; lead_email: string | null; track_finalized: number; selected_count: number; code_hash: string | null; existing_identity: string | null }>();
	if (recipients.results.length !== 1) return { status: 202 as const };
	const recipient = recipients.results[0]!;
	const isLead = recipient.lead_email?.trim().toLowerCase() === email;
	if (!isLead) {
		if (recipient.track_finalized !== 1 || recipient.selected_count !== 1 || !rawTeamKey || !recipient.code_hash || !constantTimeEqual(await digest(rawTeamKey.trim().toUpperCase()), recipient.code_hash)) return { status: 202 as const };
	}
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const code = Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => alphabet[byte & 31]).join("");
	const id = crypto.randomUUID();
	const expiresAt = now + 10 * 60_000;
	await db.prepare("DELETE FROM participant_email_login_codes WHERE expires_at<=? OR used_at IS NOT NULL").bind(now).run();
	await db.prepare("INSERT INTO participant_email_login_codes(id,email,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)").bind(id, email, await digest(code), expiresAt, now).run();
	try {
		const response = await env.TEAM_EMAIL_SENDER.fetch(new Request("https://team-email-sender.internal/send", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				idempotencyKey: `participant-login:${id}`,
				to: email,
				subject: `Your Doomforge sign-in code for ${recipient.team_name}`,
				body: `Your Doomforge sign-in code is ${code}. It expires in 10 minutes and can be used once. If you did not request it, ignore this email.`,
			}),
		}));
		if (!response.ok) throw new Error("SENDER_REJECTED");
	} catch {
		await db.prepare("DELETE FROM participant_email_login_codes WHERE id=?").bind(id).run();
		return { status: 202 as const };
	}
	return { status: 202 as const };
}
