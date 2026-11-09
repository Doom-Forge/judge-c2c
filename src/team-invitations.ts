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
			const code = await inviteCode(env, row.team_id, row.nonce);
			const response = await env.TEAM_EMAIL_SENDER.fetch(
				new Request("https://team-email-sender.internal/send", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						idempotencyKey: row.idempotency_key,
						to: row.recipient,
						subject: `Doomforge team sign-in for ${row.name}`,
						body:
							`Your shared team sign-in code is ${code}. It expires in 7 days and can be used once per imported member email.`,
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
) {
	const db = env.ORG_DB!;
	const timestamp = Date.parse(now);
	const email = rawEmail.trim().toLowerCase();
	const bucket = await digest(
		bucketId + ":" + Math.floor(timestamp / 60_000),
	);
	await db.prepare(
		"DELETE FROM participant_verification_limits WHERE expires_at<=?",
	).bind(timestamp).run();
	await db.prepare(
		"INSERT INTO participant_verification_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1",
	).bind(bucket, timestamp + 60_000).run();
	const rate = await db.prepare(
		"SELECT count FROM participant_verification_limits WHERE bucket=?",
	).bind(bucket).first<{ count: number }>();
	if ((rate?.count ?? 0) > 10) return { status: 429 as const };
	const candidates = await db.prepare(
		"SELECT roster.*,c.code_hash,c.expires_at FROM (SELECT t.id AS team_id,t.name AS team_name,m.id AS member_id,NULL AS roster_member_id,m.display_name,m.email,m.github_id,m.github_login FROM teams t JOIN team_members m ON m.team_id=t.id AND m.active=1 WHERE t.hackathon_id='initial' AND t.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM team_roster_members r WHERE r.linked_team_member_id=m.id AND r.active=1) UNION ALL SELECT t.id AS team_id,t.name AS team_name,r.linked_team_member_id AS member_id,r.id AS roster_member_id,COALESCE(m.display_name,r.display_name) AS display_name,r.email,m.github_id,m.github_login FROM teams t JOIN team_roster_members r ON r.team_id=t.id AND r.active=1 LEFT JOIN team_members m ON m.id=r.linked_team_member_id WHERE t.hackathon_id='initial' AND t.status='ACTIVE' AND (r.linked_team_member_id IS NULL OR m.active=1)) roster JOIN team_invitation_codes c ON c.team_id=roster.team_id WHERE lower(trim(roster.email))=?",
	).bind(email).all<{
		team_id: string;
		team_name: string;
		member_id: string | null;
		roster_member_id: string | null;
		display_name: string;
		email: string;
		github_id: number | null;
		github_login: string | null;
		code_hash: string;
		expires_at: number;
	}>();
	for (const row of candidates.results) {
		if (
			row.expires_at <= timestamp ||
			!constantTimeEqual(await digest(code), row.code_hash)
		) continue;
		const already = await db.prepare(
			"SELECT identity_id FROM team_invitation_uses WHERE team_id=? AND email=?",
		).bind(row.team_id, email).first();
		if (already) return { status: 409 as const };
		const identityId = crypto.randomUUID();
		const token = hex(crypto.getRandomValues(new Uint8Array(32)));
		const sessionHash = await digest(token);
		const identity = db.prepare(
		"INSERT INTO console_identities(id,name,role,team_id,team_member_id,team_roster_member_id,credential_hash) SELECT ?,?,'participant',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM team_invitation_uses WHERE team_id=? AND email=?) AND EXISTS(SELECT 1 FROM teams t JOIN team_invitation_codes c ON c.team_id=t.id WHERE t.id=? AND t.status='ACTIVE' AND t.hackathon_id='initial' AND c.code_hash=? AND c.expires_at>? AND ((? IS NOT NULL AND EXISTS(SELECT 1 FROM team_members m WHERE m.id=? AND m.team_id=t.id AND m.active=1 AND lower(trim(m.email))=?)) OR (? IS NOT NULL AND EXISTS(SELECT 1 FROM team_roster_members r WHERE r.id=? AND r.team_id=t.id AND r.active=1 AND lower(trim(r.email))=?))) )",
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
			row.code_hash,
			timestamp,
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
		const session = db.prepare(
			"INSERT INTO console_identity_sessions(hash,identity_id,expires_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM team_invitation_uses WHERE team_id=? AND email=? AND identity_id=?)",
		).bind(
			sessionHash,
			identityId,
			timestamp + 28_800_000,
			row.team_id,
			email,
			identityId,
		);
		const result = await db.batch([identity, used, session]);
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
					githubLinked: row.github_id !== null,
					githubLogin: row.github_login,
				},
			};
		}
		return { status: 409 as const };
	}
	return { status: 401 as const };
}
