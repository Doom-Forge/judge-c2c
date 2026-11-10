import {
	AlertTriangle,
	ArrowDownToLine,
	ArrowUpRight,
	Check,
	CircleHelp,
	FileUp,
	LoaderCircle,
	Search,
	ShieldCheck,
	Users,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { Session } from "@/types/session";
import {
	type CompetitionCounts,
	type DeadlineSettings,
	getCompetitionOverview,
	getDeadlines,
	getJudgeAssignments,
	getRoundTwoTeams,
	getTeamEmailSettings,
	getTeams,
	importTeams,
	type JudgeAssignment,
	type RoundTwoTeam,
	saveDeadlines,
	saveTeamEmailSettings,
	type TeamRecord,
} from "./command-center/api";
import {
	aggregateOrganizerMetrics,
	aggregateRoundTwoProgress,
	validateOrganizerCsv,
} from "./command-center/data";
import { GitHubConnectionPanel, JudgeAdministrationPanel, OrganizerAnnouncementsPanel, RubricManagementPanel } from "./admin-panels";
import "./command-center/command-center.css";

type LoadState = "loading" | "ready" | "error";
type EmailDraft = { enabled: boolean; subject: string; body: string };
type DeadlineDraft = {
	analysisDocumentDeadline: string;
	pullRequestDeadline: string;
};

type OrganizerCommandCenterProps = {
	readonly session: Session;
	readonly focus?: string | undefined;
};

type DemoTeam = TeamRecord & { readonly track: string; readonly judgeAssignment: "Assigned" | "Unassigned" };

const emptyEmailDraft: EmailDraft = { enabled: false, subject: "", body: "" };
const demoMode = false;
const demoRows: DemoTeam[] = [];
const demoMetrics = { analysisSubmitted: 0, engineeringInReview: 0 };
const emptyDeadlineDraft: DeadlineDraft = {
	analysisDocumentDeadline: "",
	pullRequestDeadline: "",
};
const statusOptions = [
	"ALL",
	"ACTIVE",
	"PENDING",
	"WITHDRAWN",
	"DISQUALIFIED",
	"COMPLETED",
];

function readMetadata(team: TeamRecord): Record<string, unknown> {
	if (typeof team.metadata === "string") {
		try {
			return JSON.parse(team.metadata) as Record<string, unknown>;
		} catch {
			return {};
		}
	}
	return team.metadata ?? {};
}

function teamTrack(team: TeamRecord): string | null {
	const metadata = readMetadata(team);
	const track = metadata["track"];
	return typeof track === "string" && track.trim() ? track.trim() : null;
}

async function loadAllTeams(): Promise<TeamRecord[]> {
	const allTeams: TeamRecord[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await getTeams(cursor);
		allTeams.push(...page.teams);
		cursor = page.nextCursor ?? undefined;
		if (cursor && cursors.has(cursor)) {
			throw new Error("Team list pagination did not advance.");
		}
		if (cursor) cursors.add(cursor);
	} while (cursor);
	return allTeams;
}

function formatStatus(status: string): string {
	return status.toLowerCase().replaceAll("_", " ");
}

function downloadCsv(teams: readonly TeamRecord[]) {
	const quote = (value: unknown) =>
		`"${String(value ?? "").replaceAll('"', '""')}"`;
	const rows = [
		["team", "status", "members", "submissions", "lead email"],
		...teams.map((team) => [
			team.name,
			team.status,
			team.member_count ?? "",
			team.submission_count ?? "",
			team.lead_email ?? "",
		]),
	];
	const blob = new Blob([
		rows.map((row) => row.map(quote).join(",")).join("\r\n"),
	], {
		type: "text/csv;charset=utf-8",
	});
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = "doomforge-organizer-teams.csv";
	anchor.click();
	URL.revokeObjectURL(url);
}

function toDateInput(value: string | null): string {
	if (!value) return "";
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return "";
	return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
		.toISOString()
		.slice(0, 16);
}

function toDeadlineValue(value: string): string | null {
	return value ? new Date(value).toISOString() : null;
}

function csvHeadersTemplate() {
	return "team_name,participant_name,email,team_lead_email,team_status,external_id,repository,issue_number";
}

export function OrganizerCommandCenter({
	session,
	focus,
}: OrganizerCommandCenterProps) {
	const section = focus ?? "overview";
	const liveOrganizer = session.kind === "live" &&
		session.status.role === "organizer";
	const [liveTeams, setLiveTeams] = useState<TeamRecord[]>([]);
	const [overview, setOverview] = useState<CompetitionCounts | null>(null);
	const [roundTwoTeams, setRoundTwoTeams] = useState<RoundTwoTeam[]>([]);
	const [roundTwoLoad, setRoundTwoLoad] = useState<LoadState>(
		liveOrganizer ? "loading" : "ready",
	);
	const [assignments, setAssignments] = useState<JudgeAssignment[]>([]);
	const [assignmentLoad, setAssignmentLoad] = useState<LoadState>(
		liveOrganizer ? "loading" : "ready",
	);
	const [deadlineDraft, setDeadlineDraft] = useState<DeadlineDraft>(
		emptyDeadlineDraft,
	);
	const [deadlineLoad, setDeadlineLoad] = useState<LoadState>(
		liveOrganizer ? "loading" : "ready",
	);
	const [deadlineError, setDeadlineError] = useState("");
	const [savingDeadline, setSavingDeadline] = useState(false);
	const [deadlineSaved, setDeadlineSaved] = useState(false);
	const [teamLoad, setTeamLoad] = useState<LoadState>(
		liveOrganizer ? "loading" : "ready",
	);
	const [loadError, setLoadError] = useState("");
	const [emailLoad, setEmailLoad] = useState<LoadState>(
		liveOrganizer ? "loading" : "ready",
	);
	const [emailError, setEmailError] = useState("");
	const [emailDraft, setEmailDraft] = useState<EmailDraft>(emptyEmailDraft);
	const [senderConfigured, setSenderConfigured] = useState(false);
	const [lastDelivery, setLastDelivery] = useState<
		Record<string, unknown> | null
	>(
		null,
	);
	const [recentDeliveries, setRecentDeliveries] = useState<
		Array<Record<string, unknown>>
	>([]);
	const [savingEmail, setSavingEmail] = useState(false);
	const [emailSaved, setEmailSaved] = useState(false);
	const [query, setQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState("ALL");
	const [csv, setCsv] = useState("");
	const [importState, setImportState] = useState<
		"idle" | "sending" | "done" | "error"
	>("idle");
	const [importMessage, setImportMessage] = useState("");
	const [importError, setImportError] = useState("");

	useEffect(() => {
		if (!liveOrganizer) {
			setTeamLoad("ready");
			setDeadlineLoad("ready");
			setRoundTwoLoad("ready");
			setAssignmentLoad("ready");
			setEmailLoad("ready");
			return;
		}
		let active = true;
		setTeamLoad("loading");
		setDeadlineLoad("loading");
		setRoundTwoLoad("loading");
		setAssignmentLoad("loading");
		setEmailLoad("loading");
		setLoadError("");
		setDeadlineError("");
		setEmailError("");

		void Promise.allSettled([
			loadAllTeams(),
			getCompetitionOverview(),
			getDeadlines(),
			getTeamEmailSettings(),
			getRoundTwoTeams(),
			getJudgeAssignments(),
		]).then(
			([
				teamsResult,
				overviewResult,
				settingsResult,
				emailResult,
				roundTwoResult,
				assignmentsResult,
			]) => {
				if (!active) return;
				if (teamsResult.status === "fulfilled") {
					setLiveTeams(teamsResult.value);
					setTeamLoad("ready");
				} else {
					setTeamLoad("error");
					setLoadError(
						teamsResult.reason instanceof Error
							? teamsResult.reason.message
							: "Team records are unavailable.",
					);
				}
				if (overviewResult.status === "fulfilled") {
					setOverview(overviewResult.value.counts);
				} else if (teamsResult.status === "rejected") {
					setLoadError(
						overviewResult.reason instanceof Error
							? overviewResult.reason.message
							: "Competition metrics are unavailable.",
					);
				}
				if (roundTwoResult.status === "fulfilled") {
					setRoundTwoTeams(roundTwoResult.value.teams);
					setRoundTwoLoad("ready");
				} else {
					setRoundTwoLoad("error");
				}
				if (assignmentsResult.status === "fulfilled") {
					setAssignments(assignmentsResult.value.assignments);
					setAssignmentLoad("ready");
				} else {
					setAssignmentLoad("error");
				}
				if (settingsResult.status === "fulfilled") {
					setDeadlineDraft({
						analysisDocumentDeadline: toDateInput(
							settingsResult.value.analysisDocumentDeadline,
						),
						pullRequestDeadline: toDateInput(
							settingsResult.value.pullRequestDeadline,
						),
					});
					setDeadlineLoad("ready");
				} else {
					setDeadlineLoad("error");
					setDeadlineError(
						settingsResult.reason instanceof Error
							? settingsResult.reason.message
							: "Deadline settings are unavailable.",
					);
				}
				if (emailResult.status === "fulfilled") {
					setEmailDraft({
						enabled: emailResult.value.enabled,
						subject: emailResult.value.subject,
						body: emailResult.value.body,
					});
					setSenderConfigured(
						emailResult.value.senderConfigured === true,
					);
					setLastDelivery(emailResult.value.lastDelivery ?? null);
					setRecentDeliveries(
						emailResult.value.recentDeliveries ?? [],
					);
					setEmailLoad("ready");
				} else {
					setEmailLoad("error");
					setEmailError(
						emailResult.reason instanceof Error
							? emailResult.reason.message
							: "Email settings are unavailable.",
					);
				}
			},
		);
		return () => {
			active = false;
		};
	}, [liveOrganizer]);

	const teams = liveTeams;
	const liveTrackNames = useMemo(
		() =>
			[
				...new Set(
					liveTeams
						.map(teamTrack)
						.filter((track): track is string => Boolean(track)),
				),
			].sort(),
		[liveTeams],
	);
	const liveMetrics = useMemo(
		() =>
			aggregateOrganizerMetrics(
				liveTeams.map((team) => ({
					id: team.id,
					name: team.name,
					status: team.status,
					submissionCount: team.submission_count ?? 0,
					track: teamTrack(team),
				})),
				[],
				liveTrackNames,
			),
		[liveTeams, liveTrackNames],
	);
	const trackRows = useMemo(
		() =>
			liveMetrics.trackCounts.map(({ track, teams: count }) => ({
					track,
					teams: count,
					submitted: liveTeams.filter(
						(team) =>
							teamTrack(team) === track &&
							(team.submission_count ?? 0) > 0,
					).length,
				})),
		[liveMetrics.trackCounts, liveTeams],
	);
	const roundTwoProgress = useMemo(
		() => aggregateRoundTwoProgress(roundTwoTeams),
		[roundTwoTeams],
	);
	const activeJudgeNamesByTeam = useMemo(() => {
		const namesByTeam = new Map<string, string[]>();
		for (const assignment of assignments) {
			if (assignment.revoked_at) continue;
			const names = namesByTeam.get(assignment.team_id) ?? [];
			if (!names.includes(assignment.judge_name)) {
				names.push(assignment.judge_name);
			}
			namesByTeam.set(assignment.team_id, names);
		}
		return namesByTeam;
	}, [assignments]);
	const assignedActiveTeamCount = useMemo(
		() =>
			roundTwoTeams.filter((team) => activeJudgeNamesByTeam.has(team.id))
				.length,
		[activeJudgeNamesByTeam, roundTwoTeams],
	);
	const assignmentsCapped = assignments.length === 500;
	const filteredTeams = useMemo(() => {
		const normalizedQuery = query.trim().toLocaleLowerCase();
		return teams.filter((team) => {
			const matchesQuery = !normalizedQuery ||
				[
					team.name,
					team.id,
					team.lead_email ?? "",
					team.github_members ?? "",
				].some((value) =>
					value.toLocaleLowerCase().includes(normalizedQuery)
				);
			return matchesQuery &&
				(statusFilter === "ALL" || team.status === statusFilter);
		});
	}, [query, statusFilter, teams]);
	const csvPreview = useMemo(
		() => validateOrganizerCsv(csv, teams.map((team) => team.name)),
		[csv, teams],
	);
	const canUseAdminActions = liveOrganizer;
	const metrics = liveMetrics;
	const totalTeams = overview?.teams ?? metrics.totalTeams;
	const activeTeams = overview?.activeTeams ?? metrics.activeTeams;
	const submittedTeams = overview
		? Math.max(0, (overview.teams ?? 0) - (overview.notSubmitted ?? 0))
		: metrics.submittedTeams;
	const teamRows = filteredTeams;

	async function uploadCsvFile(event: ChangeEvent<HTMLInputElement>) {
		const input = event.currentTarget;
		const file = input.files?.[0];
		if (!file) return;
		setImportError("");
		setImportMessage("");
		try {
			setCsv(await file.text());
			setImportState("idle");
		} catch {
			setImportError("The selected CSV file could not be read.");
			setImportState("error");
		}
		input.value = "";
	}

	async function handleImport() {
		if (
			!canUseAdminActions || csvPreview.errors.length ||
			!csvPreview.rows.length ||
			teamLoad !== "ready"
		) return;
		const summary = csvPreview.teams
			.map((team) =>
				`${team.name} (${team.memberCount} members, ${team.status})`
			)
			.join("\n");
		const confirmation =
			`Import ${csvPreview.teams.length} teams from this CSV?\n\n${summary}\n\n` +
			"The authenticated organizer API validates the participant emails, checks repository and issue eligibility, and records an audit event. Participants will add their GitHub username after signing in. Continue?";
		if (!window.confirm(confirmation)) return;

		setImportError("");
		setImportMessage("");
		setImportState("sending");
		let imported: Awaited<ReturnType<typeof importTeams>>;
		try {
			imported = await importTeams(csv);
		} catch (error) {
			setImportError(
				error instanceof Error ? error.message : "The import failed.",
			);
			setImportState("error");
			return;
		}
		setLiveTeams((current) => [
			...imported.teams.map((team) => ({
				...team,
				submission_count: team.submission_count ?? 0,
			})),
			...current,
		]);
		setImportMessage(
			`The server imported ${imported.teams.length} team${
				imported.teams.length === 1 ? "" : "s"
			} and recorded the organizer audit event.`,
		);
		setImportState("done");
		setCsv("");
		const refreshed = await Promise.allSettled([
			loadAllTeams(),
			getCompetitionOverview(),
			getRoundTwoTeams(),
			getJudgeAssignments(),
		]);
		if (refreshed[0]?.status === "fulfilled") {
			setLiveTeams(refreshed[0].value);
			setTeamLoad("ready");
		} else {
			setTeamLoad("error");
			setLoadError("Import succeeded, but the roster refresh failed.");
		}
		if (refreshed[1]?.status === "fulfilled") {
			setOverview(refreshed[1].value.counts);
		}
		if (refreshed[2]?.status === "fulfilled") {
			setRoundTwoTeams(refreshed[2].value.teams);
			setRoundTwoLoad("ready");
		}
		if (refreshed[3]?.status === "fulfilled") {
			setAssignments(refreshed[3].value.assignments);
			setAssignmentLoad("ready");
		}
	}

	async function handleDeadlineSave() {
		if (!canUseAdminActions || savingDeadline) return;
		const draft: DeadlineSettings = {
			analysisDocumentDeadline: toDeadlineValue(
				deadlineDraft.analysisDocumentDeadline,
			),
			pullRequestDeadline: toDeadlineValue(
				deadlineDraft.pullRequestDeadline,
			),
		};
		if (
			!window.confirm(
				`${
					demoMode
						? "Simulate saving"
						: "Save"
				} the two Round 2 deadlines? ${
					demoMode
						? "This changes only the local demo."
						: "This updates the competition deadline fields and writes an organizer audit event."
				}`,
			)
		) return;
		setSavingDeadline(true);
		setDeadlineError("");
		setDeadlineSaved(false);
		try {
			const saved = await saveDeadlines(draft);
			setDeadlineDraft({
				analysisDocumentDeadline: toDateInput(
					saved.analysisDocumentDeadline,
				),
				pullRequestDeadline: toDateInput(saved.pullRequestDeadline),
			});
			setDeadlineSaved(true);
		} catch (error) {
			setDeadlineError(
				error instanceof Error
					? error.message
					: "Deadline settings could not be saved.",
			);
		} finally {
			setSavingDeadline(false);
		}
	}

	async function handleEmailSave() {
		if (!canUseAdminActions || savingEmail) return;
		if (
			!window.confirm(
				`${
					demoMode
						? "Simulate saving"
						: "Save"
				} the team email settings? ${
					emailDraft.enabled
						? "This enables the scheduled team email flow when the sender binding is configured."
						: "The scheduled team email flow will remain paused."
				}`,
			)
		) {
			return;
		}
		setSavingEmail(true);
		setEmailError("");
		setEmailSaved(false);
		try {
			const saved = await saveTeamEmailSettings(emailDraft);
			setEmailDraft(saved);
			setEmailSaved(true);
		} catch (error) {
			setEmailError(
				error instanceof Error
					? error.message
					: "Email settings could not be saved.",
			);
		} finally {
			setSavingEmail(false);
		}
	}

	if (!liveOrganizer) {
		return (
			<main className="occ-page">
				<PageHeading section="overview" />
				<div className="occ-access-state" role="status">
					<ShieldCheck aria-hidden="true" />
					<div>
						<strong>Organizer access required</strong>
						<p>
							Live administration requires an authenticated organizer session.
						</p>
					</div>
				</div>
			</main>
		);
	}

	return (
		<main className="occ-page">
			<PageHeading section={section} />

			{section === "overview" && <section
				className="occ-metric-grid"
				aria-label="Competition metrics"
				id="organizer-overview"
			>
				<MetricCard
					label="Registered teams"
					value={teamLoad === "loading" ? "—" : totalTeams}
					detail="All imported team records"
					icon={<Users aria-hidden="true" />}
				/>
				<MetricCard
					label="Active teams"
					value={teamLoad === "loading" ? "—" : activeTeams}
					detail="Status from team records"
					icon={<Check aria-hidden="true" />}
				/>
				<MetricCard
					label="Teams with submissions"
					value={teamLoad === "loading" ? "—" : submittedTeams}
					detail="At least one recorded submission"
					icon={<ArrowUpRight aria-hidden="true" />}
				/>
				<MetricCard
					label="Judge assignments"
					value={demoMode ? "3 / 4" : assignmentLoad === "loading" ||
							roundTwoLoad === "loading"
						? "—"
						: assignmentLoad === "error" || roundTwoLoad === "error"
						? "Unavailable"
						: `${assignedActiveTeamCount} / ${roundTwoProgress.activeTeams}`}
					detail={demoMode
						? "Simulated assigned active teams"
						: assignmentsCapped
						? "At least this many; list reached its 500-record cap"
						: "Active teams with an active judge assignment"}
					icon={<CircleHelp aria-hidden="true" />}
				/>
			</section>}

			{["overview", "teams"].includes(section) && teamLoad === "loading" && (
				<StateMessage
					kind="loading"
					message="Loading organizer records…"
				/>
			)}
			{["overview", "teams"].includes(section) && teamLoad === "error" && (
				<StateMessage
					kind="error"
					message={loadError || "Team records are unavailable."}
				/>
			)}

			{section === "overview" && <section
				className="occ-dashboard-grid"
				aria-label="Judging operations"
				id="organizer-operations"
			>
				<Card className="occ-panel occ-track-panel">
					<CardHeader>
						<div>
							<CardTitle>Track coverage</CardTitle>
							<CardDescription>
								{demoMode
									? "Four placeholder tracks for interaction preview."
									: liveTrackNames.length
									? `${liveTrackNames.length} track values found in returned team metadata.`
									: "No team track values are present in the returned records."}
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent>
						{demoMode || trackRows.length > 0
							? (
								<div className="occ-track-list">
									{trackRows.map((
										{ track, teams: count, submitted },
									) => (
										<div
											className="occ-track-row"
											key={track}
										>
											<div className="occ-track-label">
												<span>{track}</span>
												<span>{count} teams</span>
											</div>
											<div className="occ-track-bar">
												<span
													style={{
														width: `${
															count
																? (submitted /
																	count) * 100
																: 0
														}%`,
													}}
												/>
											</div>
											<small>
												{submitted} with submissions
												{demoMode ? " · simulated" : ""}
											</small>
										</div>
									))}
									{!demoMode && trackRows.length !== 4 && (
										<p className="occ-small-note">
											The API exposes {trackRows.length}
											{" "}
											distinct team track values; the
											owner brief references four tracks.
										</p>
									)}
								</div>
							)
							: (
								<UnavailableNote>
									The team endpoint has no normalized track
									field and no track values were found in team
									metadata. No live distribution is inferred.
								</UnavailableNote>
							)}
					</CardContent>
				</Card>

				<Card className="occ-panel">
					<CardHeader>
						<div>
							<CardTitle>Judging progress</CardTitle>
							<CardDescription>
								Analysis document and engineering PR review.
							</CardDescription>
						</div>
						<Badge tone={demoMode ? "warning" : "info"}>
							{demoMode ? "SIMULATED" : "SUBMISSION COUNTS"}
						</Badge>
					</CardHeader>
					<CardContent>
						{demoMode
							? (
								<div className="occ-stage-list">
									<StageRow
										label="Analysis document"
										count={demoMetrics.analysisSubmitted}
										total={demoRows.length}
									/>
									<StageRow
										label="Engineering / PR"
										count={demoMetrics.engineeringInReview}
										total={demoRows.length}
									/>
									<p className="occ-small-note">
										Stage values are sample interaction
										data, not live judging outcomes.
									</p>
								</div>
							)
							: (
								roundTwoLoad === "loading"
									? (
										<StateMessage
											kind="loading"
											message="Loading Round 2 submission progress…"
										/>
									)
									: roundTwoLoad === "error"
									? (
										<StateMessage
											kind="error"
											message="Round 2 submission progress is unavailable."
										/>
									)
									: roundTwoProgress.activeTeams === 0
									? (
										<div className="occ-empty-state">
											<Users aria-hidden="true" />
											<strong>
												No active Round 2 teams
											</strong>
											<span>
												Stage progress appears when
												teams are active.
											</span>
										</div>
									)
									: (
										<div className="occ-stage-list">
											<StageRow
												label="Analysis documents submitted"
												count={roundTwoProgress
													.analysisSubmittedTeams}
												total={roundTwoProgress
													.activeTeams}
											/>
											<StageRow
												label="Engineering teams with PRs"
												count={roundTwoProgress
													.engineeringSubmittedTeams}
												total={roundTwoProgress
													.activeTeams}
											/>
											<p className="occ-small-note">
												Counts show active teams with at
												least one stored document or PR
												submission. They do not indicate
												review completion. The API
												returns at most 500 active
												teams.
											</p>
										</div>
									)
							)}
					</CardContent>
				</Card>
			</section>}

			{section === "github" && <GitHubConnectionPanel />}
			{section === "assignments" && <JudgeAdministrationPanel />}
			{section === "rubrics" && <RubricManagementPanel />}

			{section === "teams" && <Card className="occ-panel occ-team-panel" id="organizer-teams">
				<CardHeader className="occ-team-header">
					<div>
						<CardTitle>Teams</CardTitle>
						<CardDescription>
							Search participant handles, lead email, or team;
							filter by current status.
						</CardDescription>
					</div>
					<div className="occ-team-actions">
						<Button
							onClick={() => downloadCsv(teams)}
							variant="secondary"
							disabled={!teams.length}
						>
							<ArrowDownToLine data-icon="inline-start" />
							Export CSV
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					<div className="occ-filter-row">
						<label className="occ-search">
							<Search aria-hidden="true" />
							<span className="sr-only">Search teams</span>
							<input
								onChange={(event) =>
									setQuery(event.currentTarget.value)}
								placeholder="Search team, member, or email"
								value={query}
							/>
						</label>
						<label className="occ-status-filter">
							<span>Status</span>
							<select
								onChange={(event) =>
									setStatusFilter(event.currentTarget.value)}
								value={statusFilter}
							>
								{statusOptions.map((status) => (
									<option key={status} value={status}>
										{status === "ALL"
											? "All statuses"
											: formatStatus(status)}
									</option>
								))}
							</select>
						</label>
						<span className="occ-result-count">
							{teamLoad === "loading"
								? "Loading…"
								: `${filteredTeams.length} shown`}
						</span>
					</div>

					{teamLoad === "ready" && filteredTeams.length === 0
						? (
							<div className="occ-empty-state">
								<Users aria-hidden="true" />
								<strong>
									{teams.length
										? "No matching teams"
										: "No teams imported yet"}
								</strong>
								<span>
									{teams.length
										? "Adjust the search or status filter."
										: "Import a validated organizer CSV to populate the roster."}
								</span>
							</div>
						)
						: (
							<div className="occ-table-wrap">
								<table className="occ-table">
									<caption className="sr-only">
										Organizer team roster and judge
										assignment status
									</caption>
									<thead>
										<tr>
											<th scope="col">Team</th>
											<th scope="col">Members</th>
											<th scope="col">Submissions</th>
											<th scope="col">Track</th>
											<th scope="col">
												Judge assignment
											</th>
											<th scope="col">Status</th>
										<th scope="col">Admin inspection</th>
										</tr>
									</thead>
									<tbody>
										{teamRows.map((team) => {
											const demoTeam = demoMode
												? team as DemoTeam
												: null;
											return (
												<tr key={team.id}>
													<td>
														<strong>
															{team.name}
														</strong>
														<small>
															{team
																.github_members ||
																team.lead_email ||
																team.id}
														</small>
													</td>
													<td>
														{team.member_count ??
															"—"}
													</td>
													<td>
														{team
															.submission_count ??
															"—"}
													</td>
													<td>
														{demoTeam
															? (
																<span className="occ-inline-demo">
																	{demoTeam
																		.track}
																</span>
															)
															: teamTrack(team) ??
																(
																	<span className="occ-muted">
																		Unavailable
																	</span>
																)}
													</td>
													<td>
														{demoTeam
															? (
																<Badge
																	tone={demoTeam
																			.judgeAssignment ===
																			"Assigned"
																		? "success"
																		: "warning"}
																>
																	{demoTeam
																		.judgeAssignment}
																</Badge>
															)
															: assignmentLoad ===
																	"loading"
															? (
																<span className="occ-muted">
																	Loading…
																</span>
															)
															: assignmentLoad ===
																	"error"
															? (
																<span className="occ-muted">
																	Unavailable
																</span>
															)
															: team.status !==
																	"ACTIVE"
															? (
																<span className="occ-muted">
																	—
																</span>
															)
															: activeJudgeNamesByTeam
																	.has(
																		team.id,
																	)
															? (
																<div className="occ-assignment-cell">
																	<Badge tone="success">
																		Assigned
																	</Badge>
																	<small>
																		{activeJudgeNamesByTeam
																			.get(
																				team.id,
																			)
																			?.join(
																				", ",
																			)}
																	</small>
																</div>
															)
															: assignmentsCapped
															? (
																<Badge tone="neutral">
																	Unknown ·
																	500-record
																	cap
																</Badge>
															)
															: (
																<Badge tone="warning">
																	Unassigned
																</Badge>
															)}
													</td>
													<td>
														<StatusBadge
															status={team.status}
														/>
													</td>
												<td>
													<Link className="inline-flex min-h-11 items-center text-sm font-semibold text-[var(--info)] underline-offset-2 hover:underline" to={`/inspect/team/${encodeURIComponent(team.id)}`}>Inspect dashboards</Link>
												</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						)}
					{liveOrganizer && overview && (
						<p className="occ-small-note">
							Server summary: {overview.teams ?? 0} total ·{" "}
							{overview.activeTeams ?? 0} active ·{" "}
							{overview.notSubmitted ?? 0}{" "}
							without submissions. Full team pages loaded using
							the server cursor.
						</p>
					)}
				</CardContent>
			</Card>}

			{["teams", "deadlines", "communications"].includes(section) && <section
				className={`occ-lower-grid ${["teams", "deadlines", "communications"].includes(section) ? "occ-lower-grid-single" : ""}`}
				aria-label="Organizer configuration"
			>
				{section === "teams" && <Card className="occ-panel occ-import-panel" id="organizer-import">
					<CardHeader>
						<div>
							<CardTitle>Import teams</CardTitle>
							<CardDescription>
								Preview the roster before importing participant names and email addresses.
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent>
						<div className="occ-import-actions">
							<label className="occ-file-picker">
								<FileUp aria-hidden="true" />
								<span>Choose CSV</span>
								<input
									accept=".csv,text/csv"
									onChange={uploadCsvFile}
									type="file"
								/>
							</label>
							<Button
					onClick={() => setCsv(csvHeadersTemplate())}
								variant="secondary"
							>
					Insert CSV headers
							</Button>
							<span className="occ-small-note">
								Maximum 100 rows · 100 KB
							</span>
						</div>
						<label
							className="occ-csv-label"
							htmlFor="occ-csv-input"
						>
							Paste or edit CSV
						</label>
						<textarea
							id="occ-csv-input"
							onChange={(event) => {
								setCsv(event.currentTarget.value);
								setImportState("idle");
								setImportMessage("");
							}}
							placeholder="team_name,participant_name,email,team_lead_email,…"
							rows={5}
							value={csv}
						/>
						{csv && (
							<div className="occ-csv-summary" aria-live="polite">
								<strong>
									{csvPreview.teams.length} team groups ·{" "}
									{csvPreview.rows.length} member rows
								</strong>
								<span>
									{csvPreview.errors.length} errors ·{" "}
									{csvPreview.warnings.length} warnings
								</span>
							</div>
						)}
						{csvPreview.errors.length > 0 && (
							<ul
								className="occ-validation-list occ-validation-error"
								aria-label="CSV validation errors"
							>
								{csvPreview.errors.map((issue, index) => (
									<li
										key={`${issue.code}-${issue.row}-${index}`}
									>
										<strong>
											{issue.row
												? `Row ${issue.row}: `
												: ""}
										</strong>
										{issue.message}
									</li>
								))}
							</ul>
						)}
						{csvPreview.warnings.length > 0 && (
							<ul
								className="occ-validation-list occ-validation-warning"
								aria-label="CSV validation warnings"
							>
								{csvPreview.warnings.map((issue, index) => (
									<li
										key={`${issue.code}-${issue.row}-${index}`}
									>
										{issue.message}
									</li>
								))}
							</ul>
						)}
						{csv && csvPreview.errors.length === 0 &&
							csvPreview.teams.length > 0 && (
							<div className="occ-preview-table">
								<span>Import preview</span>
								{csvPreview.teams.map((team) => (
									<div key={team.name}>
										<strong>{team.name}</strong>
										<small>
											{team.memberCount} members ·{" "}
											{team.status}
										</small>
									</div>
								))}
							</div>
						)}
						{importError && (
							<p className="occ-inline-error" role="alert">
								{importError}
							</p>
						)}
						{importMessage && (
							<p className="occ-inline-success" role="status">
								{importMessage}
							</p>
						)}
						<Button
							className="occ-import-submit"
							disabled={!csv ||
								!csvPreview.rows.length ||
								csvPreview.errors.length > 0 ||
								(liveOrganizer && teamLoad !== "ready") ||
								importState === "sending"}
							onClick={() => void handleImport()}
							variant="primary"
						>
							{importState === "sending"
								? (
									<LoaderCircle
										className="occ-spin"
										data-icon="inline-start"
									/>
								)
								: <FileUp data-icon="inline-start" />}
							{importState === "sending"
								? "Importing…"
								: demoMode
								? "Simulate import"
								: "Import teams"}
						</Button>
						<p className="occ-small-note">
							{demoMode
								? "Demo actions change only this local sample view."
								: "Live import uses the authenticated cookie session and is audited. A lead email creates a pending sign-in invitation that the scheduled mailer may deliver."}
						</p>
					</CardContent>
				</Card>}

				{section !== "teams" && <div className="occ-config-stack">
					{section === "deadlines" && <Card className="occ-panel" id="organizer-deadlines">
						<CardHeader>
							<div>
								<CardTitle>Round 2 deadlines</CardTitle>
								<CardDescription>
									The owner brief separates analysis and
									engineering deadlines.
								</CardDescription>
							</div>
						</CardHeader>
						<CardContent>
							{deadlineLoad === "loading"
								? (
									<StateMessage
										kind="loading"
										message="Loading configured deadlines…"
									/>
								)
								: deadlineLoad === "error"
								? (
									<StateMessage
										kind="error"
										message={deadlineError}
									/>
								)
								: (
									<div className="occ-deadline-form">
										<label className="occ-field">
											<span>
												Analysis document deadline
											</span>
											<input
												onChange={(event) =>
													setDeadlineDraft((
														current,
													) => ({
														...current,
														analysisDocumentDeadline:
															event.currentTarget
																.value,
													}))}
												type="datetime-local"
												value={deadlineDraft
													.analysisDocumentDeadline}
											/>
										</label>
										<label className="occ-field">
											<span>
												Engineering / PR deadline
											</span>
											<input
												onChange={(event) =>
													setDeadlineDraft((
														current,
													) => ({
														...current,
														pullRequestDeadline:
															event.currentTarget
																.value,
													}))}
												type="datetime-local"
												value={deadlineDraft
													.pullRequestDeadline}
											/>
										</label>
										<p className="occ-small-note">
											Blank clears a deadline. Times are
											entered in your local timezone and
											stored as UTC.
											{demoMode &&
												" Demo dates are examples only; no server request is made."}
										</p>
										{deadlineError && (
											<p
												className="occ-inline-error"
												role="alert"
											>
												{deadlineError}
											</p>
										)}
										{deadlineSaved && (
											<p
												className="occ-inline-success"
												role="status"
											>
												{demoMode
													? "Demo deadlines saved locally."
													: "Round 2 deadlines saved."}
											</p>
										)}
										<Button
											disabled={savingDeadline}
											onClick={() =>
												void handleDeadlineSave()}
											variant="secondary"
										>
											{savingDeadline
												? "Saving…"
												: demoMode
												? "Simulate save"
												: "Save deadlines"}
										</Button>
									</div>
								)}
						</CardContent>
					</Card>}

					{section === "communications" && <OrganizerAnnouncementsPanel />}
					{section === "communications" && <Card className="occ-panel" id="organizer-communications">
						<CardHeader>
							<div>
								<CardTitle>Email configuration</CardTitle>
								<CardDescription>
									Organizer-only settings for scheduled team
									email.
								</CardDescription>
							</div>
						</CardHeader>
						<CardContent>
							{emailLoad === "loading"
								? (
									<StateMessage
										kind="loading"
										message="Loading email configuration…"
									/>
								)
								: emailLoad === "error"
								? (
									<StateMessage
										kind="error"
										message={emailError}
									/>
								)
								: (
									<>
										<label className="occ-toggle-row">
											<span>
												<strong>
													Enable scheduled team email
												</strong>
												<small>
													{demoMode
														? "Changing this control is simulated."
														: senderConfigured
														? "Sender binding is configured."
														: "Sender binding is not configured; enabling may be rejected by the server."}
												</small>
											</span>
											<input
												checked={emailDraft.enabled}
												onChange={(event) =>
													setEmailDraft((
														current,
													) => ({
														...current,
														enabled:
															event.currentTarget
																.checked,
													}))}
												type="checkbox"
											/>
										</label>
										<label className="occ-field">
											<span>Subject</span>
											<input
												maxLength={200}
												onChange={(event) =>
													setEmailDraft((
														current,
													) => ({
														...current,
														subject:
															event.currentTarget
																.value,
													}))}
												value={emailDraft.subject}
											/>
										</label>
										<label className="occ-field">
											<span>Message body</span>
											<textarea
												maxLength={5000}
												onChange={(event) =>
													setEmailDraft((
														current,
													) => ({
														...current,
														body:
															event.currentTarget
																.value,
													}))}
												rows={4}
												value={emailDraft.body}
											/>
										</label>
										<p className="occ-small-note occ-email-placeholders">
											Allowed placeholders:{" "}
											{"{{team_name}}"},{" "}
											{"{{assigned_track}}"}, and{" "}
											{"{{dashboard_link}}"}.
										</p>
										<div className="occ-delivery-history">
											<div className="occ-delivery-heading">
												<strong>
													Recent delivery activity
												</strong>
												<span>
													{demoMode
														? "Demo"
														: `${recentDeliveries.length} records`}
												</span>
											</div>
											{lastDelivery
												? (
													<div className="occ-delivery-latest">
														<Badge
															tone={lastDelivery[
																	"status"
																] === "sent"
																? "success"
																: "warning"}
														>
															{String(
																lastDelivery[
																	"status"
																] ?? "unknown",
															)}
														</Badge>
														<span>
															Last attempt
															{lastDelivery[
																	"updated_at"
																]
																? ` · ${
																	String(
																		lastDelivery[
																			"updated_at"
																		],
																	)
																}`
																: ""}
														</span>
													</div>
												)
												: (
													<p className="occ-small-note">
														{demoMode
															? "No simulated delivery attempts."
															: "No team email delivery attempts recorded."}
													</p>
												)}
											{recentDeliveries.slice(0, 5).map((
												delivery,
												index,
											) => (
												<div
													className="occ-delivery-row"
													key={`${
														String(
															delivery["hour"] ??
																"delivery",
														)
													}-${index}`}
												>
													<span>
														{String(
															delivery[
																"recipient"
															] ??
																"Recipient unavailable",
														)}
													</span>
													<Badge
														tone={delivery[
																"status"
															] === "sent"
															? "success"
															: "neutral"}
													>
														{String(
															delivery[
																"status"
															] ?? "unknown",
														)}
													</Badge>
												</div>
											))}
										</div>
										{emailError && (
											<p
												className="occ-inline-error"
												role="alert"
											>
												{emailError}
											</p>
										)}
										{emailSaved && (
											<p
												className="occ-inline-success"
												role="status"
											>
												{demoMode
													? "Demo settings saved locally."
													: "Email settings saved."}
											</p>
										)}
										<Button
											disabled={!canUseAdminActions ||
												savingEmail}
											onClick={() =>
												void handleEmailSave()}
											variant="secondary"
										>
											{savingEmail
												? "Saving…"
												: demoMode
												? "Simulate save"
												: "Save email settings"}
										</Button>
										{!demoMode && (
											<p className="occ-small-note">
												Saving is organizer-authorized
												and audited. Delivery history is
												available from the same server
												response; no send-now action is
												exposed here.
											</p>
										)}
									</>
								)}
						</CardContent>
					</Card>}
				</div>}
			</section>}
		</main>
	);
}


const sectionCopy: Record<string, { title: string; description: string; eyebrow: string }> = {
	overview: { title: "Organizer command center", description: "Your live competition operations, review readiness, and team activity.", eyebrow: "DOOMFORGE / ORGANIZER WORKSPACE" },
	teams: { title: "Team roster", description: "Review registered teams or validate and import the participant roster.", eyebrow: "ORGANIZATION / TEAMS" },
	assignments: { title: "Judges & assignments", description: "Create judge access, assign active teams, and manage review coverage.", eyebrow: "ORGANIZATION / REVIEW OPERATIONS" },
	github: { title: "Repository connections", description: "Check the GitHub App installation and synchronize accessible repositories.", eyebrow: "INTEGRATIONS / GITHUB" },
	rubrics: { title: "Evaluation rubrics", description: "Build and publish weighted criteria for each connected repository.", eyebrow: "REVIEW OPERATIONS / RUBRICS" },
	deadlines: { title: "Competition deadlines", description: "Set the analysis document and engineering review cutoffs.", eyebrow: "COMPETITION / SCHEDULE" },
	communications: { title: "Participant communications", description: "Publish announcements and manage scheduled team email.", eyebrow: "COMPETITION / COMMUNICATIONS" },
};

function PageHeading({ section }: { readonly section: string }) {
	const copy = sectionCopy[section] ?? sectionCopy["overview"]!;
	return (
		<header className={`occ-heading ${section === "overview" ? "occ-heading-overview" : ""}`}>
			<div>
				<div className="occ-heading-eyebrow"><span aria-hidden="true" />{section === "overview" ? "DOOMSDAY CONSOLE / ORGANIZER WORKSPACE" : copy.eyebrow}</div>
				<h1>{copy.title}</h1>
				<p>{copy.description}</p>
			</div>
			{section === "overview" && <div className="occ-crest" aria-hidden="true"><span /></div>}
			{section === "overview" && <nav className="occ-quick-actions" aria-label="Organizer shortcuts">
				<Link to="/teams"><span>01</span> Teams <ArrowUpRight aria-hidden="true" /></Link>
				<Link to="/assignments"><span>02</span> Assign judges <ArrowUpRight aria-hidden="true" /></Link>
				<Link to="/deadlines"><span>03</span> Set deadlines <ArrowUpRight aria-hidden="true" /></Link>
			</nav>}
		</header>
	);
}

function MetricCard({
	label,
	value,
	detail,
	icon,
}: {
	readonly label: string;
	readonly value: string | number;
	readonly detail: string;
	readonly icon: React.ReactNode;
}) {
	return (
		<Card className="occ-metric-card">
			<CardContent>
				<div className="occ-metric-top">
					<span>{label}</span>
					<span className="occ-metric-icon">{icon}</span>
				</div>
				<strong>{value}</strong>
				<small>{detail}</small>
			</CardContent>
		</Card>
	);
}

function StageRow({
	label,
	count,
	total,
}: {
	readonly label: string;
	readonly count: number;
	readonly total: number;
}) {
	const percent = total ? Math.min(100, (count / total) * 100) : 0;
	return (
		<div className="occ-stage-row">
			<div>
				<span>{label}</span>
				<strong>{count} / {total}</strong>
			</div>
			<div className="occ-stage-bar">
				<span style={{ width: `${percent}%` }} />
			</div>
		</div>
	);
}

function StatusBadge({ status }: { readonly status: string }) {
	const tone = status === "ACTIVE" || status === "COMPLETED"
		? "success"
		: status === "PENDING"
		? "warning"
		: status === "DISQUALIFIED"
		? "danger"
		: "neutral";
	return <Badge tone={tone}>{formatStatus(status)}</Badge>;
}

function UnavailableNote({ children }: { readonly children: React.ReactNode }) {
	return (
		<div className="occ-unavailable-note">
			<AlertTriangle aria-hidden="true" />
			<p>{children}</p>
		</div>
	);
}

function StateMessage({
	kind,
	message,
}: {
	readonly kind: "loading" | "error";
	readonly message: string;
}) {
	return (
		<div
			className={`occ-state-message occ-state-${kind}`}
			role={kind === "error" ? "alert" : "status"}
		>
			{kind === "loading"
				? <LoaderCircle className="occ-spin" />
				: <AlertTriangle />}
			<span>{message}</span>
		</div>
	);
}
