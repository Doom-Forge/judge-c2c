import { expect, test } from "@playwright/test";
import {
	aggregateOrganizerMetrics,
	aggregateRoundTwoProgress,
	type OrganizerTeam,
	parseOrganizerCsv,
	validateOrganizerCsv,
} from "../src/features/organizer/command-center/data";

const csvHeaders =
	"team_name,participant_name,github_username,team_status,team_lead_email,email,external_id,repository,issue_number";

test.describe("organizer CSV preview", () => {
	test("parses quoted cells, escaped quotes, and multiline fields", () => {
		expect(
			parseOrganizerCsv(
				`${csvHeaders}\r\n"North, Star","A ""quoted""\nname",north-star,ACTIVE,lead@example.com,member@example.com,id-1,org/repo,12`,
			),
		).toEqual([
			csvHeaders.split(","),
			[
				"North, Star",
				'A "quoted"\nname',
				"north-star",
				"ACTIVE",
				"lead@example.com",
				"member@example.com",
				"id-1",
				"org/repo",
				"12",
			],
		]);
		expect(parseOrganizerCsv(`${csvHeaders}\nTeam,Name,login,,,,,,`)[1])
			.toEqual([
				"Team",
				"Name",
				"login",
				"",
				"",
				"",
				"",
				"",
				"",
			]);
	});

	test("requires the server's canonical participant headers", () => {
		expect(
			validateOrganizerCsv("team_name,team_status\nTeam A,ACTIVE").errors,
		)
			.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "missing_header" }),
				]),
			);
		expect(() => parseOrganizerCsv(`${csvHeaders}\n"Team A,Name,login`))
			.toThrow(
				"INVALID_CSV",
			);
	});

	test("flags malformed rows, repeated identities, inconsistent teams, and invalid contact data", () => {
		const result = validateOrganizerCsv(
			[
				csvHeaders,
				"Team A,Alex,alex,ACTIVE,lead@example.com,alex@example.com,1,org/repo,12",
				"team a,Sam,sam,WITHDRAWN,other@example.com,not-an-email,2,org/repo,invalid",
				"Team C,Casey,casey,ACTIVE,,,,,",
				"Team D,Missing login,bad login,ACTIVE,,,,,",
			].join("\n"),
		);
		expect(result.teams).toEqual([
			{ name: "Team A", status: "ACTIVE", memberCount: 2 },
			{ name: "Team C", status: "ACTIVE", memberCount: 1 },
			{ name: "Team D", status: "ACTIVE", memberCount: 0 },
		]);
		expect(result.errors.map(({ code }) => code)).toEqual(
			expect.arrayContaining([
				"case_variant_team_name",
				"conflicting_team_status",
				"conflicting_team_lead",
				"invalid_email",
				"invalid_issue_number",
				"invalid_github_username",
			]),
		);
	});

	test("blocks an import that collides with an existing team", () => {
		const result = validateOrganizerCsv(
			[csvHeaders, "North Star,Alex,north,ACTIVE,,,,,"].join("\n"),
			["north star"],
		);
		expect(result.errors).toEqual([
			expect.objectContaining({ code: "existing_team" }),
		]);
	});
});

test.describe("aggregateOrganizerMetrics", () => {
	const teams: OrganizerTeam[] = [
		{
			id: "a",
			name: "A",
			status: "ACTIVE",
			submissionCount: 2,
			track: "Track A",
		},
		{
			id: "b",
			name: "B",
			status: "PENDING",
			submissionCount: 0,
			track: "Track B",
		},
		{
			id: "c",
			name: "C",
			status: "WITHDRAWN",
			submissionCount: 1,
			track: "Track A",
		},
	];

	test("counts stage and track fixtures passed by the caller without inventing labels", () => {
		expect(
			aggregateOrganizerMetrics(
				teams,
				[
					{ stage: "analysis", status: "submitted" },
					{ stage: "engineering", status: "in_review" },
					{ stage: "other", status: "submitted" },
				],
				["Track A", "Track B", "Track C", "Track D"],
			),
		).toEqual({
			totalTeams: 3,
			activeTeams: 1,
			submittedTeams: 2,
			analysisSubmitted: 1,
			engineeringInReview: 1,
			trackCounts: [
				{ track: "Track A", teams: 2 },
				{ track: "Track B", teams: 1 },
				{ track: "Track C", teams: 0 },
				{ track: "Track D", teams: 0 },
			],
		});
	});
});

test("counts document and engineering submissions from the Round 2 team contract", () => {
	expect(
		aggregateRoundTwoProgress([
			{ document_count: 1, submission_count: 0 },
			{ document_count: 0, submission_count: 2 },
			{ document_count: 2, submission_count: 3 },
		]),
	).toEqual({
		activeTeams: 3,
		analysisSubmittedTeams: 2,
		engineeringSubmittedTeams: 2,
	});
});

test("live organizer can sync GitHub repositories, provision a judge, publish a rubric and announcement", async ({ page }) => {
	let createdJudge = false;
	let rubricPublished = false;
	let announcements: Array<{ id: string; title: string; body: string; createdAt: string }> = [];
	await page.route("**/api/organization/**", async route => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === "/api/organization/status") return route.fulfill({ json: { authenticated: true, role: "organizer", identity: { id: null, name: "Organizer", role: "organizer", teamId: null }, app: { id: 1, slug: "doomforge", installationId: 7, installUrl: "https://github.com/apps/doomforge/installations/new" } } });
		if (path === "/api/organization/manage/teams") return route.fulfill({ json: { teams: [{ id: "team-1", name: "Team One", status: "ACTIVE", member_count: 1, submission_count: 0, github_members: "member-one" }], nextCursor: null } });
		if (path === "/api/organization/manage/overview") return route.fulfill({ json: { counts: { teams: 1, activeTeams: 1, notSubmitted: 1 } } });
		if (path === "/api/organization/round-two/teams") return route.fulfill({ json: { teams: [{ id: "team-1", name: "Team One", status: "ACTIVE", submission_count: 0, document_count: 0 }], deadlines: null } });
		if (path === "/api/organization/round-two/assignments") return route.fulfill({ json: { assignments: [] } });
		if (path === "/api/organization/manage/deadlines") return route.fulfill({ json: { analysisDocumentDeadline: null, pullRequestDeadline: null } });
		if (path === "/api/organization/manage/team-email") return route.fulfill({ json: { enabled: false, subject: "", body: "", senderConfigured: false, recentDeliveries: [] } });
		if (path === "/api/organization/repositories") return route.fulfill({ json: { repositories: [{ id: 11, full_name: "org/repo", private: true, default_branch: "main", accessible: true }] } });
		if (path === "/api/organization/sync") return route.fulfill({ json: { count: 1 } });
		if (path === "/api/organization/identities" && route.request().method() === "GET") return route.fulfill({ json: { identities: createdJudge ? [{ id: "judge-1", name: "Judge One", role: "judge", team_id: null, created_at: "2026-11-08", revoked_at: null }] : [] } });
		if (path === "/api/organization/identities" && route.request().method() === "POST") { createdJudge = true; return route.fulfill({ status: 201, json: { id: "judge-1", name: "Judge One", role: "judge", teamId: null, credential: "one-time-secret" } }); }
		if (path === "/api/organization/round-two/rubrics" && route.request().method() === "GET") return route.fulfill({ json: { repository: { id: 11, full_name: "org/repo", private: true, default_branch: "main", accessible: true }, active: rubricPublished ? { id: "rubric-1", repository_id: 11, version: 1, criteria: [{ id: "criterion-1", label: "Code quality", weight: 100 }] } : null, versions: [] } });
		if (path === "/api/organization/round-two/rubrics" && route.request().method() === "POST") { rubricPublished = true; return route.fulfill({ status: 201, json: { rubric: { id: "rubric-1", repositoryId: 11, version: 1, criteria: [{ id: "criterion-1", label: "Code quality", weight: 100 }] } } }); }
		if (path === "/api/organization/announcements" && route.request().method() === "GET") return route.fulfill({ json: { announcements } });
		if (path === "/api/organization/announcements" && route.request().method() === "POST") { const body = route.request().postDataJSON() as { title: string; body: string }; announcements = [{ id: "notice-1", ...body, createdAt: "2026-11-08T12:00:00.000Z" }]; return route.fulfill({ status: 201, json: { announcement: announcements[0] } }); }
		return route.fulfill({ status: 404, json: { error: `UNEXPECTED ${path}` } });
	});
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Organizer Command Center" })).toBeVisible();
	await page.getByRole("button", { name: "Sync repositories" }).click();
	await expect(page.getByText("Synced 1 accessible repositories.")).toBeVisible();
	await page.getByLabel("Judge name").fill("Judge One");
	await page.getByRole("button", { name: "Create judge" }).click();
	await expect(page.getByText("one-time-secret")).toBeVisible();
	await page.getByRole("combobox", { name: "Judge" }).selectOption("judge-1");
	await page.getByLabel("Active team").selectOption("team-1");
	await page.getByRole("button", { name: "Assign team" }).click();
	await page.getByLabel("Repository").selectOption("11");
	await page.getByRole("button", { name: "Add criterion" }).click();
	await page.getByLabel("Label", { exact: true }).fill("Code quality");
	await page.getByLabel("Weight", { exact: true }).fill("100");
	await page.getByRole("button", { name: "Publish new rubric version" }).click();
	await expect(page.getByText("Published rubric version 1.")).toBeVisible();
	await page.getByLabel("Title", { exact: true }).fill("Round 2 is open");
	await page.getByLabel("Announcement", { exact: true }).fill("Submit your analysis document.");
	await page.getByRole("button", { name: "Publish announcement" }).click();
	await expect(page.getByText("Round 2 is open")).toBeVisible();
});
