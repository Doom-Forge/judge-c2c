import { expect, test } from "@playwright/test";

test("authenticated judge sees assigned and empty teams and filters the queue", async ({ page }) => {
	const requested: string[] = [];
	await page.route("**/api/organization/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		requested.push(path);
		if (path === "/api/organization/status") {
			return route.fulfill({
				json: {
					organization: "Fixture",
					authenticated: true,
					role: "judge",
					identity: { id: "judge-a", name: "Judge A", role: "judge" },
				},
			});
		}
		if (path === "/api/organization/round-two/assignments") {
			return route.fulfill({
				json: {
					assignments: [{ team_id: "team-a", revoked_at: null }, {
						team_id: "team-empty",
						revoked_at: null,
					}],
				},
			});
		}
		if (path === "/api/organization/round-two/teams") {
			return route.fulfill({
				json: {
					teams: [{ id: "team-a", name: "Alpha" }, {
						id: "team-empty",
						name: "Empty",
					}, { id: "unassigned", name: "Hidden" }],
				},
			});
		}
		if (path === "/api/organization/round-two/teams/team-a") {
			return route.fulfill({
				json: {
					repositories: [{ full_name: "fixture/alpha" }],
					submissions: [],
					matrixSubmissions: [{
						full_name: "fixture/alpha",
						pr_number: 17,
						mapping_status: "MAPPED",
					}],
				},
			});
		}
		if (path === "/api/organization/round-two/teams/team-empty") {
			return route.fulfill({
				json: {
					repositories: [],
					submissions: [],
					matrixSubmissions: [],
				},
			});
		}
		return route.fulfill({
			status: 403,
			json: { error: "UNEXPECTED_ROUTE" },
		});
	});
	await page.goto("/review.html?organization=1");
	await expect(page.getByRole("heading", { name: "Assigned teams" }))
		.toBeVisible();
	await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
	await expect(page.getByText("fixture/alpha · PR #17 · mapping MAPPED"))
		.toBeVisible();
	await expect(page.getByRole("heading", { name: "Empty" })).toBeVisible();
	await expect(page.getByText("No pull requests submitted.")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Hidden" })).toHaveCount(0);
	await page.getByLabel("Search teams, repositories, or pull requests").fill(
		"17",
	);
	await expect(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Empty" })).toHaveCount(0);
	await page.getByLabel("Search teams, repositories, or pull requests").fill(
		"",
	);
	await page.getByLabel("Mapping status").selectOption("no-pr");
	await expect(page.getByRole("heading", { name: "Empty" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Alpha" })).toHaveCount(0);
	expect(requested).toContain("/api/organization/round-two/assignments");
	expect(requested).toContain("/api/organization/round-two/teams");
	expect(requested).toContain("/api/organization/round-two/teams/team-a");
	expect(requested).not.toContain("/api/organization/overview");
});
