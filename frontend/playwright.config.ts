import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	testMatch: [
		"shell.spec.ts",
		"participant-dashboard.spec.ts",
		"judge-flow.spec.ts",
		"organizer-command-center.spec.ts",
	],
	fullyParallel: true,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5173",
		browserName: "chromium",
		headless: true,
		screenshot: process.env["PLAYWRIGHT_SCREENSHOT"] === "off"
			? "off"
			: "only-on-failure",
	},
	webServer: {
		command: "npm run ui:dev",
		url: "http://127.0.0.1:5173",
		reuseExistingServer: !process.env["CI"],
		timeout: 30_000,
	},
});
