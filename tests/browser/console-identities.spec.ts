import { expect, test } from "@playwright/test";

test("participant console renders only scoped outcomes and escapes named identity", async ({page,}) => {
	const id = "a".repeat(64),
		unexpected: string[] = [];
	await page.route("**/api/organization/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/organization/status") {
			return route.fulfill({
				json: {
					organization: "Fixture",
					authenticated: true,
					role: "participant",
					identity: {
						id: "person-a",
						name: 'Alice <img src=x onerror="window.hostile=1">',
						role: "participant",
						teamId: "team-a",
					},
				},
			});
		}
		if (path === "/api/organization/participant") {
			return route.fulfill({
				json: {
					team: { id: "team-a", name: "Team A" },
					submissions: [
						{
							repository_id: 1,
							pr_number: 10,
							head_sha: "b".repeat(40),
							status: "VALID",
							full_name: "fixture/own",
						},
					],
					evaluations: [
						{
							id,
							pr_number: 10,
							head_sha: "b".repeat(40),
							state: "COMPLETED",
						},
					],
				},
			});
		}
		if (path === "/api/organization/participant/documents") {
			return route.fulfill({ json: { documents: [], deadlines: null } });
		}
		if (path === "/api/organization/participant/evaluations/" + id) {
			return route.fulfill({
				json: {
					evaluation: { prNumber: 10, state: "COMPLETED" },
					requirements: [
						{
							requirementId: "functional-requirement",
							status: "UNVERIFIED",
							criteria: [
								{
									criterionId: "trusted-test",
									status: "UNVERIFIED",
									reason: "No trusted execution evidence.",
								},
							],
						},
					],
				},
			});
		}
		unexpected.push(path);
		return route.fulfill({
			status: 403,
			json: { error: "PARTICIPANT_SCOPE_REQUIRED" },
		});
	});
	await page.goto("/review.html?organization=1");
	await expect(
		page.getByRole("heading", { name: "Team A", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText(
			'Alice <img src=x onerror="window.hostile=1"> · Team console',
			{ exact: true },
		),
	).toBeVisible();
	await page.locator("[data-participant-evaluation]").click();
	await expect(
		page.getByText("functional-requirement · UNVERIFIED", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Activate challenge and evaluate PR",
		}),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Create named access" }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Retry artifact capture" }),
	).toHaveCount(0);
	await expect(page.locator("img")).toHaveCount(0);
	expect(await page.evaluate(() => (window as any).hostile)).toBeUndefined();
	expect(unexpected).toEqual([]);
});

test("organizer issues a one-time named participant credential and revokes it through the console", async ({page,}) => {
	let issued = false,
		revoked = false;
	const credential = "d".repeat(64);
	const mutations: Record<string, unknown>[] = [];
	await page.route("**/api/organization/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/organization/status") {
			return route.fulfill({
				json: {
					organization: "Fixture",
					authenticated: true,
					role: "organizer",
					identity: {
						id: "named-organizer",
						name: "Named organizer",
						role: "organizer",
						teamId: null,
					},
					app: { slug: "fixture", installationId: 1 },
				},
			});
		}
		if (path === "/api/organization/security-reports") {
			return route.fulfill({
				status: 503,
				json: { error: "SECURITY_REPORT_UNAVAILABLE" },
			});
		}
		if (path === "/api/organization/identities") {
			if (route.request().method() === "POST") {
				mutations.push(route.request().postDataJSON());
				issued = true;
				return route.fulfill({
					status: 201,
					json: {
						id: "person-a",
						name: "Named participant",
						role: "participant",
						teamId: "team-a",
						credential,
					},
				});
			}
			return route.fulfill({
				json: {
					identities: issued
						? [
							{
								id: "person-a",
								name: "Named participant",
								role: "participant",
								team_id: "team-a",
								revoked_at: revoked
									? "2026-10-04T00:00:00Z"
									: null,
							},
						]
						: [],
				},
			});
		}
		if (path === "/api/organization/identities/person-a/revoke") {
			revoked = true;
			return route.fulfill({ json: { id: "person-a", revoked: true } });
		}
		if (path === "/api/organization/repositories") {
			return route.fulfill({ json: { repositories: [] } });
		}
		if (path === "/api/organization/overview") {
			return route.fulfill({
				json: { counts: { active: 0, attention: 0 }, runs: [] },
			});
		}
		return route.fulfill({
			status: 503,
			json: { error: "FIXTURE_OPTIONAL_SERVICE_UNAVAILABLE" },
		});
	});
	await page.goto("/review.html?organization=1");
	await expect(
		page.getByRole("heading", { name: "Named console access" }),
	).toBeVisible();
	await expect(
		page.getByText(/Restricted report intake unavailable/),
	).toBeVisible();
	await page
		.locator('#identity-create [name="name"]')
		.fill("Named participant");
	await page.locator('#identity-create [name="teamId"]').fill("team-a");
	await page.getByRole("button", { name: "Create named access" }).click();
	await expect(page.getByLabel("One-time console credential")).toHaveValue(
		credential,
	);
	expect(mutations).toEqual([
		{ name: "Named participant", role: "participant", teamId: "team-a" },
	]);
	await page.getByRole("button", { name: "Revoke Named participant" })
		.click();
	await expect(
		page.getByText(
			"Credential revoked. Its active sessions have been removed.",
		),
	).toBeVisible();
	await expect(page.getByLabel("One-time console credential")).toHaveCount(0);
});
