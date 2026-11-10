import { expect, test } from "@playwright/test";

test("authenticated participant sees live options, deadlines, and released results only", async ({ page }) => {
	let resultsUnavailable = true;
	const selectedTrack = { repositoryId: 10, fullName: "Doom-Forge/mazhai-cover" };
	await page.route("**/api/organization/status", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				authenticated: true,
				role: "participant",
				identity: {
					id: "participant-a",
					name: "Team A",
					role: "participant",
					teamId: "team-a",
				},
			}),
		}));
	await page.route("**/api/organization/participant**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/status")) return route.fulfill({ json: { isTeamLead: true, trackSelected: true, githubLinked: true, canEnterDashboard: true } });
		if (path.endsWith("/team-key")) return route.fulfill({ json: { teamKey: "TEAM-KEY-123" } });
		if (path.endsWith("/results")) {
			if (!resultsUnavailable) {
				return route.fulfill({
					json: {
						published: true,
						results: [{ teamId: "team-a", finalScore: 82, status: "READY", track: "Doom-Forge/mazhai-cover", analysisAverage: 84, analysisJudgeCount: 2, engineeringAverage: 80, engineeringJudgeCount: 1, feedback: { analysis: [{ problemUnderstanding: "Strong problem framing.", remediation: "The fix addresses the root cause.", innovationImpact: "Clear impact.", overall: "Well supported by evidence." }], engineering: [{ overall: "Clean implementation.", criteriaScores: [{ criterionId: "tests", comment: "Add edge case coverage." }] }] } }],
						ranking: [{
							teamId: "team-a",
							finalScore: 82,
							rank: 1,
						}],
						sharedStageScores: [{ stage: "ANALYSIS", score: 88, sharedAt: "2026-11-08T12:00:00.000Z" }],
					},
				});
			}
			return route.fulfill({
				status: 503,
				json: { error: "SERVICE_UNAVAILABLE" },
			});
		}
		if (path.endsWith("/track-options")) {
			return route.fulfill({
				json: {
					repositories,
				},
			});
		}
		if (path.endsWith("/documents")) {
			return route.fulfill({
				json: {
					documents: [],
					deadlines: {
						analysisDocumentDeadline: "2026-12-01T12:00:00.000Z",
						pullRequestDeadline: "2026-12-02T12:00:00.000Z",
					},
				},
			});
		}
		return route.fulfill({
			json: {
				team: { id: "team-a", name: "Team A", status: "ACTIVE" },
				track: selectedTrack,
				githubLinked: false,
				currentMember: { displayName: "Participant A", email: "a@example.com", githubLogin: null, githubLinked: false },
				members: [{ displayName: "Participant A", email: "a@example.com", githubLogin: null, githubLinked: false }],
				submissions: [{ repository_id: 10, pr_number: 42, status: "OPEN", github_updated_at: "2026-11-05T12:00:00.000Z", full_name: "Doom-Forge/mazhai-cover" }],
				evaluations: [],
			},
		});
	});
	await page.route("**/api/organization/announcements", route => route.fulfill({ json: { announcements: [{ id: "announcement-1", title: "Round 2 is open", body: "Submit your analysis document by the listed deadline.", createdAt: "2026-11-01T12:00:00.000Z" }] } }));
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Welcome, Team A" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Doom-Forge/mazhai-cover" })).toHaveAttribute("href", "https://github.com/Doom-Forge/mazhai-cover");
	await expect(page.getByRole("button", { name: /Confirm team repository/ })).toHaveCount(0);
	await page.getByRole("button", { name: "Reveal team key" }).click();
	await expect(page.getByText("TEAM-KEY-123")).toBeVisible();
	await page.getByRole("link", { name: "My submission" }).click();
	await expect(page.getByRole("heading", { name: "My submission" })).toBeVisible();
	await expect(page.getByText("12/1/2026", { exact: false })).toBeVisible();
	await expect(page.getByRole("link", { name: /mazhai-cover #42/ })).toHaveAttribute("href", "https://github.com/Doom-Forge/mazhai-cover/pull/42");
	await expect(page.getByRole("heading", { name: "Team members" })).toHaveCount(0);
	await expect(page.getByText("Round 2 is open")).toHaveCount(0);
	await page.getByRole("link", { name: "Evaluation" }).click();
	await expect(page).toHaveURL(/\/evaluation$/);
	await expect(page.getByRole("heading", { name: "Evaluation" })).toBeVisible();
	await expect(page.getByText("Results are temporarily unavailable.")).toBeVisible();
	await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();

	resultsUnavailable = false;
	await page.reload();
	await expect(page.getByRole("heading", { name: "Evaluation" })).toBeVisible();
	await expect(page.getByText(/82\.0.*final score/)).toBeVisible();
	await expect(page.getByText("Well supported by evidence.")).toBeVisible();
	await expect(page.getByText("Add edge case coverage.")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Judge-shared stage scores" })).toBeVisible();
	await expect(page.getByText("Analysis review", { exact: true })).toBeVisible();
	await expect(page.getByText("88", { exact: true })).toBeVisible();
	await expect(page.getByText("Judge A", { exact: true })).toHaveCount(0);
});

const repositories = [
	{ repositoryId: 10, fullName: "Doom-Forge/mazhai-cover" },
	{ repositoryId: 11, fullName: "Doom-Forge/pricingpulse" },
	{ repositoryId: 12, fullName: "Doom-Forge/veera-footwear" },
	{ repositoryId: 13, fullName: "Doom-Forge/janus" },
];

test("team lead must confirm one repository before linking GitHub or entering workspace", async ({ page }) => {
	let selectedTrack: { repositoryId: number; fullName: string } | null = null;
	let documentRequests = 0;
	await page.route("**/api/organization/status", route => route.fulfill({ json: {
		authenticated: true, role: "participant", identity: { id: "lead-a", name: "Team A", role: "participant", teamId: "team-a" },
	} }));
	await page.route("**/api/organization/participant**", route => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/status")) return route.fulfill({ json: { isTeamLead: true, trackSelected: Boolean(selectedTrack), githubLinked: false, canEnterDashboard: false } });
		if (path.endsWith("/track-options")) return route.fulfill({ json: { isTeamLead: true, repositories } });
		if (path.endsWith("/track") && route.request().method() === "POST") {
			const repositoryId = (route.request().postDataJSON() as { repositoryId: number }).repositoryId;
			selectedTrack = repositories.find(repo => repo.repositoryId === repositoryId) ?? null;
			return route.fulfill({ json: { track: selectedTrack } });
		}
		if (path.endsWith("/documents")) { documentRequests += 1; return route.fulfill({ json: { documents: [], deadlines: null } }); }
		return route.fulfill({ json: { team: { id: "team-a", name: "Team A", status: "ACTIVE" }, track: selectedTrack, currentMember: { displayName: "Lead", email: "lead@example.test", githubLogin: null, githubLinked: false }, githubLinked: false } });
	});
	await page.route("**/api/organization/announcements", route => route.fulfill({ json: { announcements: [] } }));
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Set up Team A" })).toBeVisible();
	for (const name of ["Mazhai Cover", "PricingPulse", "Veera Footwear", "JANUS"]) await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
	await expect(page.getByRole("button", { name: "Confirm team repository" })).toBeDisabled();
	await page.getByRole("button", { name: /PricingPulse/ }).focus();
	await page.keyboard.press("Enter");
	await page.getByRole("button", { name: "Confirm team repository" }).click();
	await expect(page.getByRole("heading", { name: "Verify your GitHub account" })).toBeVisible();
	await expect(page.getByLabel("GitHub username")).toBeVisible();
	await expect.poll(() => documentRequests).toBe(0);
});
