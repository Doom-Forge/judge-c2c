import { matrixBudget } from "./matrix-budget";
import { isMatrixOriginAllowed } from "./matrix-cors";
import { z } from "zod";
import { digest, sha } from "./domain";
import { boundedBody, equalSecret } from "./security";
import {
	matrixRepositoryStatus,
	githubEvidenceCategories,
	specificationRequiredRepositories,
} from "./matrix";
import { organizationEnv } from "./organization";
import { GitHub } from "./github";
import type { Contract } from "./domain";
import type { Env } from "./env";
import { ensureDefaultReviewer } from "./default-reviewer";

export type MatrixRun = {
	id: string;
	repository_id: number;
	full_name: string;
	pr_number: number;
	head_sha: string;
	baseline_sha: string;
	matrix_version: string;
	matrix_digest: string;
	image_uri: string;
	attempt: number;
	state: string;
	report: string | null;
	failure_code: string | null;
	check_run_id: number | null;
	publication_status: string;
	created_at: string;
};
const eventSchema = z.object({
	action: z.string(),
	installation: z.object({ id: z.number().int().positive() }),
	repository: z.object({
		id: z.number().int().positive(),
		full_name: z.string(),
	}),
	pull_request: z.object({
		number: z.number().int().positive(),
		user: z.object({
			id: z.number().int().positive(),
			login: z.string().min(1).max(100),
		}),
		head: z.object({ sha }),
		base: z.object({ repo: z.object({ id: z.number().int().positive() }) }),
		updated_at: z.string().datetime(),
		state: z.enum(["open", "closed"]),
	}),
});
const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: { "cache-control": "no-store" } });
const dbFor = (env: Env) => env.ORG_DB ?? env.DB;
type ReviewerRepository = {
	repository_id: number;
	full_name: string;
	installation_id: number;
};
type DefaultReviewerClientFactory = (
	repository: ReviewerRepository,
) => Promise<Pick<GitHub, "api">>;
type MatrixPRDependencies = {
	clientFactory?: DefaultReviewerClientFactory;
	deferReviewer?: (task: Promise<void>) => void;
	deferPublication?: (task: Promise<void>) => void;
	publishCheck?: (row: UnverifiedPR) => Promise<void>;
};
async function defaultReviewerClient(
	env: Env,
	repository: ReviewerRepository,
) {
	return GitHub.installation(
		await organizationEnv(env),
		{
			repository: {
				id: repository.repository_id,
				fullName: repository.full_name,
				installationId: repository.installation_id,
			},
		} as Contract,
		{ issuesWrite: false, pullRequestsWrite: true, checksWrite: false },
	);
}
async function requestDefaultReviewerForUnconfiguredPR(
	env: Env,
	db: D1Database,
	repository: ReviewerRepository,
	prNumber: number,
	clientFactory: DefaultReviewerClientFactory = (repo) =>
		defaultReviewerClient(env, repo),
) {
	if (!env.DEFAULT_PR_REVIEWER) return;
	try {
		const github = await clientFactory(repository);
		await ensureDefaultReviewer(
			db,
			github,
			{
				repository_id: repository.repository_id,
				full_name: repository.full_name,
				pr_number: prNumber,
			},
			env.DEFAULT_PR_REVIEWER,
		);
	} catch {
		// The specification-required response remains authoritative if review assignment is unavailable.
	}
}

type UnverifiedPR = {
	repository_id: number;
	full_name: string;
	pr_number: number;
	head_sha: string;
	check_run_id: number | null;
};

async function publishUnverifiedPRCheck(env: Env, db: D1Database, row: UnverifiedPR) {
	const lease = crypto.randomUUID();
	const claimed = await db.prepare("UPDATE unverified_pr_submissions SET check_status='PUBLISHING',check_lease_owner=?,check_lease_until=? WHERE repository_id=? AND pr_number=? AND head_sha=? AND check_status<>'PUBLISHED' AND check_lease_until<=?")
		.bind(lease, Date.now() + 60_000, row.repository_id, row.pr_number, row.head_sha, Date.now()).run();
	if (!claimed.meta.changes) return;
	try {
		const connection = await db.prepare("SELECT installation_id FROM github_connection WHERE id=1").first<number>("installation_id");
		if (!connection) throw new Error("APP_NOT_INSTALLED");
		const github = await GitHub.installation(await organizationEnv(env), {
			repository: { id: row.repository_id, fullName: row.full_name, installationId: connection },
		} as Contract, { issuesWrite: false, pullRequestsWrite: false, checksWrite: true });
		const externalId = `unverified:${row.repository_id}:${row.pr_number}:${row.head_sha}`;
		let checkId = row.check_run_id;
		if (!checkId) {
			const existing = await github.api<{ check_runs: { id: number; external_id?: string | null }[] }>(
				`/repos/${row.full_name}/commits/${row.head_sha}/check-runs?check_name=DoomBot&filter=all&per_page=100`,
			);
			checkId = existing.check_runs.find((check) => check.external_id === externalId)?.id ?? null;
		}
		const sections = githubEvidenceCategories.map((category) => `### ${category}\n\nUNVERIFIED — no approved evaluation profile is active.`).join("\n\n");
		const output = {
			title: "Evaluation pending approved profile",
			summary: "DoomBot received this pull request. No container execution or marks were produced; judges must enter a final score explicitly.\n\n" + sections,
		};
		const result = await github.api<{ id: number }>(
			`/repos/${row.full_name}/check-runs${checkId ? "/" + checkId : ""}`,
			{
				method: checkId ? "PATCH" : "POST",
				body: JSON.stringify({
					name: "DoomBot",
					head_sha: row.head_sha,
					external_id: externalId,
					status: "completed",
					conclusion: "neutral",
					output,
				}),
			},
		);
		await db.prepare("UPDATE unverified_pr_submissions SET check_run_id=?,check_status='PUBLISHED',check_lease_owner=NULL,check_lease_until=0,updated_at=CURRENT_TIMESTAMP WHERE repository_id=? AND pr_number=? AND head_sha=? AND check_lease_owner=?")
			.bind(result.id, row.repository_id, row.pr_number, row.head_sha, lease).run();
	} catch {
		await db.prepare("UPDATE unverified_pr_submissions SET check_status='FAILED',check_lease_owner=NULL,check_lease_until=0,updated_at=CURRENT_TIMESTAMP WHERE repository_id=? AND pr_number=? AND head_sha=? AND check_lease_owner=?")
			.bind(row.repository_id, row.pr_number, row.head_sha, lease).run();
	}
}
export async function dispatchMatrix(env: Env, id: string) {
	const db = dbFor(env);
	const row = await db.prepare("SELECT r.full_name,a.matrix_digest,a.image_uri,m.matrix_digest AS configured_digest,m.image_uri AS configured_image FROM matrix_runs r JOIN matrix_repositories m ON m.repository_id=r.repository_id AND m.full_name=r.full_name LEFT JOIN matrix_profile_approvals a ON a.repository_id=r.repository_id WHERE r.id=?")
		.bind(id).first<{ full_name: string; matrix_digest: string | null; image_uri: string | null; configured_digest: string; configured_image: string }>();
	if (!row || !specificationRequiredRepositories.includes(row.full_name as typeof specificationRequiredRepositories[number])) {
		throw new Error("MATRIX_REPOSITORY_NOT_AUTHORIZED");
	}
	if (!row.matrix_digest || !row.image_uri || row.matrix_digest !== row.configured_digest || row.image_uri !== row.configured_image) {
		throw new Error("MATRIX_PROFILE_NOT_APPROVED");
	}
	if (!env.MATRIX_EVALUATOR) throw new Error("MATRIX_WORKFLOW_NOT_CONFIGURED");
	try {
		await env.MATRIX_EVALUATOR.create({ id, params: { runId: id } });
	} catch (error) {
		try {
			const existing = await env.MATRIX_EVALUATOR.get(id);
			await existing.status();
		} catch {
			throw error;
		}
	}
}
export async function acceptMatrixPR(
	raw: unknown,
	env: Env,
	delivery: string,
	payloadHash: string,
	_resolvePR?: () => Promise<{
		head: { sha: string };
		state: "open" | "closed";
		updated_at: string;
		user: { id: number; login: string };
	}>,
	dependencies: MatrixPRDependencies = {},
) {
	const parsed = eventSchema.safeParse(raw);
	if (!parsed.success) return json({ error: "INVALID_PAYLOAD" }, 400);
	const p = parsed.data,
		pr = p.pull_request,
		db = dbFor(env);
	if (
		![
			"opened",
			"synchronize",
			"reopened",
			"closed",
			"ready_for_review",
		].includes(p.action)
	) {
		return json({ status: "ignored" }, 202);
	}
	if (
		specificationRequiredRepositories.includes(
			p.repository
				.full_name as (typeof specificationRequiredRepositories)[
					number
				],
		)
	) {
		const selected = await db
			.prepare(
				"SELECT g.id AS repository_id,g.full_name,c.installation_id FROM github_repositories g JOIN github_connection c ON c.id=1 WHERE g.id=? AND g.full_name=? AND g.accessible=1 AND c.installation_id=?",
			)
			.bind(p.repository.id, p.repository.full_name, p.installation.id)
			.first<ReviewerRepository>();
		if (!selected || pr.base.repo.id !== selected.repository_id) {
			return json({ error: "REPOSITORY_NOT_SELECTED" }, 403);
		}
		if (pr.state !== (p.action === "closed" ? "closed" : "open")) {
			return json({ error: "INCONSISTENT_EVENT" }, 400);
		}
		const priorDelivery = await db.prepare("SELECT payload_hash FROM matrix_deliveries WHERE id=?")
			.bind(delivery).first<{ payload_hash: string }>();
		if (priorDelivery) {
			if (priorDelivery.payload_hash !== payloadHash) return json({ error: "DELIVERY_CONFLICT" }, 409);
			return json({ status: "duplicate" }, 202);
		}
		const existing = await db.prepare("SELECT github_updated_at,head_sha,closed FROM unverified_pr_submissions WHERE repository_id=? AND pr_number=?")
			.bind(selected.repository_id, pr.number).first<{ github_updated_at: string; head_sha: string; closed: number }>();
		const mapping = await db.prepare(
			"SELECT COUNT(DISTINCT t.id) AS matching_teams,MIN(t.id) AS team_id,MAX(t.track_finalized) AS track_finalized,MAX((SELECT COUNT(*) FROM team_repositories tr WHERE tr.team_id=t.id AND tr.active=1)) AS repository_count,MAX(EXISTS(SELECT 1 FROM team_repositories tr WHERE tr.team_id=t.id AND tr.repository_id=? AND tr.active=1)) AS selected_repository FROM console_identities i JOIN teams t ON t.id=i.team_id AND t.hackathon_id='initial' AND t.status='ACTIVE' JOIN team_members m ON m.id=COALESCE(i.team_member_id,(SELECT r.linked_team_member_id FROM team_roster_members r WHERE r.id=i.team_roster_member_id AND r.active=1)) AND m.team_id=t.id AND m.active=1 AND m.github_id=? WHERE i.role='participant' AND i.github_verified_at IS NOT NULL AND i.revoked_at IS NULL",
		).bind(selected.repository_id, pr.user.id).first<{ matching_teams: number; team_id: string | null; track_finalized: number; repository_count: number; selected_repository: number }>();
		const mappingStatus = !mapping?.matching_teams
			? "MEMBER_NOT_REGISTERED"
			: mapping.matching_teams > 1
			? "TRACK_CONFLICT"
			: mapping.track_finalized !== 1 || mapping.repository_count === 0
			? "TRACK_NOT_SELECTED"
			: mapping.repository_count === 0
			? "TRACK_NOT_SELECTED"
			: mapping.repository_count !== 1
			? "TRACK_CONFLICT"
			: mapping.selected_repository
			? "MAPPED"
			: "TRACK_MISMATCH";
		const teamId = mappingStatus === "MAPPED" ? mapping?.team_id ?? null : null;
		const recordDelivery = db.prepare("INSERT INTO matrix_deliveries(id,payload_hash) VALUES(?,?)")
			.bind(delivery, payloadHash);
		if (existing && existing.github_updated_at > pr.updated_at) {
			await recordDelivery.run();
			return json({ status: "stale" }, 202);
		}
		const preservedCheck = existing?.head_sha === pr.head.sha
			? await db.prepare("SELECT check_run_id,check_status FROM unverified_pr_submissions WHERE repository_id=? AND pr_number=?")
				.bind(selected.repository_id, pr.number).first<{ check_run_id: number | null; check_status: "PENDING" | "PUBLISHING" | "PUBLISHED" | "FAILED" }>()
			: null;
		await db.batch([
			recordDelivery,
			db.prepare("INSERT INTO unverified_pr_submissions(repository_id,pr_number,action,head_sha,github_updated_at,closed,delivery_id,payload_hash,author_id,author_login,team_id,mapping_status,check_run_id,check_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,pr_number) DO UPDATE SET action=excluded.action,head_sha=excluded.head_sha,github_updated_at=excluded.github_updated_at,closed=excluded.closed,delivery_id=excluded.delivery_id,payload_hash=excluded.payload_hash,author_id=excluded.author_id,author_login=excluded.author_login,team_id=excluded.team_id,mapping_status=excluded.mapping_status,check_run_id=CASE WHEN unverified_pr_submissions.head_sha=excluded.head_sha THEN unverified_pr_submissions.check_run_id ELSE NULL END,check_status=CASE WHEN unverified_pr_submissions.head_sha=excluded.head_sha THEN unverified_pr_submissions.check_status ELSE 'PENDING' END,updated_at=CURRENT_TIMESTAMP WHERE unverified_pr_submissions.github_updated_at<=excluded.github_updated_at")
				.bind(selected.repository_id, pr.number, p.action, pr.head.sha, pr.updated_at, pr.state === "closed" ? 1 : 0, delivery, payloadHash, pr.user.id, pr.user.login, teamId, mappingStatus, preservedCheck?.check_run_id ?? null, preservedCheck?.check_status ?? "PENDING"),
		]);
		const publishedRow = { repository_id: selected.repository_id, full_name: selected.full_name, pr_number: pr.number, head_sha: pr.head.sha, check_run_id: preservedCheck?.check_run_id ?? null };
		if (pr.state === "open") {
			if (env.DEFAULT_PR_REVIEWER === "Kevin272-dot") {
				const reviewerTask = requestDefaultReviewerForUnconfiguredPR(env, db, selected, pr.number, dependencies.clientFactory);
				if (dependencies.deferReviewer) dependencies.deferReviewer(reviewerTask);
				else await reviewerTask;
			}
			const checkTask = dependencies.publishCheck
				? dependencies.publishCheck(publishedRow)
				: publishUnverifiedPRCheck(env, db, publishedRow);
			if (dependencies.deferPublication) dependencies.deferPublication(checkTask);
			else await checkTask;
		}
		return json({ status: existing?.head_sha === pr.head.sha ? "updated" : "accepted", verification: "UNVERIFIED", marks: null }, 202);
	}
	// The two historical pilots are kept for read-only history. They are not
	// eligible for new PR intake or dispatch in the production competition.
	return json({ error: "MATRIX_REPOSITORY_NOT_AUTHORIZED" }, 403);
}
function decode(run: MatrixRun) {
	return { ...run, report: run.report ? JSON.parse(run.report) : null };
}
export async function matrixApi(request: Request, env: Env) {
	if (
		!(await equalSecret(
			request.headers.get("authorization")?.replace(/^Bearer /, "") ??
				null,
			env.ADMIN_TOKEN,
		))
	) {
		return json({ error: "UNAUTHORIZED" }, 401);
	}
	const path = new URL(request.url).pathname,
		db = dbFor(env);
	if (request.method === "GET" && path === "/api/matrix/budget") {
		return json(await matrixBudget(db, env));
	}
	if (request.method === "POST" && path === "/api/matrix/diagnostic") {
		return json({ error: "MATRIX_REPOSITORY_NOT_AUTHORIZED" }, 403);
	}
	if (request.method === "GET" && path === "/api/matrix/overview") {
		const [repositories, runs] = await Promise.all([
			db
				.prepare(
				"SELECT g.id,g.full_name,m.baseline_sha,m.matrix_version,m.matrix_digest,m.image_uri FROM github_repositories g LEFT JOIN matrix_repositories m ON m.repository_id=g.id WHERE g.accessible=1 AND g.full_name IN ('180DC-VIT-CHENNAI/mazhai-cover','180DC-VIT-CHENNAI/pricingpulse','180DC-VIT-CHENNAI/veera-footwear','180DC-VIT-CHENNAI/janus')",
				)
				.all<{
					id: number;
					full_name: string;
					baseline_sha: string | null;
					matrix_version: string | null;
					matrix_digest: string | null;
					image_uri: string | null;
				}>(),
			db
				.prepare(
					"SELECT * FROM matrix_runs ORDER BY created_at DESC,rowid DESC LIMIT 100",
				)
				.all<MatrixRun>(),
		]);
		return json({
			mode: "cloudflare-containers",
			repositories: repositories.results.map((repository) => ({
				...repository,
				evaluation_status: matrixRepositoryStatus(
					repository.full_name,
					!!repository.matrix_version,
				),
			})),
			runs: runs.results.map(decode),
		});
	}
	const match = path.match(/^\/api\/matrix\/runs\/([a-f0-9]{64})(\/retry)?$/);
	if (!match) return json({ error: "NOT_FOUND" }, 404);
	const run = await db
		.prepare("SELECT * FROM matrix_runs WHERE id=?")
		.bind(match[1])
		.first<MatrixRun>();
	if (!run) return json({ error: "NOT_FOUND" }, 404);
	if (request.method === "GET" && !match[2]) return json(decode(run));
	if (request.method === "POST" && match[2]) {
		if (!isMatrixOriginAllowed(request, env)) {
			return json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
		}
		if (!specificationRequiredRepositories.includes(run.full_name as typeof specificationRequiredRepositories[number])) {
			return json({ error: "MATRIX_REPOSITORY_NOT_AUTHORIZED" }, 403);
		}
		const approved = await db.prepare("SELECT 1 FROM matrix_profile_approvals a JOIN matrix_repositories m ON m.repository_id=a.repository_id AND m.matrix_digest=a.matrix_digest AND m.image_uri=a.image_uri WHERE a.repository_id=? AND a.matrix_digest=? AND a.image_uri=?")
			.bind(run.repository_id, run.matrix_digest, run.image_uri).first();
		if (!approved) return json({ error: "MATRIX_PROFILE_NOT_APPROVED" }, 409);
		if (!["FAILED", "COMPLETED"].includes(run.state)) return json({ error: "RETRY_NOT_AVAILABLE" }, 409);
		const id = await digest(crypto.randomUUID());
		await db.batch([
			db.prepare("UPDATE matrix_submissions SET latest_run_id=? WHERE repository_id=? AND pr_number=? AND latest_run_id=? AND closed=0")
				.bind(id, run.repository_id, run.pr_number, run.id),
			db.prepare("INSERT INTO matrix_runs(id,repository_id,full_name,pr_number,head_sha,baseline_sha,matrix_version,matrix_digest,image_uri,attempt,publication_status) SELECT ?,repository_id,full_name,pr_number,head_sha,baseline_sha,matrix_version,matrix_digest,image_uri,attempt+1,'NOTICE_ONLY' FROM matrix_runs WHERE id=? AND EXISTS(SELECT 1 FROM matrix_submissions WHERE repository_id=? AND pr_number=? AND latest_run_id=?)")
				.bind(id, run.id, run.repository_id, run.pr_number, id),
		]);
		if (!(await db.prepare("SELECT id FROM matrix_runs WHERE id=?").bind(id).first())) return json({ error: "SUBMISSION_SUPERSEDED" }, 409);
		await dispatchMatrix(env, id);
		return json({ id }, 202);
	}
	return json({ error: "METHOD_NOT_ALLOWED" }, 405);
}
