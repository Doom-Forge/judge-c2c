import { expect, test } from "@playwright/test";

test("authenticated participant sees live options, deadlines, and released results only", async ({ page }) => {
	let resultsUnavailable = true;
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
		if (path.endsWith("/results")) {
			if (!resultsUnavailable) {
				return route.fulfill({
					json: {
						published: true,
						results: [{ teamId: "team-a", finalScore: 82, status: "READY", track: "180DC-VIT-CHENNAI/mazhai-cover", analysisAverage: 84, analysisJudgeCount: 2, engineeringAverage: 80, engineeringJudgeCount: 1, feedback: { analysis: [{ problemUnderstanding: "Strong problem framing.", remediation: "The fix addresses the root cause.", innovationImpact: "Clear impact.", overall: "Well supported by evidence." }], engineering: [{ overall: "Clean implementation.", criteriaScores: [{ criterionId: "tests", comment: "Add edge case coverage." }] }] } }],
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
					repositories: [{
						repositoryId: 10,
						fullName: "180DC-VIT-CHENNAI/mazhai-cover",
					}],
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
				track: null,
				githubLinked: false,
				currentMember: { displayName: "Participant A", email: "a@example.com", githubLogin: null, githubLinked: false },
				members: [{ displayName: "Participant A", email: "a@example.com", githubLogin: null, githubLinked: false }],
				submissions: [{ repository_id: 10, pr_number: 42, status: "OPEN", github_updated_at: "2026-11-05T12:00:00.000Z", full_name: "180DC-VIT-CHENNAI/mazhai-cover" }],
				evaluations: [],
			},
		});
	});
	await page.route("**/api/organization/announcements", route => route.fulfill({ json: { announcements: [{ id: "announcement-1", title: "Round 2 is open", body: "Submit your analysis document by the listed deadline.", createdAt: "2026-11-01T12:00:00.000Z" }] } }));
	await page.goto("/");
	await page.getByRole("link", { name: "My submission" }).click();

	await expect(page.getByRole("heading", { name: "My submission" })).toBeVisible();
	await expect(page.getByRole("option", {
		name: "180DC-VIT-CHENNAI/mazhai-cover",
	})).toBeAttached();
	await expect(page.getByText("12/1/2026", { exact: false })).toBeVisible();
	await expect(page.getByRole("link", { name: /mazhai-cover #42/ })).toHaveAttribute("href", "https://github.com/180DC-VIT-CHENNAI/mazhai-cover/pull/42");
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
