import type { ConsoleSession } from "./console-identities";
import { installedClient } from "./organization";
import type { Env } from "./env";

const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: { "cache-control": "no-store" } });
const SHA = /^[a-f0-9]{40}$/i;
const REPOSITORY = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const FILE_PAGE_SIZE = 16;
const COMMIT_PAGE_SIZE = 20;
const REVIEW_PAGE_SIZE = 20;
const CHECK_PAGE_SIZE = 20;
const SECURITY_PAGE_SIZE = 20;
const PATCH_LIMIT = 3_000;
const PATCH_BUDGET = 48_000;
const REVIEW_BODY_LIMIT = 2_000;
const COMMIT_MESSAGE_LIMIT = 1_000;

export type EvidenceClientFactory = typeof installedClient;

interface SubmissionEvidence {
	repository_id: number;
	pr_number: number;
	head_sha: string;
	mapping_status: string;
	full_name: string;
	run_id: string | null;
	run_baseline_sha: string | null;
	run_state: string | null;
	run_failure_code: string | null;
	run_report: string | null;
}

interface PageInfo {
	status: "available" | "unavailable";
	page: number;
	hasMore: boolean;
	reason?: "permission_required" | "not_available" | "rate_limited" | "upstream_error";
}

function pageNumber(url: URL, key: string) {
	const raw = url.searchParams.get(key);
	if (raw === null) return 1;
	if (!/^[1-9]\d{0,2}$/.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value <= 100 ? value : null;
}

function unavailableReason(error: unknown): PageInfo["reason"] {
	const message = error instanceof Error ? error.message : "";
	if (/GITHUB_HTTP_403/.test(message)) return "permission_required";
	if (/GITHUB_HTTP_404/.test(message)) return "not_available";
	if (/GITHUB_RATE_LIMITED/.test(message)) return "rate_limited";
	return "upstream_error";
}

function pageQuery(path: string, page: number, size: number) {
	return `${path}?per_page=${size + 1}&page=${page}`;
}

async function readPage<T>(
	client: Awaited<ReturnType<EvidenceClientFactory>>,
	path: string,
	page: number,
	size: number,
): Promise<{ items: T[]; pageInfo: PageInfo }> {
	try {
		const result = await client.api<T[]>(pageQuery(path, page, size));
		const items = Array.isArray(result) ? result : [];
		return {
			items: items.slice(0, size),
			pageInfo: {
				status: "available",
				page,
				hasMore: items.length > size,
			},
		};
	} catch (error) {
		return {
			items: [],
			pageInfo: {
				status: "unavailable",
				page,
				hasMore: false,
				reason: unavailableReason(error),
			},
		};
	}
}

function evaluation(row: SubmissionEvidence) {
	if (!row.run_id || !row.run_state) {
		return {
			status: "unavailable" as const,
			state: null,
			failureCode: null,
			checks: [],
			categories: null,
			overallScore: null,
		};
	}
	let report: Record<string, unknown> | null = null;
	try {
		const parsed: unknown = JSON.parse(row.run_report ?? "null");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			report = parsed as Record<string, unknown>;
		}
	} catch {
		// A malformed historical report is unavailable; never infer a result.
	}
	const rawChecks = Array.isArray(report?.checks) ? report.checks : [];
	const checks = rawChecks.slice(0, 100).flatMap((check) => {
		if (!check || typeof check !== "object") return [];
		const item = check as Record<string, unknown>;
		if (
			typeof item.id !== "string" ||
			typeof item.status !== "string" ||
			!("category" in item)
		) return [];
		return [{
			id: item.id.slice(0, 100),
			category: typeof item.category === "string" ? item.category.slice(0, 40) : "unknown",
			status: item.status.slice(0, 32),
			detail: typeof item.detail === "string" ? item.detail.slice(0, 1_000) : "",
		}];
	});
	const categoryValues = report?.categories;
	const categories = categoryValues && typeof categoryValues === "object" && !Array.isArray(categoryValues)
		? Object.fromEntries(Object.entries(categoryValues as Record<string, unknown>).slice(0, 3).flatMap(([name, value]) => {
			if (!value || typeof value !== "object") return [];
			const item = value as Record<string, unknown>;
			return [[name, {
				status: typeof item.status === "string" ? item.status.slice(0, 32) : "UNVERIFIED",
				score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null,
			}]];
		}))
		: null;
	const failureCode = row.run_failure_code && /^[A-Z0-9_]{1,80}$/.test(row.run_failure_code)
		? row.run_failure_code
		: null;
	return {
		status: row.run_state === "COMPLETED" && report ? "available" as const : "incomplete" as const,
		state: row.run_state,
		failureCode,
		checks,
		categories,
		overallScore: typeof report?.overallScore === "number" && Number.isFinite(report.overallScore)
			? report.overallScore
			: null,
	};
}

export async function roundTwoGitHubEvidence(
	request: Request,
	env: Env,
	session: ConsoleSession,
	clientFactory: EvidenceClientFactory = installedClient,
) {
	const url = new URL(request.url);
	const match = url.pathname.match(
		/^\/api\/organization\/round-two\/teams\/([\w.-]{1,80})\/pull-requests\/(\d{1,12})\/(\d{1,12})$/,
	);
	if (request.method !== "GET" || !match) return json({ error: "NOT_FOUND" }, 404);
	if (session.role !== "judge" && session.role !== "organizer") {
		return json({ error: "REVIEW_ACCESS_REQUIRED" }, 403);
	}
	const [, teamId, repositoryText, prText] = match;
	const repositoryId = Number(repositoryText);
	const prNumber = Number(prText);
	if (
		!Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
		!Number.isSafeInteger(prNumber) || prNumber < 1
	) return json({ error: "INVALID_PULL_REQUEST" }, 400);
	const pages = {
		files: pageNumber(url, "filesPage"),
		commits: pageNumber(url, "commitsPage"),
		reviews: pageNumber(url, "reviewsPage"),
		checks: pageNumber(url, "checksPage"),
		security: pageNumber(url, "securityPage"),
	};
	if (Object.values(pages).some((page) => page === null)) {
		return json({ error: "INVALID_PAGE" }, 400);
	}
	const db = env.ORG_DB;
	if (!db) return json({ error: "ORGANIZATION_NOT_CONFIGURED" }, 503);
	if (session.role === "judge") {
		if (!session.identity_id) return json({ error: "JUDGE_IDENTITY_REQUIRED" }, 403);
		const assignment = await db.prepare(
			"SELECT 1 FROM round_two_judge_assignments a JOIN teams t ON t.id=a.team_id WHERE a.judge_identity_id=? AND a.team_id=? AND a.revoked_at IS NULL AND t.hackathon_id='initial' AND t.status='ACTIVE'",
		).bind(session.identity_id, teamId).first();
		if (!assignment) return json({ error: "NOT_FOUND" }, 404);
	}
	const row = await db.prepare(
		"SELECT ms.repository_id,ms.pr_number,ms.head_sha,ms.mapping_status,g.full_name,m.id AS run_id,m.baseline_sha AS run_baseline_sha,m.state AS run_state,m.failure_code AS run_failure_code,m.report AS run_report FROM matrix_submissions ms JOIN teams t ON t.id=ms.team_id AND t.hackathon_id='initial' AND t.status='ACTIVE' JOIN github_repositories g ON g.id=ms.repository_id AND g.accessible=1 JOIN team_repositories tr ON tr.team_id=ms.team_id AND tr.repository_id=ms.repository_id AND tr.active=1 LEFT JOIN matrix_runs m ON m.id=ms.latest_run_id AND m.repository_id=ms.repository_id AND m.pr_number=ms.pr_number AND m.head_sha=ms.head_sha WHERE ms.team_id=? AND ms.repository_id=? AND ms.pr_number=?",
	).bind(teamId, repositoryId, prNumber).first<SubmissionEvidence>();
	if (!row || row.mapping_status !== "MAPPED") return json({ error: "NOT_FOUND" }, 404);
	if (!REPOSITORY.test(row.full_name) || !SHA.test(row.head_sha)) {
		return json({ error: "PR_EVIDENCE_UNAVAILABLE" }, 503);
	}
	const baselineSha = row.run_baseline_sha;
	if (!baselineSha || !SHA.test(baselineSha)) {
		return json({ error: "PR_BASELINE_UNAVAILABLE" }, 503);
	}
	const pageValues = pages as Record<keyof typeof pages, number>;
	let client: Awaited<ReturnType<EvidenceClientFactory>>;
	let pull: {
		number: number;
		title: string;
		html_url: string;
		user?: { login?: string } | null;
		created_at: string;
		updated_at: string;
		state: string;
		merged_at?: string | null;
		additions: number;
		deletions: number;
		head: { sha: string };
		base: { repo: { id: number } };
	};
	try {
		client = await clientFactory(env, repositoryId, false);
		pull = await client.api<typeof pull>(`/repos/${row.full_name}/pulls/${prNumber}`);
	} catch (error) {
		const reason = unavailableReason(error);
		const status = reason === "not_available" ? 404 : 503;
		return json({ error: reason === "not_available" ? "PULL_REQUEST_NOT_FOUND" : "GITHUB_EVIDENCE_UNAVAILABLE", reason }, status);
	}
	if (
		pull.number !== prNumber ||
		pull.base?.repo?.id !== repositoryId ||
		!SHA.test(pull.head?.sha ?? "")
	) return json({ error: "PULL_REQUEST_REPOSITORY_MISMATCH" }, 404);

	const repoPath = `/repos/${row.full_name}`;
	const [files, commits, reviews, checks, security] = await Promise.all([
		readPage<{
			filename: string;
			status: string;
			additions: number;
			deletions: number;
			patch?: string;
			previous_filename?: string;
		}>(client, `${repoPath}/pulls/${prNumber}/files`, pageValues.files, FILE_PAGE_SIZE),
		readPage<{
			sha: string;
			author?: { login?: string } | null;
			commit: { message: string; author?: { name?: string; date?: string } | null };
		}>(client, `${repoPath}/pulls/${prNumber}/commits`, pageValues.commits, COMMIT_PAGE_SIZE),
		readPage<{
			user?: { login?: string } | null;
			state: string;
			submitted_at: string | null;
			body?: string | null;
		}>(client, `${repoPath}/pulls/${prNumber}/reviews`, pageValues.reviews, REVIEW_PAGE_SIZE),
		readChecks(client, repoPath, pull.head.sha, pageValues.checks),
		readSecurity(client, repoPath, prNumber, pageValues.security),
	]);
	let patchBytes = 0;
	const changedFiles = files.items.map((file) => {
		const rawPatch = typeof file.patch === "string" ? file.patch : null;
		const remaining = Math.max(0, PATCH_BUDGET - patchBytes);
		const allowed = Math.min(PATCH_LIMIT, remaining);
		const patch = rawPatch === null || allowed === 0 ? undefined : rawPatch.slice(0, allowed);
		patchBytes += patch?.length ?? 0;
		return {
			filename: typeof file.filename === "string" ? file.filename.slice(0, 500) : "unknown",
			status: typeof file.status === "string" ? file.status.slice(0, 40) : "unknown",
			additions: Number.isSafeInteger(file.additions) ? file.additions : 0,
			deletions: Number.isSafeInteger(file.deletions) ? file.deletions : 0,
			...(typeof file.previous_filename === "string" ? { previousFilename: file.previous_filename.slice(0, 500) } : {}),
			...(patch === undefined ? {} : { patch }),
			patchTruncated: rawPatch !== null && patch !== rawPatch,
			patchUnavailable: rawPatch === null,
		};
	});
	const mappedCommits = commits.items.map((commit) => {
		const message = typeof commit.commit?.message === "string" ? commit.commit.message : "";
		return {
			sha: SHA.test(commit.sha) ? commit.sha : "",
			message: message.slice(0, COMMIT_MESSAGE_LIMIT),
			messageTruncated: message.length > COMMIT_MESSAGE_LIMIT,
			author: commit.author?.login ?? commit.commit?.author?.name ?? "Unknown",
			date: commit.commit?.author?.date ?? null,
		};
	});
	const mappedReviews = reviews.items.map((review) => ({
		author: review.user?.login ?? "Unknown",
		state: typeof review.state === "string" ? review.state.slice(0, 40) : "unknown",
		submittedAt: review.submitted_at,
		body: typeof review.body === "string" ? review.body.slice(0, REVIEW_BODY_LIMIT) : "",
		bodyTruncated: typeof review.body === "string" && review.body.length > REVIEW_BODY_LIMIT,
	}));
	return json({
		pullRequest: {
			number: pull.number,
			title: typeof pull.title === "string" ? pull.title.slice(0, 500) : "Untitled pull request",
			htmlUrl: safeHttpsUrl(pull.html_url),
			author: pull.user?.login ?? "Unknown",
			openedAt: pull.created_at,
			updatedAt: pull.updated_at,
			state: pull.merged_at ? "merged" : pull.state,
			additions: Number.isSafeInteger(pull.additions) ? pull.additions : 0,
			deletions: Number.isSafeInteger(pull.deletions) ? pull.deletions : 0,
		},
		captured: { headSha: row.head_sha, baselineSha },
		currentHeadSha: pull.head.sha,
		stale: pull.head.sha.toLowerCase() !== row.head_sha.toLowerCase(),
		changedFiles,
		changedFilesPage: files.pageInfo,
		commits: mappedCommits,
		commitsPage: commits.pageInfo,
		reviews: mappedReviews,
		reviewsPage: reviews.pageInfo,
		checks: checks.items,
		checksPage: checks.pageInfo,
		checksHeadSha: pull.head.sha,
		securityFindings: security.items,
		securityFindingsPage: security.pageInfo,
		automatedEvaluation: evaluation(row),
	});
}

async function readChecks(
	client: Awaited<ReturnType<EvidenceClientFactory>>,
	repoPath: string,
	headSha: string,
	page: number,
): Promise<{ items: Record<string, unknown>[]; pageInfo: PageInfo }> {
	try {
		const response = await client.api<{
			total_count?: number;
			check_runs?: {
				name?: string;
				status?: string;
				conclusion?: string | null;
				details_url?: string | null;
			}[];
		}>(`${repoPath}/commits/${headSha}/check-runs?per_page=${CHECK_PAGE_SIZE + 1}&page=${page}`);
		const items = Array.isArray(response.check_runs) ? response.check_runs : [];
		return {
			items: items.slice(0, CHECK_PAGE_SIZE).map((check) => ({
				name: typeof check.name === "string" ? check.name.slice(0, 200) : "Unnamed check",
				status: typeof check.status === "string" ? check.status.slice(0, 40) : "unknown",
				conclusion: typeof check.conclusion === "string" ? check.conclusion.slice(0, 40) : null,
				detailsUrl: safeHttpsUrl(check.details_url ?? ""),
			})),
			pageInfo: {
				status: "available",
				page,
				hasMore: typeof response.total_count === "number"
					? response.total_count > page * CHECK_PAGE_SIZE
					: items.length > CHECK_PAGE_SIZE,
			},
		};
	} catch (error) {
		return {
			items: [],
			pageInfo: { status: "unavailable", page, hasMore: false, reason: unavailableReason(error) },
		};
	}
}

async function readSecurity(
	client: Awaited<ReturnType<EvidenceClientFactory>>,
	repoPath: string,
	prNumber: number,
	page: number,
): Promise<{ items: Record<string, unknown>[]; pageInfo: PageInfo }> {
	try {
		const ref = encodeURIComponent(`refs/pull/${prNumber}/head`);
		const response = await client.api<{
			rule?: { name?: string; description?: string; security_severity_level?: string };
			state?: string;
			html_url?: string;
			created_at?: string;
			fixed_at?: string | null;
			most_recent_instance?: { location?: { path?: string; start_line?: number } };
		}[]>(`${repoPath}/code-scanning/alerts?ref=${ref}&state=open&per_page=${SECURITY_PAGE_SIZE + 1}&page=${page}`);
		const items = Array.isArray(response) ? response : [];
		return {
			items: items.slice(0, SECURITY_PAGE_SIZE).map((alert) => ({
				rule: alert.rule?.name?.slice(0, 200) ?? "Unknown rule",
				description: alert.rule?.description?.slice(0, 1_000) ?? "",
				severity: alert.rule?.security_severity_level?.slice(0, 32) ?? null,
				state: alert.state?.slice(0, 40) ?? "unknown",
				url: safeHttpsUrl(alert.html_url ?? ""),
				createdAt: alert.created_at ?? null,
				fixedAt: alert.fixed_at ?? null,
				path: alert.most_recent_instance?.location?.path?.slice(0, 500) ?? null,
				line: Number.isSafeInteger(alert.most_recent_instance?.location?.start_line)
					? alert.most_recent_instance?.location?.start_line
					: null,
			})),
			pageInfo: { status: "available", page, hasMore: items.length > SECURITY_PAGE_SIZE },
		};
	} catch (error) {
		return {
			items: [],
			pageInfo: { status: "unavailable", page, hasMore: false, reason: unavailableReason(error) },
		};
	}
}

function safeHttpsUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
}
