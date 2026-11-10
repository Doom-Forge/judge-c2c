import { expect, test } from "@playwright/test";

function judgeStatus() {
	return {
		organization: "Fixture",
		authenticated: true,
		role: "judge",
		identity: { id: "judge-a", name: "Judge A", role: "judge" },
	};
}

function teamDetail() {
	return {
		team: { id: "team-alpha", name: "Alpha", status: "ACTIVE" },
		members: [],
		repositories: [{ id: 17, full_name: "fixture/alpha", default_branch: "main" }],
		submissions: [],
		matrixSubmissions: [{
			repository_id: 17,
			full_name: "fixture/alpha",
			pr_number: 7,
			head_sha: "abc123def456",
			author_login: "team-alpha",
			mapping_status: "MAPPED",
			updated_at: "2026-11-08T10:00:00Z",
			closed: 0,
			evaluation_status: "COMPLETED",
			failure_code: null,
			report: { summary: "Build and test checks passed." },
		}],
		documents: [{
			id: "doc-alpha",
			version: 1,
			filename: "analysis.pdf",
			content_type: "application/pdf",
			bytes: 1024,
			sha256: "0123456789abcdef",
			status: "STORED",
			created_at: "2026-11-08T09:00:00Z",
		}],
		deadlines: null,
	};
}

test("authenticated judge opens assigned team evidence, saves, submits, and revises a review", async ({
	page,
}) => {
	const actions: string[] = [];
	const sharingActions: boolean[] = [];
	const sharedReviewIds = new Set<string>();
	let draft: Record<string, unknown> | null = null;
	let submissions: Record<string, unknown>[] = [];
	await page.route("**/api/organization/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/api/organization/status") {
			return route.fulfill({ json: judgeStatus() });
		}
		if (url.pathname === "/api/organization/round-two/teams") {
			return route.fulfill({
				json: {
					teams: [{
						id: "team-alpha",
						name: "Alpha",
						status: "ACTIVE",
						submission_count: 1,
						document_count: 1,
					}],
					deadlines: null,
				},
			});
		}
		if (url.pathname === "/api/organization/round-two/teams/team-alpha") {
			return route.fulfill({ json: teamDetail() });
		}
		if (url.pathname === "/api/organization/round-two/teams/team-alpha/pull-requests/17/7") {
			return route.fulfill({ json: {
				pullRequest: { number: 7, title: "Fix parsing edge case", htmlUrl: "https://github.com/fixture/alpha/pull/7", author: "team-alpha", openedAt: "2026-11-07T10:00:00Z", updatedAt: "2026-11-08T10:00:00Z", state: "open", additions: 4, deletions: 1 },
				captured: { headSha: "abc123def456", baselineSha: "111222333444" }, currentHeadSha: "fedcba987654", stale: true,
				changedFiles: [{ filename: "src/parser.ts", status: "modified", additions: 4, deletions: 1, patch: "@@ -1 +1 @@", patchTruncated: false, patchUnavailable: false }],
				commits: [{ sha: "abc123def456", message: "Fix parser", messageTruncated: false, author: "team-alpha", date: "2026-11-08T10:00:00Z" }],
				reviews: [{ author: "reviewer", state: "APPROVED", submittedAt: "2026-11-08T10:30:00Z", body: "Looks good", bodyTruncated: false }],
				checks: [{ name: "unit-tests", status: "completed", conclusion: "success", detailsUrl: null }],
				securityFindings: [],
				changedFilesPage: { status: "available", page: 1, hasMore: false }, commitsPage: { status: "available", page: 1, hasMore: false }, reviewsPage: { status: "available", page: 1, hasMore: false }, checksPage: { status: "available", page: 1, hasMore: false }, securityFindingsPage: { status: "available", page: 1, hasMore: false },
				automatedEvaluation: { status: "available", state: "completed", failureCode: null, checks: [{ id: "check-1", category: "test", status: "passed", detail: "Tests passed" }], categories: {}, overallScore: null },
			} });
		}
		if (url.pathname === "/api/organization/round-two/reviews/share" && request.method() === "POST") {
			const body = request.postDataJSON() as { reviewId: string; shared: boolean };
			sharingActions.push(body.shared);
			if (body.shared) sharedReviewIds.add(body.reviewId);
			else sharedReviewIds.delete(body.reviewId);
			return route.fulfill({ json: { reviewId: body.reviewId, shared: body.shared } });
		}
		if (url.pathname === "/api/organization/round-two/reviews" && request.method() === "GET") {
			const stage = url.searchParams.get("stage");
			return route.fulfill({
				json: {
					currentDocument: stage === "ANALYSIS"
						? { id: "doc-alpha", version: 1, filename: "analysis.pdf", created_at: "2026-11-08T09:00:00Z" }
						: null,
					rubric: stage === "ENGINEERING"
						? { id: "rubric-1", repositoryId: 17, version: 1, criteria: [{ id: "tests", label: "Tests", weight: 100 }] }
						: null,
					rubricError: null,
					documentStale: false,
					draft,
					drafts: draft ? [draft] : [],
					submissions: submissions.map((item) => ({ ...item, scoreShared: sharedReviewIds.has(String(item.id)) })),
				},
			});
		}
		if (url.pathname === "/api/organization/round-two/reviews" && request.method() === "POST") {
			const body = request.postDataJSON() as Record<string, unknown>;
			const action = String(body.action);
			actions.push(action);
			if (action === "SAVE_DRAFT") draft = { score: 88, payload: body.feedback, document_id: "doc-alpha" };
			if (action === "SUBMIT") {
				submissions = [{ id: "review-1", score: 88, payload: draft?.payload, document_id: "doc-alpha", revision: 1, reason: "Initial submission", submitted_at: "2026-11-08T11:00:00Z" }];
				draft = null;
			}
			if (action === "REVISE") {
				submissions = [{ id: "review-2", score: 90, payload: body.feedback, document_id: "doc-alpha", revision: 2, reason: body.reason, submitted_at: "2026-11-08T12:00:00Z" }, ...submissions];
			}
			return route.fulfill({ json: { ok: true } });
		}
		return route.fulfill({ status: 404, json: { error: "UNEXPECTED_ROUTE" } });
	});

	await page.goto("/queue");
	await expect(page.getByRole("heading", { name: "Your review queue" })).toBeVisible();
	await expect(page.getByText("1 shown")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
	await page.getByRole("button", { name: "Open review workspace for Alpha" }).click();
	await expect(page).toHaveURL(/\/workspace\?teamId=team-alpha$/);
	await expect(page.getByRole("heading", { name: "Judge workspace" })).toBeVisible();
	await expect(page.getByText("analysis.pdf", { exact: true })).toBeVisible();
	await expect(page.getByText("fixture/alpha", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Load GitHub evidence" }).click();
	await expect(page.getByText(/GitHub head changed since this submission/)).toBeVisible();
	await expect(page.getByText("src/parser.ts", { exact: false })).toBeVisible();
	await expect(page.getByText("Tests passed")).toBeVisible();

	await page.getByLabel("Analysis score").fill("88");
	await page.getByLabel("Problem understanding").fill("The problem is clearly defined.");
	await page.getByLabel("Remediation").fill("The change addresses the issue.");
	await page.getByLabel("Innovation impact").fill("The approach improves the workflow.");
	await page.getByLabel("Overall feedback").fill("Good evidence and implementation.");
	await page.getByRole("button", { name: "Save draft" }).click();
	await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
	await page.getByRole("button", { name: "Submit review" }).click();
	await expect(page.getByRole("button", { name: "Submit revision" })).toBeVisible();
	await expect(page.getByText(/revision 1/)).toBeVisible();
	await page.getByLabel("Reason for revision").fill("Clarified evidence after a second pass.");
	await page.getByRole("button", { name: "Submit revision" }).click();
	await expect(page.getByText(/revision 2/)).toBeVisible();
	await page.getByRole("button", { name: "Share stage score" }).click();
	await expect(page.getByText(/Your stage score is selected to share/)).toBeVisible();
	await page.getByRole("button", { name: "Stop sharing score" }).click();
	await expect(page.getByText(/Your stage score is no longer selected/)).toBeVisible();
	await expect(actions).toEqual(["SAVE_DRAFT", "SUBMIT", "REVISE"]);
	await expect(sharingActions).toEqual([true, false]);
});

test("assigned judge explicitly finalizes one immutable team score after Engineering review", async ({ page }) => {
	let official: { score: number; judgeIdentityId: string; reason: string; createdAt: string } | null = null;
	let posted: Record<string, unknown> | null = null;
	await page.route("**/api/organization/**", async route => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/api/organization/status") return route.fulfill({ json: judgeStatus() });
		if (url.pathname === "/api/organization/round-two/teams") return route.fulfill({ json: { teams: [{ id: "team-alpha", name: "Alpha", submission_count: 1, document_count: 0 }], deadlines: null } });
		if (url.pathname === "/api/organization/round-two/teams/team-alpha") return route.fulfill({ json: teamDetail() });
		if (url.pathname === "/api/organization/round-two/reviews") return route.fulfill({ json: { currentDocument: null, rubric: null, rubricError: null, documentStale: false, draft: null, drafts: [], submissions: [] } });
		if (url.pathname === "/api/organization/round-two/results/final-score" && request.method() === "GET") return route.fulfill({ json: {
			team: { id: "team-alpha", name: "Alpha" },
			manualReviews: { analysis: { reviewCount: 0, average: null }, engineering: { reviewCount: 1, average: 78 } },
			machineEvidence: { status: "UNVERIFIED", marks: null, pullRequests: [{ repositoryId: 17, repository: "fixture/alpha", prNumber: 7, headSha: "abc123def456", authorLogin: "team-alpha", updatedAt: "2026-11-08T10:00:00Z", closed: false, evaluationStatus: "UNVERIFIED", marks: null, categories: [] }] },
			finalScore: official, canFinalize: official === null,
		} });
		if (url.pathname === "/api/organization/round-two/results/final-score" && request.method() === "POST") {
			posted = request.postDataJSON() as Record<string, unknown>;
			const body = posted as { score: number; reason: string };
			official = { score: body.score, reason: body.reason, judgeIdentityId: "judge-a", createdAt: "2026-11-08T12:00:00Z" };
			return route.fulfill({ status: 201, json: { teamId: "team-alpha", finalScore: official } });
		}
		return route.fulfill({ status: 404, json: { error: "UNEXPECTED_ROUTE" } });
	});
	await page.goto("/workspace?teamId=team-alpha");
	await expect(page.getByRole("heading", { name: "Official team score" })).toBeVisible();
	await expect(page.getByText("UNVERIFIED", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("Manual Engineering", { exact: true })).toBeVisible();
	const finalize = page.getByRole("button", { name: "Finalize official team score" });
	await expect(finalize).toBeDisabled();
	await page.getByRole("spinbutton", { name: "Official final score" }).fill("91.5");
	await page.getByRole("textbox", { name: "Reason for official final" }).fill("After checking review and automated evidence.");
	await page.getByLabel(/I confirm this is the team's official final mark/).check();
	await expect(finalize).toBeEnabled();
	await finalize.click();
	await expect.poll(() => posted).toEqual({ teamId: "team-alpha", score: 91.5, reason: "After checking review and automated evidence." });
	await expect(page.getByText("91.5 / 100", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Finalize official team score" })).toHaveCount(0);
});

test("signed-out users can sign in and empty judges do not see sample submissions", async ({
	page,
}) => {
	let authenticated = false;
	await page.route("**/api/organization/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/api/organization/status") {
			return route.fulfill({
				json: authenticated ? judgeStatus() : { organization: "Fixture", authenticated: false },
			});
		}
		if (url.pathname === "/api/organization/login") {
			expect(request.method()).toBe("POST");
			expect(request.postDataJSON()).toEqual({ token: "judge-token" });
			authenticated = true;
			return route.fulfill({ json: { authenticated: true } });
		}
		if (url.pathname === "/api/organization/round-two/teams") {
			return route.fulfill({ json: { teams: [], deadlines: null } });
		}
		return route.fulfill({ status: 404, json: { error: "UNEXPECTED_ROUTE" } });
	});

	await page.goto("/");
	await expect(page.getByLabel("Organization access code")).toBeVisible();
	await page.getByLabel("Organization access code").fill("judge-token");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Your review queue" })).toBeVisible();
	await expect(page.getByText("No teams assigned")).toBeVisible();
	await expect(page.getByText("Northstar / Atlas")).toHaveCount(0);
});

test("shared organizer sessions with a null identity id reach real organizer controls", async ({ page }) => {
	await page.route("**/api/organization/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/api/organization/status") {
			return route.fulfill({ json: {
				organization: "Fixture",
				authenticated: true,
				role: "organizer",
				identity: { id: null, name: "Organization owner", role: "organizer", teamId: null },
			} });
		}
		if (url.pathname === "/api/organization/manage/teams") return route.fulfill({ json: { teams: [], nextCursor: null } });
		if (url.pathname === "/api/organization/manage/overview") return route.fulfill({ json: { counts: { teams: 0, activeTeams: 0, notSubmitted: 0 } } });
		if (url.pathname === "/api/organization/manage/deadlines") return route.fulfill({ json: { analysisDocumentDeadline: null, pullRequestDeadline: null } });
		if (url.pathname === "/api/organization/manage/team-email") return route.fulfill({ json: { enabled: false, subject: "", body: "", senderConfigured: true } });
		if (url.pathname === "/api/organization/round-two/teams") return route.fulfill({ json: { teams: [], deadlines: null } });
		if (url.pathname === "/api/organization/round-two/assignments") return route.fulfill({ json: { assignments: [] } });
		return route.fulfill({ status: 404, json: { error: "UNEXPECTED_ROUTE" } });
	});

	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Organizer command center" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Teams", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Judging progress" })).toBeVisible();
	await page.getByRole("link", { name: "Teams", exact: true }).click();
	await expect(page).toHaveURL(/\/teams$/);
	await expect(page.getByRole("heading", { name: "Team roster" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Import teams" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Judging progress" })).toHaveCount(0);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.getByRole("button", { name: "Open navigation" }).click();
	await page.getByRole("link", { name: "Assignments" }).click();
	await expect(page).toHaveURL(/\/assignments$/);
	await expect(page.getByRole("heading", { name: "Judges and assignments" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Create judge" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Team roster" })).toHaveCount(0);
	await page.goBack();
	await expect(page).toHaveURL(/\/teams$/);
	await expect(page.getByRole("heading", { name: "Team roster" })).toBeVisible();
	await page.goto("/communications");
	await expect(page.getByRole("heading", { name: "Participant communications" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Announcements" })).toBeVisible();
});
