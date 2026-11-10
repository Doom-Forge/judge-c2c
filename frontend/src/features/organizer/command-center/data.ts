export const organizerCsvHeaders = {
	required: ["team_name", "participant_name"],
	optional: [
		"github_username",
		"team_status",
		"team_lead_email",
		"email",
		"external_id",
		"repository",
		"issue_number",
	],
} as const;

export type OrganizerTeam = {
	readonly id: string;
	readonly name: string;
	readonly status: string;
	readonly submissionCount: number;
	readonly track: string | null;
};

export type OrganizerSubmission = {
	readonly stage: string;
	readonly status: string;
};

export type RoundTwoProgressRecord = {
	readonly document_count: number;
	readonly submission_count: number;
};

export type OrganizerCsvIssue = {
	readonly row: number;
	readonly code: string;
	readonly message: string;
};

export type OrganizerCsvPreview = {
	readonly headers: string[];
	readonly rows: string[][];
	readonly errors: OrganizerCsvIssue[];
	readonly warnings: OrganizerCsvIssue[];
	readonly teams: Array<{
		name: string;
		status: string;
		memberCount: number;
	}>;
};

export function parseOrganizerCsv(text: string): string[][] {
	if (new TextEncoder().encode(text).byteLength > 100_000) {
		throw new Error("CSV exceeds the 100 KB import limit.");
	}
	const rows: string[][] = [];
	let row: string[] = [];
	let value = "";
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index]!;
		if (character === '"') {
			if (quoted && text[index + 1] === '"') {
				value += '"';
				index += 1;
			} else if (!value.trim() || quoted) {
				quoted = !quoted;
			} else {
				throw new Error("INVALID_CSV");
			}
		} else if (character === "," && !quoted) {
			row.push(value.trim());
			value = "";
		} else if ((character === "\n" || character === "\r") && !quoted) {
			if (character === "\r" && text[index + 1] === "\n") index += 1;
			row.push(value.trim());
			if (row.some(Boolean)) rows.push(row);
			row = [];
			value = "";
		} else {
			value += character;
		}
	}
	if (quoted) throw new Error("INVALID_CSV");
	row.push(value.trim());
	if (row.some(Boolean)) rows.push(row);
	return rows;
}

export function validateOrganizerCsv(
	text: string,
	existingTeamNames: readonly string[] = [],
): OrganizerCsvPreview {
	let parsed: string[][];
	try {
		parsed = parseOrganizerCsv(text);
	} catch (error) {
		return {
			headers: [],
			rows: [],
			errors: [
				{
					row: 0,
					code: "invalid_csv",
					message: error instanceof Error
						? error.message
						: "Invalid CSV.",
				},
			],
			warnings: [],
			teams: [],
		};
	}
	const [rawHeaders = [], ...rows] = parsed;
	const headers = rawHeaders.map((header, index) =>
		(index === 0 ? header.replace(/^\uFEFF/, "") : header)
			.toLowerCase()
	);
	const errors: OrganizerCsvIssue[] = [];
	const warnings: OrganizerCsvIssue[] = [];
	for (const header of organizerCsvHeaders.required) {
		if (!headers.includes(header)) {
			errors.push({
				row: 1,
				code: "missing_header",
				message: `Required column "${header}" is missing.`,
			});
		}
	}
	if (new Set(headers).size !== headers.length) {
		errors.push({
			row: 1,
			code: "duplicate_header",
			message: "Column names must be unique.",
		});
	}
	const knownHeaders = new Set<string>([
		...organizerCsvHeaders.required,
		...organizerCsvHeaders.optional,
	]);
	headers.forEach((header) => {
		if (header && !knownHeaders.has(header)) {
			warnings.push({
				row: 1,
				code: "ignored_header",
				message: `The server does not use the "${header}" column.`,
			});
		}
	});
	if (rows.length > 100) {
		errors.push({
			row: 0,
			code: "row_limit",
			message: "The server accepts at most 100 CSV rows.",
		});
	}

	const indexOf = (key: string) => headers.indexOf(key);
	const teamStates = new Map<
		string,
		{ name: string; status: string; leadEmail: string; members: Set<string> }
	>();
	const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	const loginPattern = /^@?[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;
	const loginOwners = new Map<string, number>();
	let rosterMode: "github" | "email" | null = null;
	const statuses = new Set([
		"PENDING",
		"ACTIVE",
		"WITHDRAWN",
		"DISQUALIFIED",
		"COMPLETED",
	]);
	const at = (cells: string[], key: string) => {
		const index = indexOf(key);
		return index < 0 ? "" : (cells[index] ?? "").trim();
	};

	rows.forEach((cells, index) => {
		const rowNumber = index + 2;
		if (cells.length !== headers.length) {
			errors.push({
				row: rowNumber,
				code: "wrong_column_count",
				message:
					`Row ${rowNumber} has ${cells.length} values; expected ${headers.length}.`,
			});
			return;
		}
		const name = at(cells, "team_name");
		const participant = at(cells, "participant_name");
		const login = at(cells, "github_username").replace(/^@/, "");
		const status = at(cells, "team_status") || "PENDING";
		const email = at(cells, "email");
		const leadEmail = at(cells, "team_lead_email");
		const externalId = at(cells, "external_id");
		const repository = at(cells, "repository");
		const issueNumber = at(cells, "issue_number");

		if (!name) {
			errors.push({
				row: rowNumber,
				code: "missing_team_name",
				message: `Row ${rowNumber} needs a team name.`,
			});
		} else if (name.length > 100) {
			errors.push({
				row: rowNumber,
				code: "team_name_too_long",
				message:
					`Row ${rowNumber} has a team name longer than 100 characters.`,
			});
		}
		if (!participant) {
			errors.push({
				row: rowNumber,
				code: "missing_participant_name",
				message: `Row ${rowNumber} needs a participant name.`,
			});
		} else if (participant.length > 100) {
			errors.push({
				row: rowNumber,
				code: "participant_name_too_long",
				message:
					`Row ${rowNumber} has a participant name longer than 100 characters.`,
			});
		}
		if (externalId.length > 100) {
			errors.push({
				row: rowNumber,
				code: "external_id_too_long",
				message:
					`Row ${rowNumber} has an external ID longer than 100 characters.`,
			});
		}
		if (login && !loginPattern.test(at(cells, "github_username"))) {
			errors.push({ row: rowNumber, code: "invalid_github_username", message: `Row ${rowNumber} has an invalid GitHub username.` });
		}
		const rowMode = login ? "github" : "email";
		if (rosterMode && rosterMode !== rowMode) {
			errors.push({ row: rowNumber, code: "mixed_roster_mode", message: "Use GitHub usernames for every row, or use participant and team lead emails for every row." });
		} else rosterMode = rowMode;
		if (login && loginPattern.test(at(cells, "github_username"))) {
			const normalizedLogin = login.toLowerCase();
			const previousRow = loginOwners.get(normalizedLogin);
			if (previousRow !== undefined) {
				errors.push({
					row: rowNumber,
					code: "duplicate_github_username",
					message:
						`GitHub username "${login}" also appears on row ${previousRow}.`,
				});
			} else {
				loginOwners.set(normalizedLogin, rowNumber);
			}
		}
		if (!login) {
			if (!email) errors.push({ row: rowNumber, code: "missing_participant_email", message: `Row ${rowNumber} needs a participant email when GitHub usernames are omitted.` });
			if (!leadEmail) errors.push({ row: rowNumber, code: "missing_team_lead_email", message: `Row ${rowNumber} needs a team lead email when GitHub usernames are omitted.` });
		}
		if (!statuses.has(status)) {
			errors.push({
				row: rowNumber,
				code: "invalid_status",
				message: `Row ${rowNumber} has an unsupported team status.`,
			});
		}
		if (email && !emailPattern.test(email)) {
			errors.push({
				row: rowNumber,
				code: "invalid_email",
				message: `Row ${rowNumber} has an invalid participant email.`,
			});
		} else if (email.length > 200) {
			errors.push({
				row: rowNumber,
				code: "email_too_long",
				message:
					`Row ${rowNumber} has a participant email longer than 200 characters.`,
			});
		}
		if (leadEmail && !emailPattern.test(leadEmail)) {
			errors.push({
				row: rowNumber,
				code: "invalid_lead_email",
				message: `Row ${rowNumber} has an invalid team lead email.`,
			});
		} else if (leadEmail.length > 200) {
			errors.push({
				row: rowNumber,
				code: "lead_email_too_long",
				message:
					`Row ${rowNumber} has a lead email longer than 200 characters.`,
			});
		}
		if ((repository && !issueNumber) || (!repository && issueNumber)) {
			errors.push({
				row: rowNumber,
				code: "incomplete_issue",
				message:
					`Row ${rowNumber} must provide both repository and issue number.`,
			});
		} else if (
			issueNumber &&
			(!/^\d+$/.test(issueNumber) || Number(issueNumber) < 1 ||
				!Number.isSafeInteger(Number(issueNumber)))
		) {
			errors.push({
				row: rowNumber,
				code: "invalid_issue_number",
				message: `Row ${rowNumber} has an invalid issue number.`,
			});
		}

		if (!name) return;
		const normalizedTeam = name.toLocaleLowerCase();
		let team = teamStates.get(normalizedTeam);
		if (!team) {
			team = { name, status, leadEmail, members: new Set() };
			teamStates.set(normalizedTeam, team);
			if (
				existingTeamNames.some((existing) =>
					existing.toLocaleLowerCase() === normalizedTeam
				)
			) {
				errors.push({
					row: rowNumber,
					code: "existing_team",
					message:
						`Team "${name}" already exists; the server will reject this import.`,
				});
			}
		} else {
			if (name !== team.name) {
				errors.push({
					row: rowNumber,
					code: "case_variant_team_name",
					message:
						`Team names "${team.name}" and "${name}" differ only by case; the server rejects duplicate team names.`,
				});
			}
			if (at(cells, "team_status") && status !== team.status) {
				errors.push({
					row: rowNumber,
					code: "conflicting_team_status",
					message: `Team "${name}" has inconsistent status values.`,
				});
			}
			if (
				leadEmail &&
				team.leadEmail &&
				leadEmail.toLocaleLowerCase() !==
					team.leadEmail.toLocaleLowerCase()
			) {
				errors.push({
					row: rowNumber,
					code: "conflicting_team_lead",
					message:
						`Team "${name}" has conflicting lead email values.`,
				});
			}
			if (leadEmail && !team.leadEmail) team.leadEmail = leadEmail;
		}
		const validLogin = Boolean(login && loginPattern.test(at(cells, "github_username")));
		const memberIdentity = validLogin ? `github:${login.toLocaleLowerCase()}` : !login && email ? `email:${email.toLocaleLowerCase()}` : "";
		if (memberIdentity) {
			if (team.members.has(memberIdentity)) {
				errors.push({
					row: rowNumber,
					code: "duplicate_team_member",
					message:
						`Participant identity is repeated for team "${name}".`,
				});
			}
			team.members.add(memberIdentity);
		}
	});

	for (const team of teamStates.values()) {
		if (!team.members.size) continue;
		if (team.members.size > 30) {
			errors.push({
				row: 0,
				code: "member_limit",
				message: `Team "${team.name}" exceeds the 30-member limit.`,
			});
		}
	}
	return {
		headers,
		rows,
		errors,
		warnings,
		teams: [...teamStates.values()].map(({ name, status, members }) => ({
			name,
			status,
			memberCount: members.size,
		})),
	};
}

export function aggregateOrganizerMetrics(
	teams: readonly OrganizerTeam[],
	submissions: readonly OrganizerSubmission[],
	tracks: readonly string[],
) {
	return {
		totalTeams: teams.length,
		activeTeams: teams.filter((team) => team.status === "ACTIVE").length,
		submittedTeams: teams.filter((team) => team.submissionCount > 0).length,
		analysisSubmitted: submissions.filter(
			(submission) =>
				submission.stage === "analysis" &&
				submission.status === "submitted",
		).length,
		engineeringInReview: submissions.filter(
			(submission) =>
				submission.stage === "engineering" &&
				submission.status === "in_review",
		).length,
		trackCounts: tracks.map((track) => ({
			track,
			teams: teams.filter((team) => team.track === track).length,
		})),
	};
}

export function aggregateRoundTwoProgress(
	teams: readonly RoundTwoProgressRecord[],
) {
	return {
		activeTeams: teams.length,
		analysisSubmittedTeams: teams.filter(
			(team) => team.document_count > 0,
		).length,
		engineeringSubmittedTeams: teams.filter(
			(team) => team.submission_count > 0,
		).length,
	};
}
