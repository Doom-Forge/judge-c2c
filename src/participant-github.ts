import { z } from "zod";
import { digest } from "./domain";
import type { Env } from "./env";

const githubIdentitySchema = z
	.object({
		success: z.literal(true),
		data: z
			.object({
				githubIdentity: z
					.object({
						id: z.number().int().positive().safe(),
						login: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();

export async function arenaGithubIdentity(request: Request, env: Env) {
	if (!env.ARENA_SERVICE) return { status: 503 as const };
	const cookie = request.headers.get("cookie");
	if (!cookie) return { status: 401 as const };
	try {
		const target = new URL("/api/auth/github-identity", env.ORG_PUBLIC_ORIGIN);
		const response = await env.ARENA_SERVICE.fetch(
			new Request(target, {
				method: "GET",
				headers: { cookie, accept: "application/json" },
			}),
		);
		if (response.status === 401) return { status: 401 as const };
		if (response.status === 403) return { status: 403 as const };
		if (!response.ok) return { status: 503 as const };
		const payload = githubIdentitySchema.safeParse(await response.json());
		if (!payload.success) return { status: 503 as const };
		return { status: 200 as const, identity: payload.data.data.githubIdentity };
	} catch {
		return { status: 503 as const };
	}
}

export async function githubParticipantLogin(
	request: Request,
	env: Env,
	now = Date.now(),
) {
	const db = env.ORG_DB;
	if (!db) return { status: 503 as const };
	const bucket = await digest(
		"github-login:" +
			(request.headers.get("cf-connecting-ip") ?? "local") +
			":" + Math.floor(now / 60_000),
	);
	await db
		.prepare("DELETE FROM participant_verification_limits WHERE expires_at<=?")
		.bind(now)
		.run();
	await db
		.prepare(
			"INSERT INTO participant_verification_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1,expires_at=excluded.expires_at",
		)
		.bind(bucket, now + 60_000)
		.run();
	const rate = await db
		.prepare("SELECT count FROM participant_verification_limits WHERE bucket=?")
		.bind(bucket)
		.first<{ count: number }>();
	if ((rate?.count ?? 0) > 10) return { status: 429 as const };
	const proof = await arenaGithubIdentity(request, env);
	if (proof.status !== 200) return proof;
	const candidates = await db
		.prepare(
			"SELECT i.id,i.name,i.team_id,i.role FROM console_identities i JOIN teams t ON t.id=i.team_id AND t.hackathon_id='initial' AND t.status='ACTIVE' JOIN team_members m ON m.id=COALESCE(i.team_member_id,(SELECT r.linked_team_member_id FROM team_roster_members r WHERE r.id=i.team_roster_member_id AND r.active=1)) AND m.team_id=i.team_id AND m.active=1 WHERE i.role='participant' AND i.revoked_at IS NULL AND m.github_id=?",
		)
		.bind(proof.identity.id)
		.all<{
			id: string;
			name: string;
			team_id: string;
			role: string;
		}>();
	if (candidates.results.length !== 1) {
		return { status: 404 as const };
	}
	const participant = candidates.results[0]!;
	const token = Array.from(
		crypto.getRandomValues(new Uint8Array(32)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
	await db
		.prepare(
			"INSERT INTO console_identity_sessions(hash,identity_id,expires_at) VALUES(?,?,?)",
		)
		.bind(await digest(token), participant.id, now + 8 * 60 * 60_000)
		.run();
	return {
		status: 200 as const,
		token,
		identity: {
			id: participant.id,
			name: participant.name,
			role: "participant" as const,
			teamId: participant.team_id,
		},
	};
}
