import { expect, test } from "@playwright/test";
import { demoContract, demoDetail, demoRun } from "../../src/demo";
test("judges can filter submissions and follow criterion evidence", async ({page,}) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 1,
					active: 0,
					completed: 1,
					failed: 0,
					attention: 1,
				},
				runs: [demoRun],
			},
		}));
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: demoDetail }),
	);
	await page.route("**/api/repositories", (route) =>
		route.fulfill({
			json: {
				repositories: [
					{
						full_name: demoRun.full_name,
						document: JSON.stringify(demoContract),
					},
				],
			},
		}));
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html");
	await expect(
		page.getByRole("heading", { name: "Follow the evidence." }),
	).toBeVisible();
	await expect(
		page.getByText("All displayed evidence is synthetic.", {
			exact: false,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "hackathon/CampaignOS" }),
	).toBeVisible();
	await page.getByRole("searchbox").fill("does-not-exist");
	await expect(
		page.getByText("No submissions match.", { exact: false }),
	).toBeVisible();
	await page.getByRole("searchbox").fill("");
	await page.getByLabel("Filter evaluation state").selectOption("COMPLETED");
	await expect(
		page.getByRole("heading", { name: "Competition metrics" }),
	).toBeVisible();
	await page.getByRole("button", { name: "hackathon/CampaignOS" }).click();
	await expect(
		page.getByRole("heading", { name: "Requirements" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Evidence Explorer" }),
	).toBeVisible();
	await page.getByRole("button", { name: "All submissions" }).click();
	expect(errors).toEqual([]);
});

test("needs attention page displays work queue", async ({ page }) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 1,
					active: 0,
					completed: 0,
					failed: 1,
					attention: 1,
				},
				runs: [{
					...demoRun,
					state: "FAILED",
					failure_code: "BUILD_FAILED",
				}],
			},
		}));
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: demoDetail }),
	);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html?attention=1");
	await expect(
		page.getByRole("heading", { name: "Needs Attention" }),
	).toBeVisible();
	expect(errors).toEqual([]);
});

test("competition metrics display on overview", async ({ page }) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 5,
					openSubmissions: 3,
					active: 0,
					completed: 2,
					failed: 1,
					attention: 1,
				},
				runs: [demoRun],
			},
		}));
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: demoDetail }),
	);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html");
	await expect(
		page.getByRole("heading", { name: "Competition metrics" }),
	).toBeVisible();
	await expect(page.getByText("Total teams")).toBeVisible();
	await expect(page.getByText("Submitted teams")).toBeVisible();
	await expect(page.getByText("Evaluation completion rate")).toBeVisible();
	expect(errors).toEqual([]);
});

test("submission sorting works correctly", async ({ page }) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 2,
					active: 0,
					completed: 2,
					failed: 0,
					attention: 0,
				},
				runs: [
					{ ...demoRun, id: "run-1", head_sha: "a".repeat(40) },
					{ ...demoRun, id: "run-2", head_sha: "b".repeat(40) },
				],
			},
		}));
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: demoDetail }),
	);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html");
	await page.getByLabel("Sort submissions").selectOption("oldest");
	await expect(page.getByLabel("Sort submissions")).toHaveValue("oldest");
	expect(errors).toEqual([]);
});

test("judge summary displays key information", async ({ page }) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 1,
					active: 0,
					completed: 1,
					failed: 0,
					attention: 0,
				},
				runs: [demoRun],
			},
		}));
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: demoDetail }),
	);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html");
	await page.getByRole("button", { name: "hackathon/CampaignOS" }).click();
	await expect(
		page.getByRole("heading", { name: "Judge Summary" }),
	).toBeVisible();
	expect(errors).toEqual([]);
});

test("objective checks display baseline comparison", async ({ page }) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 1,
					active: 0,
					completed: 1,
					failed: 0,
					attention: 0,
				},
				runs: [demoRun],
			},
		}));
	const detailWithExecution = {
		...demoDetail,
		evidence: JSON.stringify([
			{
				id: "build-check",
				kind: "execution",
				status: "PASS",
				claim: "Build succeeded",
				baselineStatus: "PASS",
			},
			{
				id: "test-check",
				kind: "execution",
				status: "FAIL",
				claim: "Tests failed",
				baselineStatus: "PASS",
			},
		]),
	};
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: detailWithExecution }),
	);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html");
	await page.getByRole("button", { name: "hackathon/CampaignOS" }).click();
	await expect(
		page.getByRole("heading", { name: "Objective Checks" }),
	).toBeVisible();
	await expect(page.getByText("execution checks")).toBeVisible();
	await expect(page.getByText("↓ Regression")).toBeVisible();
	await expect(page.getByText("→ Unchanged")).toBeVisible();
	expect(errors).toEqual([]);
});

test("AI review state displays grounding information", async ({ page }) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 1,
					active: 0,
					completed: 1,
					failed: 0,
					attention: 0,
				},
				runs: [demoRun],
			},
		}));
	const detailWithAI = {
		...demoDetail,
		ai_status: "COMPLETED",
		report: JSON.stringify({
			...JSON.parse(demoDetail.report),
			aiTrace: {
				model: "llama-3.3-70b",
				grounding: "HIGH",
				citationCount: 5,
				assessment: "VERIFIED",
				requiresHumanAttention: false,
			},
		}),
	};
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: detailWithAI }),
	);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html");
	await page.getByRole("button", { name: "hackathon/CampaignOS" }).click();
	await expect(
		page.getByRole("heading", { name: "AI Review State" }),
	).toBeVisible();
	expect(errors).toEqual([]);
});

test("regressions section displays when failures detected", async ({page,}) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 1,
					active: 0,
					completed: 1,
					failed: 0,
					attention: 0,
				},
				runs: [demoRun],
			},
		}));
	const detailWithRegression = {
		...demoDetail,
		evidence: JSON.stringify([
			{
				id: "regression-check",
				kind: "execution",
				status: "FAIL",
				claim: "New test failure",
				baselineStatus: "PASS",
			},
		]),
	};
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: detailWithRegression }),
	);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html");
	await page.getByRole("button", { name: "hackathon/CampaignOS" }).click();
	await expect(
		page.getByRole("heading", { name: "Regressions" }),
	).toBeVisible();
	await expect(page.getByText("regressions detected")).toBeVisible();
	expect(errors).toEqual([]);
});

test("evidence explorer groups by kind", async ({ page }) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 1,
					active: 0,
					completed: 1,
					failed: 0,
					attention: 0,
				},
				runs: [demoRun],
			},
		}));
	const detailWithEvidence = {
		...demoDetail,
		evidence: JSON.stringify([
			{
				id: "e1",
				kind: "execution",
				status: "PASS",
				claim: "Build succeeded",
			},
			{
				id: "e2",
				kind: "source",
				status: "PASS",
				claim: "Source matches",
			},
			{ id: "e3", kind: "test", status: "FAIL", claim: "Test failed" },
		]),
	};
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: detailWithEvidence }),
	);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html");
	await page.getByRole("button", { name: "hackathon/CampaignOS" }).click();
	await expect(
		page.getByRole("heading", { name: "Evidence Explorer" }),
	).toBeVisible();
	await expect(page.getByText("EXECUTION", { exact: true })).toBeVisible();
	await expect(page.getByText("SOURCE", { exact: true })).toBeVisible();
	await expect(page.getByText("TEST", { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

test("state banners display for evaluation states", async ({ page }) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 1,
					active: 0,
					completed: 0,
					failed: 1,
					attention: 1,
				},
				runs: [{
					...demoRun,
					state: "FAILED",
					failure_code: "BUILD_FAILED",
				}],
			},
		}));
	const detailWithFailure = {
		...demoDetail,
		state: "FAILED",
		failure_code: "BUILD_FAILED",
	};
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: detailWithFailure }),
	);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html");
	await page.getByRole("button", { name: "hackathon/CampaignOS" }).click();
	await expect(page.getByText("FAILED EVALUATION")).toBeVisible();
	await expect(page.getByText("BUILD_FAILED")).toBeVisible();
	expect(errors).toEqual([]);
});

test("performance section displays when benchmarks available", async ({page,}) => {
	await page.route("**/api/overview", (route) =>
		route.fulfill({
			json: {
				demo: true,
				counts: {
					repositories: 1,
					teams: 1,
					openSubmissions: 1,
					active: 0,
					completed: 1,
					failed: 0,
					attention: 0,
				},
				runs: [demoRun],
			},
		}));
	const detailWithBenchmark = {
		...demoDetail,
		evidence: JSON.stringify([
			{
				id: "perf-check",
				kind: "benchmark",
				status: "PASS",
				claim: "Performance improved",
				baselineStatus: "FAIL",
			},
		]),
	};
	await page.route(
		"**/api/evaluations/*",
		(route) => route.fulfill({ json: detailWithBenchmark }),
	);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html");
	await page.getByRole("button", { name: "hackathon/CampaignOS" }).click();
	await expect(
		page.getByRole("heading", { name: "Performance" }),
	).toBeVisible();
	await expect(page.getByText("1 benchmarks")).toBeVisible();
	expect(errors).toEqual([]);
});

test("review APIs reject privileged writes and expose security headers", async ({request,}) => {
	const response = await request.get("/health");
	expect(response.ok()).toBeTruthy();
	expect(response.headers()["content-security-policy"]).toContain(
		"frame-ancestors 'none'",
	);
	expect((await response.json()).mode).toBe("public-pr-review");
	expect((await request.post("/api/contracts", { data: {} })).status()).toBe(
		403,
	);
	expect((await request.post("/webhooks/github", { data: {} })).status())
		.toBe(
			503,
		);
});
test("the workspace fits a mobile viewport", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/review.html");
	await expect(
		page.getByRole("heading", { name: "Submission activity" }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBeTruthy();
});

test("a public PR can be submitted, polled and inspected without fabricated functional PASS", async ({page,}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const id = "d".repeat(64);
	await page.route("**/api/preview/evaluations", async (route) => {
		const body = route.request().postDataJSON();
		expect(body.prUrl).toBe("https://github.com/example/project/pull/12");
		expect(body.expectedBehavior).toBe(
			"The scheduler should persist future execution times.",
		);
		expect(body.sourceAssertion).toEqual({
			path: "README.md",
			text: "Scheduling",
		});
		await route.fulfill({
			status: 202,
			json: { runId: id, status: "queued" },
		});
	});
	let polls = 0;
	await page.route("**/api/evaluations/" + id, (route) => {
		const ready = ++polls > 1;
		const contract = {
			...demoContract,
			department: "Public PR review",
			repository: { id: 1, fullName: "example/project" },
			issueNumbers: [],
			baselineSource: "captured-pr-merge-base",
			prTitle: "<script>window.injection=true</script>",
			requirements: [
				{
					id: "expectation",
					title: "Expected behavior",
					mandatory: true,
					criteria: [
						{
							id: "expected-behavior",
							description:
								"The scheduler should persist future execution times.",
							kind: "functional",
							verification: { type: "human" },
						},
					],
				},
			],
		};
		route.fulfill({
			json: {
				...demoDetail,
				id,
				preview: true,
				full_name: "example/project",
				pr_number: 12,
				state: ready ? "COMPLETED" : "FETCHING",
				contract_snapshot: ready ? JSON.stringify(contract) : null,
				evidence: ready
					? JSON.stringify([
						{
							id: "diff",
							kind: "diff",
							status: "PASS",
							claim: "Frozen exact commits compared.",
						},
						{
							id: "criterion-expected-behavior",
							kind: "policy",
							status: "UNVERIFIED",
							criterionId: "expected-behavior",
							claim: "Requires human verification.",
						},
					])
					: null,
				report: ready
					? JSON.stringify({
						summary: "Runtime behavior requires verification.",
						assessments: [
							{
								criterionId: "expected-behavior",
								status: "UNVERIFIED",
								explanation: "Requires human verification.",
								evidenceIds: ["criterion-expected-behavior"],
							},
						],
						findings: [],
					})
					: null,
				request: {
					prUrl: "https://github.com/example/project/pull/12",
					expectedBehavior:
						"The scheduler should persist future execution times.",
				},
				context: ready
					? JSON.stringify({
						files: [
							{
								filename: "README.md",
								status: "modified",
								additions: 1,
								deletions: 0,
								patch:
									"+ Scheduling\n+ <script>window.injection=true</script>",
							},
						],
					})
					: null,
				ai_status: "NOT_RUN",
				publication_status: "READ_ONLY_GITHUB",
			},
		});
	});
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "Evaluate a real public PR" }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Use prepared public example" })
		.click();
	await expect(page.getByLabel("Public GitHub pull request URL")).toHaveValue(
		"https://github.com/octocat/Hello-World/pull/1",
	);
	await page
		.getByText("Baseline and objective assertions (optional)", {
			exact: true,
		})
		.click();
	await page
		.getByLabel("Public GitHub pull request URL")
		.fill("https://github.com/example/project/pull/12");
	await page
		.getByLabel("What was the team expected to implement?")
		.fill("The scheduler should persist future execution times.");
	await page
		.getByText("Baseline and objective assertions (optional)", {
			exact: true,
		})
		.click();
	await page.getByLabel("Source assertion: file path").fill("README.md");
	await page.getByLabel("Must contain this literal text").fill("Scheduling");
	await page.getByRole("button", { name: "Evaluate PR", exact: true })
		.click();
	await expect(
		page.getByText("FETCHING", { exact: true }).first(),
	).toBeVisible();
	await expect(
		page.getByText("COMPLETED", { exact: true }).first(),
	).toBeVisible({ timeout: 10000 });
	await expect(
		page.locator(".inset").getByText(
			"Runtime behavior requires verification.",
		),
	).toBeVisible();
	await expect(
		page.getByText(
			"Baseline: captured PR merge base, not an organizer-frozen challenge baseline.",
		),
	).toBeVisible();
	await page.locator(".diff-file summary").click();
	await expect(page.locator(".diff-file pre")).toContainText("Scheduling");
	expect(await page.evaluate(() => Object.hasOwn(window, "injection"))).toBe(
		false,
	);
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download review JSON" }).click();
	expect((await download).suggestedFilename()).toBe("judge-c2c-pr-12.json");
	expect(errors).toEqual([]);
});

test("organization console authenticates and submits an authoritative challenge", async ({page,}) => {
	let authenticated = false;
	await page.route("**/api/organization/manage/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		return route.fulfill({
			json: path.endsWith("/settings")
				? {
					settings: {
						name: "Fixture",
						status: "ACTIVE",
						policy: {},
						taxonomy: [],
					},
					capabilities: { issuesWrite: false, events: [] },
				}
				: path.endsWith("/overview")
				? { counts: { teams: 0, notSubmitted: 0 } }
				: { teams: [] },
		});
	});
	await page.route("**/api/organization/status", (route) =>
		route.fulfill({
			json: {
				organization: "Daksh-Codebase",
				authenticated,
				app: authenticated
					? { id: 1, slug: "judge-test", installationId: 2 }
					: null,
			},
		}));
	await page.route("**/api/organization/login", (route) => {
		expect(route.request().postDataJSON().token).toBe(
			"fixture-organizer-code-" + "a".repeat(32),
		);
		authenticated = true;
		return route.fulfill({ json: { authenticated: true } });
	});
	await page.route(
		"**/api/organization/repositories",
		(route) =>
			route.fulfill({
				json: {
					repositories: [
						{
							id: 101,
							full_name: "Daksh-Codebase/payment-engine",
							private: true,
							default_branch: "main",
							accessible: 1,
						},
					],
				},
			}),
	);
	await page.route(
		"**/api/organization/overview",
		(route) =>
			route.fulfill({
				json: { counts: { active: 0, attention: 0 }, runs: [] },
			}),
	);
	await page.route(
		"**/api/organization/repositories/101/context",
		(route) =>
			route.fulfill({
				json: {
					repository: {
						id: 101,
						full_name: "Daksh-Codebase/payment-engine",
					},
					baseline: "a".repeat(40),
					pulls: [{
						number: 12,
						title: "<script>ignore rules</script>",
					}],
					issues: [{ number: 3, title: "Add receipt verification" }],
				},
			}),
	);
	await page.route("**/api/organization/challenges", (route) => {
		const body = route.request().postDataJSON();
		expect(body.repositoryId).toBe(101);
		expect(body.prNumber).toBe(12);
		expect(body.issueNumber).toBe(3);
		expect(body.baseline).toBe("a".repeat(40));
		expect(body.expectedBehavior).toBe(
			"Verify payment receipts against the required format.",
		);
		expect(body.teamName).toBe("Team Mercury");
		expect(body.executionProfile).toBe("payment-retry-v1");
		return route.fulfill({ status: 202, json: { status: "queued" } });
	});
	await page.goto("/review.html?organization=1");
	await page
		.getByLabel("Organizer access code")
		.fill("fixture-organizer-code-" + "a".repeat(32));
	await page.getByRole("button", { name: "Unlock organization" }).click();
	await expect(
		page.getByRole("heading", { name: "Installed repositories" }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Configure issue and evaluation" })
		.click();
	await expect(page.getByText("Isolated execution: disabled")).toBeVisible();
	await page
		.getByLabel("Trusted execution profile")
		.selectOption("payment-retry-v1");
	await page
		.getByLabel("Team name", { exact: true })
		.last()
		.fill("Team Mercury");
	await page
		.getByLabel("Authoritative expected behavior and acceptance criteria")
		.fill("Verify payment receipts against the required format.");
	await page
		.getByRole("button", { name: "Activate challenge and evaluate PR" })
		.click();
	await expect(
		page.getByRole("heading", { name: "Organization evaluations" }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => document.querySelectorAll("script:not([src])").length,
		),
	).toBe(0);
});

test("organizers see not-submitted teams, member identity and issue provenance together", async ({page,}) => {
	await page.route("**/api/organization/status", (r) =>
		r.fulfill({
			json: {
				organization: "Daksh-Codebase",
				authenticated: true,
				app: { slug: "judge-fixture", installationId: 1 },
				runner: { enabled: false },
				ai: { enabled: false },
			},
		}));
	await page.route("**/api/organization/repositories", (r) =>
		r.fulfill({
			json: {
				repositories: [
					{
						id: 101,
						full_name: "fixture/challenge",
						accessible: 1,
						default_branch: "main",
					},
				],
			},
		}));
	await page.route(
		"**/api/organization/overview",
		(r) =>
			r.fulfill({
				json: { counts: { active: 0, attention: 0 }, runs: [] },
			}),
	);
	const team = {
		id: "team-stable",
		name: "Alpha <script>alert(1)</script>",
		status: "ACTIVE",
		github_members: "alice, bob",
		submission_count: 0,
	};
	let issueQuery = new URLSearchParams();
	let issueReview: Record<string, string> = {};
	let holdTeam = false,
		releaseTeam: () => void = () => {},
		teamEntered: () => void = () => {};
	const teamGate = new Promise<void>((r) => (releaseTeam = r)),
		teamPending = new Promise<void>((r) => (teamEntered = r));
	await page.route("**/api/organization/manage/**", async (route) => {
		const url = new URL(route.request().url());
		const p = url.pathname.split("/manage/")[1];
		if (p === "issues") issueQuery = url.searchParams;
		if (p === "issues/101/12/review") {
			issueReview = route.request().postDataJSON();
		}
		if (p === "issues/101/12") {
			return route.fulfill({
				json: {
					issue: {
						repository_id: 101,
						number: 12,
						title: "Missing validation",
						source: "PARTICIPANT",
						author_login: "alice",
						reporter_team_id: "team-stable",
						github_state: "open",
						review_status: "NEEDS_TRIAGE",
						body: "Expected validation, actual crash.",
						classification: { flags: [] },
					},
					definition: null,
					versions: [],
					assignments: [],
					submissions: [
						{
							pr_number: 23,
							team_name: "Related team",
							status: "VALID",
							evaluation_state: "COMPLETED",
							head_sha: "a".repeat(40),
							latest_run_id: "related-run",
						},
					],
					decisions: [],
				},
			});
		}
		if (p === "teams" && holdTeam) {
			teamEntered();
			await teamGate;
		}
		const data = p === "settings"
			? {
				settings: {
					name: "Fixture",
					status: "ACTIVE",
					policy: { claimingEnabled: false },
					taxonomy: [],
				},
				capabilities: {
					issuesWrite: false,
					events: ["pull_request"],
					app: {
						name: "Judge-C2C Daksh-Codebase",
						owner: "Daksh-Codebase",
						settingsUrl:
							"https://github.com/organizations/Daksh-Codebase/settings/apps/judge-c2c-daksh-codebase",
						installationUrl:
							"https://github.com/organizations/Daksh-Codebase/settings/installations/167005353",
					},
				},
			}
			: p === "overview"
			? { counts: { teams: 1, notSubmitted: 1, needsTriage: 1 } }
			: p === "teams/team-stable"
			? {
				team,
				members: [
					{
						id: "m1",
						display_name: "Alice",
						github_login: "alice",
						github_id: 101,
						active: 1,
					},
				],
				repositories: [
					{
						repository_id: 101,
						full_name: "fixture/challenge",
						active: 1,
					},
				],
				assignments: [],
				submissions: [],
				raisedIssues: [
					{
						number: 12,
						title: "Missing validation",
						review_status: "NEEDS_TRIAGE",
					},
				],
				evaluations: [],
			}
			: p === "issues"
			? {
				issues: [
					{
						repository_id: 101,
						number: 12,
						title: "Missing validation",
						full_name: "fixture/challenge",
						source: "PARTICIPANT",
						review_status: "NEEDS_TRIAGE",
						official: 0,
					},
				],
			}
			: p === "submissions"
			? { teams: [team] }
			: { teams: [team] };
		return route.fulfill({ json: data });
	});
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/review.html?organization=1");
	await expect(
		page.getByRole("heading", { name: "Hackathon workflow" }),
	).toBeVisible();
	await expect(
		page.getByText("Owner setup needed:", { exact: false }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Open App settings" }),
	).toHaveAttribute(
		"href",
		"https://github.com/organizations/Daksh-Codebase/settings/apps/judge-c2c-daksh-codebase",
	);
	await expect(
		page.getByRole("link", { name: "Open installation" }),
	).toHaveAttribute(
		"href",
		"https://github.com/organizations/Daksh-Codebase/settings/installations/167005353",
	);
	await page
		.getByRole("button", {
			name: "Alpha <script>alert(1)</script>",
			exact: false,
		})
		.click();
	await expect(
		page.getByText("Alice · @alice · GitHub ID 101", { exact: false }),
	).toBeVisible();
	await expect(page.getByText("NOT SUBMITTED", { exact: true }))
		.toBeVisible();
	await page.getByRole("button", { name: "Issues", exact: true }).click();
	await expect(
		page.getByText("PARTICIPANT · NEEDS_TRIAGE · Not scored"),
	).toBeVisible();
	await page.getByLabel("Priority filter").selectOption("high");
	await page.getByLabel("Difficulty filter").selectOption("hard");
	await page.getByLabel("Source filter").selectOption("PARTICIPANT");
	await page.getByLabel("Work progress").selectOption("assigned");
	await page.getByLabel("Label filter").fill("judge:type:bug");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect.poll(() => issueQuery.get("priority")).toBe("high");
	expect(issueQuery.get("difficulty")).toBe("hard");
	expect(issueQuery.get("workflow")).toBe("assigned");
	expect(issueQuery.get("source")).toBe("PARTICIPANT");
	expect(issueQuery.get("label")).toBe("judge:type:bug");
	await page
		.getByRole("button", {
			name: "fixture/challenge #12 · Missing validation",
			exact: false,
		})
		.click();
	await page.getByLabel("Priority override").selectOption("high");
	await expect(
		page.getByRole("heading", { name: "Related submissions" }),
	).toBeVisible();
	await expect(page.getByText("PR #23 · Related team")).toBeVisible();
	await expect(
		page.getByText("Submission VALID · evaluation COMPLETED", {
			exact: false,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("link", {
			name: "Inspect current requirements, approach and evidence",
		}),
	).toHaveAttribute("href", "?organization=1&evaluation=related-run");
	await page.getByLabel("Difficulty override").selectOption("hard");
	await page.getByLabel("Technical severity override").selectOption("medium");
	await page
		.getByLabel("Recognition rationale")
		.fill("Reproducible report independently reviewed by organizer.");
	await page
		.getByLabel("Decision reason", { exact: true })
		.fill("Organizer assessed impact separately from technical severity.");
	await page
		.getByRole("button", { name: "Record review", exact: true })
		.click();
	await expect.poll(() => issueReview.priority).toBe("high");
	expect(issueReview.difficulty).toBe("hard");
	expect(issueReview.severity).toBe("medium");
	expect(issueReview.recognition).toBe(
		"Reproducible report independently reviewed by organizer.",
	);
	holdTeam = true;
	await page.getByRole("button", { name: "Teams", exact: true }).click();
	await teamPending;
	await page.getByRole("button", { name: "Issues", exact: true }).click();
	await expect(
		page.getByText("PARTICIPANT · NEEDS_TRIAGE · Not scored"),
	).toBeVisible();
	releaseTeam();
	await page.getByRole("button", { name: "Submissions", exact: true })
		.click();
	await page
		.getByLabel("Status", { exact: true })
		.selectOption("NOT_SUBMITTED");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(
		page.getByRole("button", {
			name: "Alpha <script>alert(1)</script>",
			exact: false,
		}),
	).toBeVisible();
	expect(errors).toEqual([]);
});

test("approach review exposes separate evidence-backed observations and uncertainty", async ({page,}) => {
	await page.route("**/api/organization/status", (r) =>
		r.fulfill({
			json: {
				organization: "Daksh-Codebase",
				authenticated: true,
				app: { slug: "fixture", installationId: 1 },
			},
		}));
	await page.route(
		"**/api/organization/repositories",
		(r) => r.fulfill({ json: { repositories: [] } }),
	);
	await page.route(
		"**/api/organization/overview",
		(r) =>
			r.fulfill({
				json: { counts: { active: 0, attention: 0 }, runs: [] },
			}),
	);
	await page.route("**/api/organization/manage/**", (r) =>
		r.fulfill({
			json: r.request().url().endsWith("settings")
				? {
					settings: {
						name: "Fixture",
						status: "ACTIVE",
						policy: {},
						taxonomy: [],
					},
				}
				: r.request().url().endsWith("overview")
				? { counts: {} }
				: { teams: [] },
		}));
	const unavailable = {
		text: "Repository-wide behavior remains unverified.",
		evidenceIds: [],
		verification: "UNVERIFIED",
	};
	const approach = {
		problem_understanding: unavailable,
		approach_summary: {
			text: "A scheduling path appears to have been added.",
			evidenceIds: ["diff"],
			verification: "INFERENCE",
		},
		solution_design: unavailable,
		strengths: [],
		weaknesses: [],
		tradeoffs: [],
		correctness: unavailable,
		maintainability: unavailable,
		architecture_fit: unavailable,
		evidence: ["diff"],
		unverified_assumptions: [unavailable],
	};
	const detail = {
		...demoDetail,
		report: JSON.stringify({
			...JSON.parse(demoDetail.report),
			solution_approach: approach,
		}),
		execution: [],
		artifacts: [],
	};
	await page.route(
		"**/api/organization/evaluations/*",
		(r) => r.fulfill({ json: detail }),
	);
	await page.goto("/review.html?organization=1&evaluation=" + demoRun.id);
	await expect(
		page.getByRole("heading", { name: "Observable solution approach" }),
	).toBeVisible();
	await expect(
		page.getByText("A scheduling path appears to have been added.", {
			exact: false,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "unverified assumptions" }),
	).toBeVisible();
	await expect(
		page.getByText("Private reasoning is unknown.", { exact: false }),
	).toBeVisible();
	await expect(
		page.getByText("UNVERIFIED AI interpretation", { exact: false })
			.first(),
	).toBeVisible();
	const legacyRequirement = page.locator(
		'.requirement-group[data-requirement-id="schedule"]',
	);
	await expect(legacyRequirement.locator(".badge")).toHaveText("UNVERIFIED");
	await expect(legacyRequirement.getByText("Mandatory")).toBeVisible();
	await expect(
		page.getByText("No additional contributions have been recorded."),
	).toBeVisible();
});

test("judge detail separates stale runs, compares checks, shows provenance and gates artifact downloads", async ({page,}) => {
	await page.route("**/api/organization/status", (r) =>
		r.fulfill({
			json: {
				organization: "Fixture",
				authenticated: true,
				role: "judge",
				app: { slug: "fixture", installationId: 1 },
			},
		}));
	await page.route(
		"**/api/organization/repositories",
		(r) => r.fulfill({ json: { repositories: [] } }),
	);
	await page.route(
		"**/api/organization/overview",
		(r) =>
			r.fulfill({
				json: { counts: { active: 0, attention: 0 }, runs: [] },
			}),
	);
	await page.route(
		"**/api/organization/manage/**",
		(r) => r.fulfill({ json: { counts: {} } }),
	);
	const runId = "historical-run",
		detail = {
			...demoDetail,
			id: runId,
			state: "COMPLETED",
			baseline_sha: "a".repeat(40),
			head_sha: "b".repeat(40),
			currentSubmission: {
				headSha: "c".repeat(40),
				latestRunId: "newer-run",
				closed: false,
			},
			requirementResults: [
				{
					requirementId: "req",
					mandatory: false,
					status: "PARTIAL",
					needsAttention: true,
					criteria: [
						{
							criterionId: "criterion-one",
							status: "FAIL",
							evidenceIds: ["objective-evidence"],
							reason: "Trusted execution failed this criterion.",
						},
					],
				},
			],
			additionalContributions: [
				{
					id: "judge-read-contribution",
					runId,
					actor: "team-member",
					category: "testing",
					title: "Added a focused test",
					description:
						"The test covers an edge case in the current implementation.",
					paths: ["src/scheduler.ts"],
					evidenceIds: ["objective-evidence"],
					criterionIds: ["criterion-one"],
					verificationStatus: "UNVERIFIED",
					createdAt: "2026-01-02T03:00:00.000Z",
					latestDecision: null,
				},
			],
			contract_snapshot: JSON.stringify({
				...demoContract,
				repository: { fullName: "example/project" },
				requirements: [
					{
						id: "req",
						title: "Requirement",
						criteria: [
							{
								id: "criterion-one",
								description:
									"<img src=x onerror=window.hostile=true>",
								kind: "functional",
							},
						],
					},
				],
			}),
			evidence: JSON.stringify([
				{
					id: "objective-evidence",
					status: "PASS",
					claim: "Trusted check passed.",
				},
			]),
			report: JSON.stringify({
				summary: "Advisory summary.",
				findings: [
					{
						category: "security",
						severity: "high",
						claim:
							"<img src=x onerror=window.hostile=true> requires review.",
						evidenceIds: ["objective-evidence"],
						verification: "inference",
					},
					...["quality", "architecture", "performance"].map((
						category,
					) => ({
						category,
						severity: "medium",
						claim: category + " interpretation requires review.",
						evidenceIds: ["objective-evidence"],
						verification: "inference",
					})),
				],
				assessments: [
					{
						criterionId: "criterion-one",
						status: "PASS",
						explanation: "Evidence supports the criterion.",
						evidenceIds: ["objective-evidence"],
					},
				],
			}),
			execution: [
				{
					commit_sha: "a".repeat(40),
					result_hash: "older-baseline-digest",
					created_at: "2026-01-01 00:00:00",
					result: JSON.stringify({
						image: "fixture",
						runtime: "node",
						version: "22",
						checks: [
							{
								kind: "test",
								id: "suite",
								status: "PASS",
								detail: "Older baseline retry passed.",
								durationMs: 1,
							},
						],
					}),
				},
				{
					commit_sha: "a".repeat(40),
					result_hash: "baseline-digest",
					request_hash: "request-digest",
					created_at: "2026-01-01T00:00:00.000Z",
					cache_status: "MISS",
					result: JSON.stringify({
						image: "fixture",
						runtime: "node",
						version: "22",
						checks: [
							{
								kind: "test",
								id: "suite",
								status: "FAIL",
								detail: "Failed before this change.",
								durationMs: 1,
							},
							{
								kind: "test",
								id: "new-suite",
								status: "PASS",
								detail: "Baseline passed.",
								durationMs: 1,
							},
						],
					}),
				},
				{
					commit_sha: "b".repeat(40),
					result_hash: "head-digest",
					request_hash: "request-digest",
					created_at: "2026-01-02 03:05:00",
					cache_status: "HIT",
					origin_run_id: "origin-run",
					origin_execution_id: "origin-exec",
					cache_key: "cache-key",
					request: JSON.stringify({
						schemaVersion: 1,
						runId,
						commit: "b".repeat(40),
						policyHash: "policy-hash",
						files: [{
							path: "src/app.js",
							sha256: "file-digest",
							bytes: 10,
						}],
					}),
					result: JSON.stringify({
						image: "fixture",
						runtime: "node",
						version: "22",
						checks: [
							{
								kind: "test",
								id: "suite",
								status: "FAIL",
								detail: "Still failing.",
								durationMs: 2,
							},
							{
								kind: "test",
								id: "new-suite",
								status: "FAIL",
								detail: "Introduced failure.",
								durationMs: 2,
							},
						],
						startedAt: "2026-01-02T03:04:05.000Z",
						finishedAt: "2026-01-02T03:04:06.000Z",
					}),
				},
			],
			artifacts: [
				{
					key: "safe/stored?x",
					kind: "stdout",
					status: "STORED",
					bytes: 20,
					sha256: "artifact-digest",
					created_at: "2026-01-02T00:00:00.000Z",
					expires_at: Date.now() + 60_000,
				},
				{
					key: "failed-key",
					kind: "<img src=x>",
					status: "FAILED",
					error_code: "<script>window.hostile=true</script>",
					bytes: 0,
					created_at: "2026-01-02T00:00:00.000Z",
				},
				{
					key: "pending-key",
					kind: "pending",
					status: "PENDING",
					bytes: 0,
					created_at: "2026-01-02T00:00:00.000Z",
				},
				{
					key: "expired-key",
					kind: "old",
					status: "STORED",
					bytes: 4,
					sha256: "old",
					created_at: "2025-01-01T00:00:00.000Z",
					expires_at: 1,
				},
			],
		};
	await page.route(
		"**/api/organization/evaluations/*",
		(r) => r.fulfill({ json: detail }),
	);
	await page.goto("/review.html?organization=1&evaluation=" + runId);
	await expect(page.locator(".freshness.historical")).toBeVisible();
	const requirementGroup = page.locator(
		'.requirement-group[data-requirement-id="req"]',
	);
	await expect(requirementGroup.locator(".badge")).toHaveText("PARTIAL");
	await expect(requirementGroup.getByText("Optional")).toBeVisible();
	await expect(requirementGroup.getByText("Needs attention")).toBeVisible();
	await expect(
		requirementGroup.getByText("criterion-one · FAIL"),
	).toBeVisible();
	await expect(
		requirementGroup.getByText("Trusted execution failed this criterion."),
	).toBeVisible();
	await expect(
		requirementGroup.getByRole("link", { name: "objective-evidence" }),
	).toHaveAttribute("href", "#evidence-objective-evidence");
	await expect(
		page.getByRole("heading", { name: "Engineering findings" }),
	).toBeVisible();
	const engineeringFinding = page.locator(".engineering-finding");
	await expect(engineeringFinding).toHaveCount(4);
	for (
		const [index, category] of [
			"security",
			"quality",
			"architecture",
			"performance",
		].entries()
	) {
		const card = engineeringFinding.nth(index);
		await expect(card).toContainText(category);
		await expect(card).toContainText(index === 0 ? "high" : "medium");
		await expect(card).toContainText("UNVERIFIED AI interpretation");
		await expect(
			card.getByRole("link", { name: "objective-evidence" }),
		).toHaveAttribute("href", "#evidence-objective-evidence");
	}
	await expect(engineeringFinding.first()).toContainText(
		"<img src=x onerror=window.hostile=true> requires review.",
	);
	const readContribution = page.locator(
		'[data-contribution-id="judge-read-contribution"]',
	);
	await expect(
		page.getByRole("heading", { name: "Additional contributions" }),
	).toBeVisible();
	await expect(
		readContribution.getByText("Added a focused test"),
	).toBeVisible();
	await expect(
		readContribution.getByRole("link", { name: "objective-evidence" }),
	).toBeVisible();
	await expect(
		readContribution.getByRole("button", {
			name: "Recognize criterion improvement",
		}),
	).toHaveCount(0);
	await expect(page.locator("#add-contribution-form")).toHaveCount(0);
	await expect(
		page.getByText(/multiple exact-commit executions exist/),
	).toBeVisible();
	await expect(page.getByText(/regression observed/)).toHaveCount(0);
	await expect(
		page.getByText(/original execution: 2026-01-02T03:04:05.000Z/),
	).toBeVisible();
	await expect(
		page.getByText(/Recorded in detail: 2026-01-02T03:05:00.000Z/),
	).toBeVisible();
	await expect(page.getByText("Cache: HIT", { exact: false })).toBeVisible();
	await expect(page.getByText("origin-run", { exact: false })).toBeVisible();
	await expect(
		page.getByText("AI interpretation is advisory inference.", {
			exact: false,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Download protected artifact" }),
	).toHaveAttribute("href", /key=safe%2Fstored%3Fx/);
	await expect(page.getByText("Download unavailable")).toHaveCount(2);
	await expect(page.getByText("Download expired")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Retry artifact capture" }),
	).toHaveCount(0);
	await expect(page.locator("#evidence-objective-evidence")).toBeVisible();
	await expect(page.locator("img")).toHaveCount(0);
	expect(await page.evaluate(() => (window as any).hostile)).toBeUndefined();
});

test("organizers can recapture artifacts without rerunning evaluation and see partial results", async ({page,}) => {
	const runId = "organizer-capture-run";
	let detailRequests = 0;
	await page.route("**/api/organization/status", (r) =>
		r.fulfill({
			json: {
				organization: "Fixture",
				authenticated: true,
				role: "organizer",
				app: { slug: "fixture", installationId: 1 },
			},
		}));
	await page.route(
		"**/api/organization/repositories",
		(r) => r.fulfill({ json: { repositories: [] } }),
	);
	await page.route(
		"**/api/organization/overview",
		(r) =>
			r.fulfill({
				json: { counts: { active: 0, attention: 0 }, runs: [] },
			}),
	);
	await page.route(
		"**/api/organization/manage/**",
		(r) => r.fulfill({ json: { counts: {} } }),
	);
	const detail = {
		...demoDetail,
		id: runId,
		state: "COMPLETED",
		contract_snapshot: JSON.stringify(demoContract),
		artifacts: [
			{
				key: "capture-key",
				run_id: runId,
				sha256: "capture-digest",
				bytes: 0,
				content_type: "text/plain",
				created_at: "2026-01-01 00:00:00",
				kind: "stderr",
				storage: "KV",
				status: "FAILED",
				expires_at: Date.now() + 60_000,
				error_code: "STORAGE_UNAVAILABLE",
			},
		],
	};
	await page.route("**/api/organization/evaluations/" + runId, (r) => {
		detailRequests += 1;
		return r.fulfill({
			json: {
				...detail,
				artifacts: detailRequests > 1
					? [{ ...detail.artifacts[0], status: "STORED", bytes: 12 }]
					: detail.artifacts,
			},
		});
	});
	let retryBody: string | null = null;
	await page.route(
		"**/api/organization/evaluations/" + runId + "/artifacts/retry",
		(r) => {
			retryBody = r.request().postData();
			return r.fulfill({
				json: {
					runId,
					status: "PARTIAL",
					artifacts: [],
					failures: [{ kind: "stderr", code: "STORAGE_UNAVAILABLE" }],
				},
			});
		},
	);
	let evaluationRetries = 0;
	await page.route(
		"**/api/organization/evaluations/" + runId + "/retry",
		(r) => {
			evaluationRetries += 1;
			return r.fulfill({
				json: { runId: "unexpected-evaluation-retry" },
			});
		},
	);
	await page.goto("/review.html?organization=1&evaluation=" + runId);
	await page.getByRole("button", { name: "Retry artifact capture" }).click();
	await expect(
		page.getByText(
			"Artifact capture PARTIAL. stderr: STORAGE_UNAVAILABLE.",
		),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Download protected artifact" }),
	).toBeVisible();
	expect(retryBody).toBe("{}");
	expect(detailRequests).toBe(2);
	expect(evaluationRetries).toBe(0);
});

test("organizer contribution controls use verified evidence and refresh guarded decisions", async ({page,}) => {
	const runId = "contribution-run";
	let detailRequests = 0;
	let contributionBody: Record<string, unknown> | null = null;
	const capturedDecision: { body: Record<string, unknown> | null } = {
		body: null,
	};
	let decisionStatus = 409;
	const contribution = {
		id: "candidate-1",
		runId,
		actor: "organizer",
		category: "testing",
		title: "Edge coverage",
		description: "Covers a boundary case.",
		paths: ["src/one.ts"],
		evidenceIds: ["evidence-1"],
		criterionIds: ["verified-criterion"],
		verificationStatus: "VERIFIED",
		createdAt: "2026-01-03T00:00:00.000Z",
		latestDecision: null,
	};
	let detail: any = {
		...demoDetail,
		id: runId,
		state: "COMPLETED",
		head_sha: "b".repeat(40),
		currentSubmission: {
			headSha: "b".repeat(40),
			latestRunId: runId,
			closed: false,
		},
		contract_snapshot: JSON.stringify({
			...demoContract,
			additionalCategories: ["testing"],
			requirements: [
				{
					id: "req",
					title: "Requirement",
					mandatory: false,
					criteria: [
						{
							id: "verified-criterion",
							description: "Verified.",
							kind: "functional",
						},
						{
							id: "unknown-criterion",
							description: "Unknown.",
							kind: "functional",
						},
					],
				},
				{
					id: "mandatory-req",
					title: "Mandatory requirement",
					mandatory: true,
					criteria: [
						{
							id: "mandatory-pass",
							description: "Mandatory verified criterion.",
							kind: "functional",
						},
					],
				},
			],
		}),
		context: JSON.stringify({ files: [{ filename: "src/one.ts" }] }),
		evidence: JSON.stringify([
			{ id: "evidence-1", status: "PASS", claim: "Trusted result." },
		]),
		report: JSON.stringify({
			assessments: [{ criterionId: "unknown-criterion", status: "PASS" }],
		}),
		requirementResults: [
			{
				requirementId: "req",
				mandatory: false,
				status: "PARTIAL",
				needsAttention: true,
				criteria: [
					{
						criterionId: "verified-criterion",
						status: "PASS",
						evidenceIds: ["evidence-1"],
						reason: "Trusted pass.",
					},
					{
						criterionId: "unknown-criterion",
						status: "UNVERIFIED",
						evidenceIds: [],
						reason: "No execution.",
					},
				],
			},
			{
				requirementId: "mandatory-req",
				mandatory: true,
				status: "PASS",
				needsAttention: false,
				criteria: [
					{
						criterionId: "mandatory-pass",
						status: "PASS",
						evidenceIds: ["evidence-1"],
						reason: "Trusted pass.",
					},
				],
			},
		],
		additionalContributions: [
			contribution,
			{
				...contribution,
				id: "unknown-candidate",
				verificationStatus: "UNVERIFIED",
			},
		],
		artifacts: [],
	};
	await page.route("**/api/organization/status", (r) =>
		r.fulfill({
			json: {
				organization: "Fixture",
				authenticated: true,
				role: "organizer",
				app: { slug: "fixture", installationId: 1 },
			},
		}));
	await page.route(
		"**/api/organization/repositories",
		(r) => r.fulfill({ json: { repositories: [] } }),
	);
	await page.route(
		"**/api/organization/overview",
		(r) =>
			r.fulfill({
				json: { counts: { active: 0, attention: 0 }, runs: [] },
			}),
	);
	await page.route(
		"**/api/organization/manage/**",
		(r) => r.fulfill({ json: { counts: {} } }),
	);
	await page.route("**/api/organization/evaluations/" + runId, (r) => {
		detailRequests += 1;
		return r.fulfill({ json: detail });
	});
	await page.route(
		"**/api/organization/evaluations/" + runId + "/contributions",
		(r) => {
			contributionBody = r.request().postDataJSON();
			detail = {
				...detail,
				additionalContributions: [
					...detail.additionalContributions,
					{
						...contribution,
						id: "new-candidate",
						...contributionBody,
						verificationStatus: "UNVERIFIED",
						latestDecision: null,
					},
				],
			};
			return r.fulfill({ json: { id: "new-candidate" } });
		},
	);
	await page.route(
		"**/api/organization/contributions/candidate-1/decisions",
		(r) => {
			capturedDecision.body = r.request().postDataJSON();
			if (decisionStatus === 409) {
				return r.fulfill({
					status: 409,
					json: { error: "unsafe conflict detail" },
				});
			}
			detail = {
				...detail,
				additionalContributions: detail.additionalContributions.map(
					(item: any) =>
						item.id === "candidate-1"
							? {
								...item,
								latestDecision: {
									id: "decision-1",
									candidateId: item.id,
									runId,
									sequence: 1,
									decision: "RECOGNIZED",
									reason: String(
										capturedDecision.body?.reason,
									),
									actor: "organizer",
									createdAt: "2026-01-03T01:00:00.000Z",
								},
							}
							: item,
				),
			};
			return r.fulfill({ json: { decision: "RECOGNIZED" } });
		},
	);

	await page.goto("/review.html?organization=1&evaluation=" + runId);
	await expect(
		page.getByText(
			"Contribution records and decisions do not change evaluation results automatically.",
		),
	).toBeVisible();
	await expect(page.getByLabel("Category")).toHaveValue("testing");
	await expect(page.getByLabel("src/one.ts")).toBeVisible();
	await expect(page.getByLabel(/evidence-1 · PASS/)).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "verified-criterion", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "unknown-criterion", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("checkbox", { name: "mandatory-pass", exact: true }),
	).toHaveCount(0);
	await expect(page.getByLabel("Title")).toHaveAttribute("maxlength", "120");
	await expect(page.getByLabel("Description")).toHaveAttribute(
		"minlength",
		"20",
	);
	await expect(
		page.getByText(
			"Optional criterion checks (passing checks do not alone prove baseline improvement)",
		),
	).toBeVisible();
	await expect(
		page
			.locator('[data-contribution-id="candidate-1"]')
			.getByRole("button", { name: "Recognize criterion improvement" }),
	).toBeEnabled();
	await expect(
		page.getByText(
			"Configured criterion improvement verified; claimed design and file attribution require organizer review.",
		),
	).toBeVisible();
	await expect(
		page
			.locator('[data-contribution-id="unknown-candidate"]')
			.getByRole("button", { name: "Recognize criterion improvement" }),
	).toBeDisabled();
	await page.getByLabel("Title").fill("Tested edge case");
	await page
		.getByLabel("Description")
		.fill("Added verified regression coverage.");
	await page.getByLabel("src/one.ts").check();
	await page.getByLabel(/evidence-1 · PASS/).check();
	await page
		.getByRole("checkbox", { name: "verified-criterion", exact: true })
		.check();
	await page.getByRole("button", { name: "Add contribution" }).click();
	await expect(page.getByText("Tested edge case")).toBeVisible();
	expect(contributionBody).toEqual({
		category: "testing",
		title: "Tested edge case",
		description: "Added verified regression coverage.",
		paths: ["src/one.ts"],
		evidenceIds: ["evidence-1"],
		criterionIds: ["verified-criterion"],
	});
	let candidate = page.locator('[data-contribution-id="candidate-1"]');
	await candidate
		.getByLabel("Decision reason")
		.fill("Recognize the verified contribution with this evidence.");
	await candidate
		.getByRole("button", { name: "Recognize criterion improvement" })
		.click();
	await expect(
		page.getByText(
			"Decision state or eligibility changed; refreshing contribution records.",
		),
	).toBeVisible();
	await expect(page.getByText("unsafe conflict detail")).toHaveCount(0);
	expect(detailRequests).toBe(3);
	decisionStatus = 200;
	candidate = page.locator('[data-contribution-id="candidate-1"]');
	await candidate
		.getByLabel("Decision reason")
		.fill("Recognize the verified contribution with this evidence.");
	await candidate
		.getByRole("button", { name: "Recognize criterion improvement" })
		.click();
	await expect(
		page.getByText("Latest decision RECOGNIZED · sequence 1"),
	).toBeVisible();
	expect(capturedDecision.body).toMatchObject({
		decision: "RECOGNIZED",
		reason: "Recognize the verified contribution with this evidence.",
		expectedPreviousSequence: null,
	});
	expect(capturedDecision.body?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
});

test("organizer artifact recapture reports 409 and 503 safely", async ({page,}) => {
	const runId = "capture-error-run";
	let responseStatus = 409;
	let artifactExpiry = Date.now() + 60_000;
	let retryRequests = 0;
	await page.route("**/api/organization/status", (r) =>
		r.fulfill({
			json: {
				organization: "Fixture",
				authenticated: true,
				role: "organizer",
				app: { slug: "fixture", installationId: 1 },
			},
		}));
	await page.route(
		"**/api/organization/repositories",
		(r) => r.fulfill({ json: { repositories: [] } }),
	);
	await page.route(
		"**/api/organization/overview",
		(r) =>
			r.fulfill({
				json: { counts: { active: 0, attention: 0 }, runs: [] },
			}),
	);
	await page.route(
		"**/api/organization/manage/**",
		(r) => r.fulfill({ json: { counts: {} } }),
	);
	await page.route(
		"**/api/organization/evaluations/" + runId,
		(r) =>
			r.fulfill({
				json: {
					...demoDetail,
					id: runId,
					state: "COMPLETED",
					contract_snapshot: JSON.stringify(demoContract),
					artifacts: [
						{
							key: "capture-key",
							kind: "stdout",
							status: "PENDING",
							expires_at: artifactExpiry,
						},
					],
				},
			}),
	);
	await page.route(
		"**/api/organization/evaluations/" + runId + "/artifacts/retry",
		(r) => {
			retryRequests += 1;
			return r.fulfill({
				status: responseStatus,
				json: { error: "unsafe backend detail must not be shown" },
			});
		},
	);
	await page.goto("/review.html?organization=1&evaluation=" + runId);
	await page.getByRole("button", { name: "Retry artifact capture" }).click();
	await expect(
		page.getByText(
			"Artifact capture retry is only available for terminal evaluations.",
		),
	).toBeVisible();
	responseStatus = 503;
	await page.reload();
	await page.getByRole("button", { name: "Retry artifact capture" }).click();
	await expect(
		page.getByText(
			"Artifact storage is unavailable. Existing evidence metadata is unchanged.",
		),
	).toBeVisible();
	await expect(
		page.getByText("unsafe backend detail must not be shown"),
	).toHaveCount(0);
	artifactExpiry = 1;
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Retry artifact capture" }),
	).toHaveCount(0);
	expect(retryRequests).toBe(2);
});

test("read-only judges retain navigation and filters while administrative controls are disabled", async ({page,}) => {
	await page.route("**/api/organization/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		const json = path.endsWith("/status")
			? {
				authenticated: true,
				role: "judge",
				organization: "Fixture",
				app: { slug: "fixture", installationId: 1 },
			}
			: path.endsWith("/settings")
			? {
				settings: {
					name: "Fixture",
					status: "ACTIVE",
					policy: {},
					taxonomy: [],
				},
				capabilities: { events: [] },
			}
			: path.endsWith("/overview")
			? { counts: { teams: 0, notSubmitted: 0 }, runs: [] }
			: path.endsWith("/repositories")
			? { repositories: [] }
			: { teams: [], submissions: [], issues: [] };
		return route.fulfill({ json });
	});
	await page.goto("/review.html?organization=1");
	await expect(
		page.getByText("JUDGE · READ ONLY", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Sync installed repositories" }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Test Docker runner" }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Teams", exact: true }),
	).toBeEnabled();
	await page.getByRole("button", { name: "Submissions", exact: true })
		.click();
	await expect(page.locator("#workflow-search")).toBeEnabled();
	await page
		.getByRole("button", { name: "Needs attention", exact: true })
		.click();
	await expect(page.getByLabel("Attention filter")).toHaveValue("1");
	await page
		.getByRole("button", { name: "Failed evaluations", exact: true })
		.click();
	await expect(page.locator('[data-query="evaluationState"]')).toHaveValue(
		"FAILED",
	);
	await page
		.getByRole("button", { name: "Missing team mapping", exact: true })
		.click();
	await expect(page.locator("#workflow-filter")).toHaveValue(
		"NEEDS_TEAM_MAPPING",
	);
	await page
		.getByRole("button", { name: "Not submitted", exact: true })
		.click();
	await expect(page.locator("#workflow-filter")).toHaveValue("NOT_SUBMITTED");
	await page.getByRole("button", { name: "Issue triage", exact: true })
		.click();
	await expect(page.locator("#workflow-filter")).toHaveValue("NEEDS_TRIAGE");

	await expect(
		page.getByRole("button", { name: "Lock organization" }),
	).toBeEnabled();
});

test("engineering support matrix separates trusted check facts, server assessments and unverified model prose", async ({page,}) => {
	const { enrichEngineeringReview } = await import(
		"../../src/engineering-review"
	);
	const { deterministicReport } = await import("../../src/evaluate");
	const contract = structuredClone(demoContract);
	const { paymentRetryPolicy } = await import("../../src/runner-policy");
	contract.execution.runner = {
		...paymentRetryPolicy,
		commands: [{ id: "lint", kind: "lint", argv: ["node", "lint.mjs"] }],
	};
	const evidence: import("../../src/domain").Evidence[] = [
		{
			id: "execution-lint",
			kind: "execution" as const,
			status: "FAIL" as const,
			baselineStatus: "PASS" as const,
			claim: "Configured lint check failed.",
		},
		{
			id: "diff-metadata",
			kind: "diff",
			status: "PASS",
			claim:
				"Exact baseline-to-head comparison: 1 changed file; metadata does not establish functionality.",
		},
		{
			id: "auth-source-context",
			kind: "source",
			path: "src/auth.ts",
			status: "PASS",
			claim:
				"Source retrieved for contextual inspection only; presence is not functional proof.",
		},
	];
	const review = deterministicReport(contract, evidence);
	review.solution_approach.problem_understanding = {
		text:
			"The observable problem is a failed configured lint check; broader correctness requires inspection.",
		evidenceIds: ["execution-lint"],
		verification: "UNVERIFIED",
	};
	review.findings = [
		{
			category: "architecture",
			severity: "high",
			claim: "All architecture is perfect.",
			evidenceIds: ["execution-lint"],
			verification: "inference",
		},
	];
	const report = {
		...review,
		...enrichEngineeringReview(contract, evidence, review),
	};
	await page.route("**/api/organization/status", (r) =>
		r.fulfill({
			json: {
				authenticated: true,
				role: "judge",
				organization: "Fixture",
				app: { slug: "fixture", installationId: 1 },
				runner: { enabled: false },
				ai: { enabled: false },
			},
		}));
	await page.route(
		"**/api/organization/repositories",
		(r) => r.fulfill({ json: { repositories: [] } }),
	);
	await page.route(
		"**/api/organization/overview",
		(r) => r.fulfill({ json: { counts: {}, runs: [] } }),
	);
	await page.route(
		"**/api/organization/manage/**",
		(r) =>
			r.fulfill({
				json: { counts: {}, teams: [], issues: [], submissions: [] },
			}),
	);
	await page.route(
		"**/api/organization/evaluations/matrix-run",
		(r) =>
			r.fulfill({
				json: {
					...demoDetail,
					id: "matrix-run",
					state: "COMPLETED",
					contract_snapshot: JSON.stringify(contract),
					evidence: JSON.stringify(evidence),
					report: JSON.stringify(report),
					ai_status: "COMPLETED",
					requirementResults: [],
				},
			}),
	);
	await page.goto("/review.html?organization=1&evaluation=matrix-run");
	const quality = page
		.locator(".engineering-dimension")
		.filter({ has: page.locator("strong").filter({ hasText: "QUALITY" }) });
	await expect(
		quality.getByText("Facts: SUPPORTED_FACT", { exact: false }),
	).toBeVisible();
	await expect(
		quality.getByText(
			"Engineering assessment: SUPPORTED_ENGINEERING_ASSESSMENT",
			{ exact: false },
		),
	).toBeVisible();
	await expect(
		quality.getByText("Human inspection required.", { exact: false }),
	).toBeVisible();
	const architecture = page.locator(".engineering-dimension").filter({
		has: page.locator("strong").filter({ hasText: "ARCHITECTURE" }),
	});
	await expect(
		architecture.getByText("Facts: UNVERIFIED", { exact: false }),
	).toBeVisible();
	await expect(
		architecture.getByText("Model interpretation: UNVERIFIED", {
			exact: false,
		}),
	).toBeVisible();
	await expect(
		architecture.getByText("All architecture is perfect.", {
			exact: false,
		}),
	).toHaveCount(0);
	await page.locator(".engineering-rubric summary").click();
	const observableProblem = page.locator(".engineering-rubric article")
		.filter({
			has: page
				.locator("strong")
				.filter({ hasText: "25.01 · Observable problem" }),
		});
	await expect(
		observableProblem.getByText("CONTEXTUAL_ANALYSIS_AVAILABLE", {
			exact: false,
		}),
	).toBeVisible();
	await expect(
		observableProblem.getByText("solution_approach.problem_understanding", {
			exact: false,
		}),
	).toBeVisible();
	const authentication = page.locator(".engineering-rubric article").filter({
		has: page
			.locator("strong")
			.filter({ hasText: "28.03 · Authentication regression" }),
	});
	await expect(
		authentication.getByText("MISSING_MEANINGFUL_ANALYSIS", {
			exact: false,
		}),
	).toBeVisible();
	await expect(authentication.locator("strong")).toContainText("UNVERIFIED");
	await expect(
		authentication.getByText(
			"No diff available for authentication regression analysis",
			{ exact: false },
		),
	).toBeVisible();
	await expect(
		authentication.getByText("human inspection required", { exact: false }),
	).toBeVisible();
	await expect(
		authentication.getByText("SUPPORTED_FACT", { exact: false }),
	).toHaveCount(0);
	await expect(authentication.locator("a")).toHaveCount(0);
});

test("workspace transition receipt confirms exact organization and safely retries pending removal", async ({page,}) => {
	let state = "ACTIVE";
	let replacement: Record<string, unknown> | null = null;
	let requests = 0;
	await page.route("**/api/organization/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/status")) {
			return route.fulfill({
				json: {
					authenticated: true,
					role: "organizer",
					organization: "Arbitrary-Event-Org",
					app: null,
					retirement: {
						state,
						replacement,
						error: state === "RETIRING"
							? "UNINSTALL_UNAVAILABLE"
							: null,
					},
				},
			});
		}
		if (path.endsWith("/retire")) {
			const body = route.request().postDataJSON();
			expect(body.confirmation).toBe("Arbitrary-Event-Org");
			expect(body.attestation).toBe(true);
			if (replacement) expect(body.replacement).toEqual(replacement);
			replacement = body.replacement;
			requests++;
			state = requests === 1 ? "RETIRING" : "RETIRED";
			return route.fulfill({
				status: state === "RETIRING" ? 202 : 200,
				json: { retirement: { state, replacement } },
			});
		}
		if (path.endsWith("/overview")) {
			return route.fulfill({ json: { counts: {}, runs: [] } });
		}
		return route.fulfill({
			status: 503,
			json: { error: "SYNTHETIC_UNAVAILABLE" },
		});
	});
	await page.goto("/review.html?organization=1");
	await expect(
		page.getByRole("heading", { name: "Arbitrary-Event-Org · GitHub App" }),
	).toBeVisible();
	const submit = page.getByRole("button", { name: "Retire old workspace" });
	await expect(submit).toBeDisabled();
	const record = {
		connection: "VERIFIED",
		organization: "Replacement-Org",
		workspace: "replacement-workspace",
		origin: "https://replacement.example.org",
		targetHash: "a".repeat(64),
		appId: 43,
		installationId: 85,
		reference: "b".repeat(32),
		at: new Date(Date.now() - 1000).toISOString(),
		expiresAt: new Date(Date.now() + 600000).toISOString(),
	};
	await page.getByLabel("Credential-free connection receipt").fill(
		JSON.stringify({
			...record,
			secrets: { token: "do-not-render-this-secret" },
		}),
	);
	await expect(submit).toBeDisabled();
	await expect(page.locator("#replacement-review")).not.toContainText(
		"do-not-render-this-secret",
	);
	await page
		.getByLabel("Credential-free connection receipt")
		.fill(JSON.stringify(record));
	await expect(page.locator("#replacement-review")).toContainText(
		"Replacement-Org · https://replacement.example.org",
	);
	await page
		.getByLabel("Type Arbitrary-Event-Org exactly")
		.fill("arbitrary-event-org");
	await page.getByLabel("I have verified the replacement workspace").check();
	await expect(submit).toBeDisabled();
	await page
		.getByLabel("Type Arbitrary-Event-Org exactly")
		.fill("Arbitrary-Event-Org");
	await expect(submit).toBeEnabled();
	await submit.click();
	await expect(
		page.getByRole("heading", {
			name: "Arbitrary-Event-Org · Retirement pending",
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Register App on GitHub" }),
	).toHaveCount(0);
	await page
		.getByLabel("Type Arbitrary-Event-Org exactly")
		.fill("Arbitrary-Event-Org");
	await page.getByLabel("I have verified the replacement workspace").check();
	await page
		.getByRole("button", { name: "Retry installation removal" })
		.click();
	await expect(
		page.getByRole("heading", {
			name: "Arbitrary-Event-Org · Retired workspace",
		}),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Open replacement Replacement-Org" }),
	).toHaveAttribute("href", "https://replacement.example.org?organization=1");
	await expect(page.locator("#content form")).toHaveCount(0);
	expect(requests).toBe(2);
});

for (const role of ["judge", "participant", "security"]) {
	test(`workspace transition ${role} archive hides active and retirement controls`, async ({page,}) => {
		await page.route("**/api/organization/**", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.endsWith("/status")) {
				return route.fulfill({
					json: {
						authenticated: true,
						role,
						organization: "Archived-Org",
						identity: { name: "Named reviewer" },
						retirement: { state: "RETIRED", archiveReadOnly: true },
					},
				});
			}
			if (path.endsWith("/participant")) {
				return route.fulfill({
					json: {
						team: { name: "Historical team" },
						submissions: [],
						evaluations: [],
					},
				});
			}
			if (path.endsWith("/security-reports")) {
				return route.fulfill({ json: { reports: [] } });
			}
			return route.fulfill({ json: { counts: {}, runs: [] } });
		});
		await page.goto("/review.html?organization=1");
		await expect(
			page.getByRole("heading", {
				name: "Archived-Org · Retired workspace",
			}),
		).toBeVisible();
		await expect(page.locator("#content form")).toHaveCount(0);
		await expect(
			page.getByRole("button", {
				name:
					/Register App|Retire old|Retry installation|Sync installed|Test Docker|Test AI|Submit privately/,
			}),
		).toHaveCount(0);
	});
}

test("workspace transition organizer archive retains historical evidence without retries", async ({page,}) => {
	await page.route("**/api/organization/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/status")) {
			return route.fulfill({
				json: {
					authenticated: true,
					role: "organizer",
					organization: "Archived-Org",
					retirement: { state: "RETIRED", archiveReadOnly: true },
				},
			});
		}
		if (path.includes("/evaluations/")) {
			return route.fulfill({
				json: {
					...demoDetail,
					retryable: true,
					execution: [],
					artifacts: [],
				},
			});
		}
		return route.fulfill({ json: { counts: {}, runs: [] } });
	});
	await page.goto("/review.html?organization=1&evaluation=" + demoRun.id);
	await expect(
		page.getByRole("heading", { name: "Evidence ledger" }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Download reproducibility bundle" }),
	).toBeVisible();
	await expect(page.locator("#content form")).toHaveCount(0);
	await expect(
		page.getByRole("button", {
			name: /Retry|Recognize|Reject|Register App|Sync installed/,
		}),
	).toHaveCount(0);
});

test("workspace transition arbitrary organization registration uses its exact GitHub target", async ({page,}) => {
	const organization = "Arbitrary-Event-Org";
	await page.route("**/api/organization/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/status")) {
			return route.fulfill({
				json: {
					authenticated: true,
					role: "organizer",
					organization,
					app: null,
				},
			});
		}
		if (path.endsWith("/start")) {
			return route.fulfill({
				json: {
					action:
						`https://github.com/organizations/${organization}/settings/apps/new?state=synthetic`,
					manifest: { name: "Synthetic App" },
				},
			});
		}
		return route.fulfill({
			status: 503,
			json: { error: "SYNTHETIC_UNAVAILABLE" },
		});
	});
	await page.route(
		"https://github.com/organizations/**",
		(route) =>
			route.fulfill({
				body: "<p>Synthetic registration boundary</p>",
				contentType: "text/html",
			}),
	);
	await page.goto("/review.html?organization=1");
	await page.getByRole("button", { name: "Register App on GitHub" }).click();
	await expect(page).toHaveURL(
		`https://github.com/organizations/${organization}/settings/apps/new?state=synthetic`,
	);
});
