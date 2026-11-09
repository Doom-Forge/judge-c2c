import { expect, test } from "@playwright/test";

test("round two dashboard explains both judging stages and release policy", async ({ page }) => {
	await page.goto("/");

	await expect(
		page.getByRole("heading", { name: "Judging workspace" }),
	).toBeVisible();
	await expect(
		page
			.locator(".workflow-strip")
			.getByRole("heading", { name: "Analysis document" }),
	).toBeVisible();
	await expect(
		page.locator(".workflow-strip").getByText("10% of final score"),
	).toBeVisible();
	await expect(
		page
			.locator(".workflow-strip")
			.getByRole("heading", { name: "Pull request evaluation" }),
	).toBeVisible();
	await expect(
		page.locator(".workflow-strip").getByText("90% of final score"),
	).toBeVisible();
	await expect(
		page
			.locator(".workflow-release")
			.getByText(
				"Final scores stay pending until at least one judge submits both stages. Organizers control when scores and feedback are released.",
			),
	).toBeVisible();
	await expect(
		page.getByRole("tab", { name: "Team" }),
	).toBeVisible();
	await expect(
		page.getByRole("tab", { name: "Judge" }),
	).toBeVisible();
	await expect(
		page.getByRole("tab", { name: "Organizer" }),
	).toBeVisible();
});

test("team, judge, and organizer tabs show their own workflow", async ({ page }) => {
	await page.goto("/");

	await page.getByRole("tab", { name: "Team" }).click();
	await expect(page.getByRole("heading", { name: "Team dashboard" }))
		.toBeVisible();
	await expect(page.getByText("Choose one of the four supplied repositories"))
		.toBeVisible();

	await page.getByRole("tab", { name: "Judge" }).click();
	await expect(page.getByRole("heading", { name: "Judge workspace" }))
		.toBeVisible();
	await expect(page.getByText("Private review queue")).toBeVisible();

	await page.getByRole("tab", { name: "Organizer" }).click();
	await expect(page.getByRole("heading", { name: "Organizer console" }))
		.toBeVisible();
	await expect(
		page.getByText("Delivery stays paused until configured and enabled."),
	).toBeVisible();
});

test("dashboard theme control switches to the selected color scheme", async ({ page }) => {
	await page.goto("/");
	const original = await page.locator("html").getAttribute("data-theme");
	const next = original === "dark" ? "light" : "dark";
	const nextNext = next === "dark" ? "light" : "dark";
	await page.locator("#theme-toggle").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", next);
	await page.locator("#theme-toggle").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", nextNext);
});

test("analysis file picker enforces the local format and size preview", async ({ page }) => {
	await page.goto("/");
	const file = page.locator("#analysis-file");
	const status = page.locator("#analysis-file-status");

	await file.setInputFiles({
		name: "team-analysis.docx",
		mimeType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		buffer: Buffer.from("document"),
	});
	await expect(status).toContainText("team-analysis.docx");
	await expect(status).toContainText("not uploaded");

	await file.setInputFiles({
		name: "submission.exe",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("not a document"),
	});
	await expect(status).toHaveText("Choose a PDF or DOCX document.");

	await file.setInputFiles({
		name: "oversize.pdf",
		mimeType: "application/pdf",
		buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
	});
	await expect(status).toHaveText("File is larger than the 2 MB limit.");
});

test("judge queue table does not widen the mobile page", async ({ page }) => {
	await page.goto("/");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("tab", { name: "Judge" }).click();

	const widths = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		page: document.documentElement.scrollWidth,
	}));
	expect(widths.page).toBeLessThanOrEqual(widths.viewport);
});

test("all role views reflow at 320 pixels", async ({ page }) => {
	await page.goto("/");
	await page.setViewportSize({ width: 320, height: 800 });

	for (const role of ["Team", "Judge", "Organizer"]) {
		await page.getByRole("tab", { name: role, exact: true }).click();
		const widths = await page.evaluate(() => ({
			viewport: document.documentElement.clientWidth,
			page: document.documentElement.scrollWidth,
			overflowing: [...document.querySelectorAll("body *")]
				.map((element) => {
					const box = element.getBoundingClientRect();
					return {
						tag: element.tagName,
						id: element.id,
						className: String(element.className),
						right: Math.round(box.right),
						width: Math.round(box.width),
						scrollWidth: element.scrollWidth,
						clientWidth: element.clientWidth,
						overflowX: getComputedStyle(element).overflowX,
					};
				})
				.filter((element) => element.right > innerWidth + 1)
				.slice(0, 8),
		}));
		expect(
			widths.page,
			`${role} view overflow: ${JSON.stringify(widths.overflowing)}`,
		).toBeLessThanOrEqual(widths.viewport);
	}
});
