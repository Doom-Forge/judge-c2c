import { expect, test } from "@playwright/test";

async function signedOut(page: import("@playwright/test").Page) {
	await page.route("**/api/organization/status", route => route.fulfill({ json: { authenticated: false, organization: "Doomforge" } }));
	await page.goto("/");
	await page.getByRole("button", { name: "Participant sign in" }).click();
}

test("participant can request an email code and verify it", async ({ page }) => {
	let requestedEmail = "";
	let requested: { email: string; teamKey?: string } | null = null;
	let verified: { email: string; code: string; teamKey?: string } | null = null;
	await signedOut(page);
	await page.route("**/api/organization/participant/request-code", async route => {
		requested = route.request().postDataJSON() as { email: string; teamKey?: string };
		requestedEmail = requested.email;
		await route.fulfill({ status: 202, json: { sent: true } });
	});
	await page.route("**/api/organization/participant/verify", async route => {
		verified = route.request().postDataJSON() as { email: string; code: string; teamKey?: string };
		await route.fulfill({ json: { authenticated: true } });
	});
	await page.getByLabel("Email on the team roster").fill("alice@example.test");
	await page.getByRole("button", { name: "Email me a sign-in code" }).click();
	await expect(page.getByLabel("Email verification code")).toBeVisible();
	expect(requestedEmail).toBe("alice@example.test");
	await page.getByLabel("Email verification code").fill("ABCDEF234567");
	await page.getByRole("button", { name: "Verify and sign in" }).click();
	await expect.poll(() => verified).toEqual({ email: "alice@example.test", code: "ABCDEF234567" });
	await expect(page.getByRole("button", { name: "Email me a sign-in code" })).toBeVisible();
});

test("participant can enter an invitation code already sent by an organizer", async ({ page }) => {
	let verification: { email: string; code: string } | null = null;
	await signedOut(page);
	await page.route("**/api/organization/participant/request-code", route => route.fulfill({ status: 202, json: { sent: true } }));
	await page.route("**/api/organization/participant/verify", async route => {
		verification = route.request().postDataJSON() as { email: string; code: string };
		await route.fulfill({ json: { authenticated: true } });
	});
	await page.getByLabel("Email on the team roster").fill("alice@example.test");
	await page.getByRole("button", { name: "I already have a code" }).click();
	await page.getByLabel("Email verification code").fill("INVITATION234");
	await page.getByRole("button", { name: "Verify and sign in" }).click();
	await expect.poll(() => verification).toEqual({ email: "alice@example.test", code: "INVITATION234" });
});

test("team member provides the lead key for both OTP steps", async ({ page }) => {
	let requested: unknown;
	let verified: unknown;
	await signedOut(page);
	await page.route("**/api/organization/participant/request-code", async route => {
		requested = route.request().postDataJSON();
		await route.fulfill({ status: 202, json: { sent: true } });
	});
	await page.route("**/api/organization/participant/verify", async route => {
		verified = route.request().postDataJSON();
		await route.fulfill({ json: { authenticated: true } });
	});
	await page.getByLabel("Email on the team roster").fill("member@example.test");
	await page.getByLabel("Team key").fill("TEAM-ACCESS-KEY");
	await page.getByRole("button", { name: "Email me a sign-in code" }).click();
	await expect.poll(() => requested).toEqual({ email: "member@example.test", teamKey: "TEAM-ACCESS-KEY" });
	await page.getByLabel("Email verification code").fill("OTP123456789");
	await page.getByRole("button", { name: "Verify and sign in" }).click();
	await expect.poll(() => verified).toEqual({ email: "member@example.test", code: "OTP123456789", teamKey: "TEAM-ACCESS-KEY" });
});
