import { expect, test } from "@playwright/test";

test("signed-out users get a real access-code sign-in and no demo entry point", async ({ page }) => {
	await page.route("**/api/organization/status", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ authenticated: false, organization: "Doomforge" }),
		}),
	);
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Sign in to Doomforge" })).toBeVisible();
	await expect(page.locator(".session-login-card")).toHaveCSS("display", "grid");
	await expect(page.getByLabel("Organization access code")).toBeVisible();
	await expect(page.getByText(/demo data|sample records|enter demo/i)).toHaveCount(0);
});

test("mobile judge navigation opens, follows live routes, and closes", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	let authenticated = true;
	await page.route("**/api/organization/status", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(authenticated ? {
				authenticated: true,
				role: "judge",
				identity: { id: "judge-1", name: "Judge One", role: "judge", teamId: null },
			} : { authenticated: false }),
		}),
	);
	await page.route("**/api/organization/logout", async route => {
		authenticated = false;
		return route.fulfill({ json: { ok: true } });
	});
	await page.route("**/api/organization/round-two/teams", (route) =>
		route.fulfill({ json: { teams: [], deadlines: null } }),
	);
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Your review queue" })).toBeVisible();
	await page.getByRole("button", { name: "Open navigation" }).click();
	const navigation = page.getByRole("navigation", { name: "Primary navigation" });
	await expect(navigation.getByRole("link", { name: "My queue" })).toBeVisible();
	await navigation.getByRole("link", { name: "History" }).click();
	await expect(page).toHaveURL(/\/history$/);
	await expect(page.getByRole("heading", { name: "Judge workspace" })).toBeVisible();
	const signOut = page.getByRole("button", { name: "Sign out" });
	await expect(signOut).toBeVisible();
	const bounds = await signOut.boundingBox();
	expect(bounds).not.toBeNull();
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
	await signOut.click();
	await expect(page.getByRole("heading", { name: "Sign in to Doomforge" })).toBeVisible();
});
