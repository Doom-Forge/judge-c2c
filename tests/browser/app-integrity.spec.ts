import { expect, test } from "@playwright/test";
import { demoDetail, demoRun } from "../../src/demo";

test("serves the React workspace at root and preserves legacy pages", async ({ page }) => {
	await page.route("**/api/organization/status", (route) =>
		route.fulfill({ json: { authenticated: false, organization: "Fixture" } }),
	);
	await page.goto("/");
	await expect(page.locator("#root")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Sign in to Doomforge" }),
	).toBeVisible();
	await expect(page.locator("#main")).toHaveCount(0);

	await page.goto("/review.html");
	await expect(page.locator("#main")).toBeVisible();
	await expect(page.locator("#root")).toHaveCount(0);

	await page.goto("/matrix.html");
	await expect(page.getByRole("heading", { name: "Evidence, then a score." }))
		.toBeVisible();
	await expect(page.locator("#root")).toHaveCount(0);
});

// Controlled schema regressions are distinct from deployed no-mock browser proof.
test("sorts recorded timestamps and does not infer team counts from attempts", async ({ page }) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 2,
					active: 0,
					completed: 4,
					failed: 0,
					attention: 0,
				},
				runs: [
					{
						...demoRun,
						id: "latest",
						created_at: "2026-10-04 12:00:00",
					},
					{
						...demoRun,
						id: "earlier",
						created_at: "2026-10-03 12:00:00",
					},
				],
			},
		}));
	await page.goto("/review.html");
	await expect(page.locator("#rows [data-run]").first()).toHaveAttribute(
		"data-run",
		"latest",
	);
	await page.getByLabel("Sort submissions").selectOption("oldest");
	await expect(page.locator("#rows [data-run]").first()).toHaveAttribute(
		"data-run",
		"earlier",
	);
	await expect(
		page.locator(".metric-item").filter({ hasText: "Not submitted" }),
	).toContainText("Unavailable");
	await expect(
		page.locator(".metric-item").filter({ hasText: "Submitted teams" }),
	).toContainText("Unavailable");
});

test("renders persisted contribution and attention schemas with additive history warning", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/evaluations/*", (route) =>
		route.fulfill({
			json: {
				...demoDetail,
				state: "FAILED",
				failure_code: "RUNNER_UNAVAILABLE",
				currentSubmission: {
					closed: false,
					latestRunId: "newer",
					headSha: "d".repeat(40),
				},
				additionalContributions: [
					{
						id: "candidate",
						category: "testing",
						title: "Coverage",
						description: "Preserved candidate description",
						paths: ["tests/retry.test.ts"],
						evidenceIds: [],
						criterionIds: [],
						verificationStatus: "UNVERIFIED",
						latestDecision: null,
					},
				],
				attentionItems: [
					{
						code: "EXECUTION_UNVERIFIED",
						what: "Execution remains unverified",
						why: "No trusted result covers behavior.",
						inspect: ["timeline"],
						action: "Inspect preserved history.",
					},
				],
			},
		}));
	await page.goto("/review.html?run=" + demoRun.id);
	await expect(page.locator(".state-failed")).toContainText(
		"FAILED EVALUATION",
	);
	await expect(page.locator(".state-superseded")).toContainText(
		"HISTORICAL EVALUATION",
	);
	await expect(page.locator(".contribution-item")).toContainText(
		"tests/retry.test.ts",
	);
	await expect(page.locator(".contribution-status")).toContainText(
		"UNVERIFIED",
	);
	await expect(page.locator(".contribution-status")).toContainText("PENDING");
	await expect(page.locator(".attention-item")).toContainText(
		"No trusted result covers behavior.",
	);
	await expect(page.locator(".attention-item")).toContainText(
		"Inspect preserved history.",
	);
	expect(errors).toEqual([]);
});

test("keeps source-only functional evidence unverified and opens cited evidence", async ({ page }) => {
	const report = JSON.parse(demoDetail.report);
	report.assessments = [
		{
			criterionId: "future-time",
			status: "PASS",
			explanation: "Legacy AI claim",
			evidenceIds: ["source-only"],
		},
	];
	await page.route("**/api/evaluations/*", (route) =>
		route.fulfill({
			json: {
				...demoDetail,
				evidence: JSON.stringify([
					{
						id: "source-only",
						kind: "source",
						criterionId: "future-time",
						status: "PASS",
						claim: "Source contains schedule",
					},
					{
						id: "docs-citation",
						kind: "source",
						criterionId: "docs-heading",
						status: "PASS",
						claim: "Documentation present",
					},
				]),
				report: JSON.stringify(report),
				execution: [],
			},
		}));
	await page.goto("/review.html?run=" + demoRun.id);
	const requirement = page
		.locator(".criterion")
		.filter({ has: page.getByText("future-time", { exact: true }) });
	await expect(requirement.locator(".badge")).toHaveText("UNVERIFIED");
	await expect(
		page.getByText("Regression safety remains UNVERIFIED.", {
			exact: false,
		}),
	).toBeVisible();
	const evidence = page.locator("#e-docs-citation");
	await expect(evidence).not.toBeVisible();
	await page.locator('[data-evidence="docs-citation"]').click();
	await expect(evidence).toBeVisible();
	await expect(page.locator("#content")).not.toContainText("[object Object]");
});

test("direct public review links retain mode and execution limitations", async ({ page }) => {
	await page.route("**/api/evaluations/*", (route) =>
		route.fulfill({
			json: {
				...demoDetail,
				preview: true,
				state: "FAILED",
				failure_code: "GITHUB_HTTP_403",
				report: null,
				evidence: "[]",
				request: {
					prUrl: "https://github.com/octocat/Hello-World/pull/1",
					expectedBehavior:
						"Preserve documented initialization steps.",
					protectedPaths: [],
				},
			},
		}));
	await page.goto("/review.html?run=" + demoRun.id);
	await expect(page.locator("#mode-label")).toHaveText("PUBLIC PR REVIEW");
	await expect(page.locator("#demo-banner")).toContainText(
		"Read-only GitHub",
	);
	await expect(page.locator("#signout")).not.toBeVisible();
	await expect(page.locator(".summary-assessment")).toContainText(
		"GITHUB_HTTP_403",
	);
	await expect(page.locator("#content")).toContainText(
		"No solution approach analysis is recorded for this attempt.",
	);
	await expect(page.locator("#content")).toContainText(
		"Regression safety remains UNVERIFIED",
	);
});
