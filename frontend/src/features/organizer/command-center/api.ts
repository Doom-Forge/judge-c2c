export type TeamRecord = {
	id: string;
	name: string;
	status: string;
	lead_email?: string | null;
	member_count?: number;
	submission_count?: number;
	github_members?: string | null;
	metadata?: Record<string, string> | string;
};

export type CompetitionCounts = {
	teams?: number;
	activeTeams?: number;
	notSubmitted?: number;
};
export type DeadlineSettings = {
	analysisDocumentDeadline: string | null;
	pullRequestDeadline: string | null;
};
export type TeamPage = {
	teams: TeamRecord[];
	nextCursor: string | null;
};
export type RoundTwoTeam = {
	id: string;
	name: string;
	status: string;
	submission_count: number;
	document_count: number;
};
export type JudgeAssignment = {
	id: string;
	judge_identity_id: string;
	judge_name: string;
	team_id: string;
	team_name: string;
	assigned_at: string;
	revoked_at: string | null;
};
export type RepositoryRecord = { id: number; full_name: string; private: boolean; default_branch: string; accessible: boolean };
export type ConsoleIdentity = { id: string; name: string; role: "organizer" | "judge" | "participant"; team_id: string | null; created_at: string; revoked_at: string | null };
export type RubricCriterion = { id: string; label: string; weight: number; description?: string };

async function request<T>(
	path: string,
	init?: RequestInit,
	root = "/manage",
): Promise<T> {
	const response = await fetch(`/api/organization${root}${path}`, {
		...init,
		credentials: "same-origin",
		headers: {
			accept: "application/json",
			...(init?.body ? { "content-type": "application/json" } : {}),
			...init?.headers,
		},
	});
	const payload = (await response.json().catch(() => ({}))) as {
		error?: string;
	} & T;
	if (!response.ok) {
		throw new Error(payload.error ?? `Request failed (${response.status})`);
	}
	return payload;
}

export function getCompetitionOverview() {
	return request<{ counts: CompetitionCounts }>("/overview");
}

export function getDeadlines() {
	return request<DeadlineSettings>("/deadlines");
}

export function saveDeadlines(input: DeadlineSettings) {
	return request<DeadlineSettings>("/deadlines", {
		method: "PUT",
		body: JSON.stringify(input),
	});
}

export function getTeams(cursor?: string) {
	const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
	return request<TeamPage>(`/teams${query}`);
}

export function getRoundTwoTeams() {
	return request<
		{ teams: RoundTwoTeam[]; deadlines: DeadlineSettings | null }
	>(
		"/teams",
		undefined,
		"/round-two",
	);
}

export function getJudgeAssignments() {
	return request<{ assignments: JudgeAssignment[] }>(
		"/assignments",
		undefined,
		"/round-two",
	);
}

export function getTeamEmailSettings() {
	return request<{
		enabled: boolean;
		subject: string;
		body: string;
		senderConfigured?: boolean;
		lastDelivery?: Record<string, unknown> | null;
		recentDeliveries?: Array<Record<string, unknown>>;
	}>("/team-email");
}

export function saveTeamEmailSettings(input: {
	enabled?: boolean;
	subject?: string;
	body?: string;
}) {
	return request<{ enabled: boolean; subject: string; body: string }>(
		"/team-email",
		{ method: "POST", body: JSON.stringify(input) },
	);
}

export async function importTeams(csv: string) {
	return request<{ dryRun: boolean; teams: TeamRecord[] }>("/teams/import", {
		method: "POST",
		body: JSON.stringify({ csv, commit: true }),
	});
}

export function getGitHubStatus() {
	return request<{ app: { id: number; slug: string; installationId: number | null; installUrl: string } | null }>("/status", undefined, "");
}

export function syncRepositories() {
	return request<{ count: number }>("/sync", { method: "POST" }, "");
}

export function getRepositories() {
	return request<{ repositories: RepositoryRecord[] }>("/repositories", undefined, "");
}

export function getIdentities() {
	return request<{ identities: ConsoleIdentity[] }>("/identities", undefined, "");
}

export function createIdentity(input: { name: string; role: "judge" }) {
	return request<ConsoleIdentity & { credential: string }>("/identities", { method: "POST", body: JSON.stringify(input) }, "");
}

export function revokeIdentity(id: string) {
	return request<{ id: string; revoked: boolean }>(`/identities/${encodeURIComponent(id)}/revoke`, { method: "POST" }, "");
}

export function createAssignment(input: { judgeIdentityId: string; teamId: string }) {
	return request<{ assignment: { id: string; judgeIdentityId: string; teamId: string } }>("/assignments", { method: "POST", body: JSON.stringify(input) }, "/round-two");
}

export function revokeAssignment(id: string) {
	return request<{ assignment: { id: string }; revoked: boolean }>(`/assignments/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ reason: "Organizer revoked assignment" }) }, "/round-two");
}

export function getRubric(repositoryId: number) {
	return request<{ repository: RepositoryRecord; active: { id: string; repository_id: number; version: number; criteria: RubricCriterion[] } | null; versions: Array<{ id: string; version: number; criteria: RubricCriterion[]; created_at: string }> }>(`/rubrics?repositoryId=${repositoryId}`, undefined, "/round-two");
}

export function publishRubric(repositoryId: number, criteria: RubricCriterion[]) {
	return request<{ rubric: { id: string; version: number; repositoryId: number; criteria: RubricCriterion[] } }>("/rubrics", { method: "POST", body: JSON.stringify({ repositoryId, criteria }) }, "/round-two");
}
