import ky from "ky";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ArrowDownToLine,
	Check,
	LockKeyhole,
	RefreshCw,
	ShieldCheck,
	UnlockKeyhole,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import "./results.css";
import {
	calculateDisplayedFinalScore,
	displayedStageScore,
	type ResultTransition,
	transitionConfirmation,
} from "./score-display";

export type TeamResult = {
	teamId: string;
	teamName: string;
	track: string | null;
	repositorySelection: string;
	analysisAverage: number | null;
	analysisJudgeCount: number;
	engineeringAverage: number | null;
	engineeringJudgeCount: number;
	status: "READY" | "PENDING";
	finalScore: number | null;
	rank?: number;
};
type Snapshot = {
	id: string;
	snapshot: {
		teams: number;
		completed: number;
		pending: number;
		results: TeamResult[];
		ranking: TeamResult[];
	};
	createdBy: string;
	createdAt: string;
};
export type ResultsPayload = {
	teams: number;
	completed: number;
	pending: number;
	results: TeamResult[];
	ranking?: TeamResult[];
	frozen: boolean;
	freeze: { snapshotId: string; frozenBy: string; frozenAt: string } | null;
	publication: {
		snapshotId: string;
		published: boolean;
		publishedAt: string | null;
	} | null;
};
type ConfirmationAction = ResultTransition | null;

const organizerApi = ky.create({
	prefixUrl: "/api/organization/round-two/results",
	credentials: "same-origin",
	retry: 0,
	timeout: 10_000,
	headers: { accept: "application/json" },
});

function errorMessage(error: unknown): string {
	return error instanceof ApiError
		? `${error.code ?? "Request failed"} (${error.status})`
		: error instanceof Error
		? error.message
		: "The results service returned an unknown error.";
}

function useOrganizerResults() {
	const [data, setData] = useState<ResultsPayload | null>(null);
	const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [results, snapshotList] = await Promise.all([
				organizerApi.get("").json<ResultsPayload>(),
				organizerApi.get("snapshots").json<{ snapshots: Snapshot[] }>(),
			]);
			setData(results);
			setSnapshots(snapshotList.snapshots);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	return { data, snapshots, setSnapshots, loading, error, refresh };
}

function formatScore(score: number | null) {
	return displayedStageScore(score);
}

export function OrganizerResults() {
	const { data, snapshots, setSnapshots, loading, error, refresh } =
		useOrganizerResults();
	const [track, setTrack] = useState("All tracks");
	const [action, setAction] = useState<ConfirmationAction>(null);
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const tracks = useMemo(
		() =>
			[
				...new Set(
					(data?.results ?? []).map((team) => team.track).filter((
						value,
					): value is string => Boolean(value)),
				),
			].sort(),
		[data],
	);
	const rows = useMemo(() => {
		const ranked = data?.ranking?.length
			? data.ranking
			: data?.results ?? [];
		return track === "All tracks"
			? ranked
			: ranked.filter((team) => team.track === track);
	}, [data, track]);
	const isPublished = Boolean(data?.publication?.published);
	const openAction = (next: Exclude<ConfirmationAction, null>) => {
		setAction(next);
		setReason("");
		setActionError(null);
	};
	const confirmAction = async () => {
		if (!action || !transitionConfirmation(action, reason)) return;
		setBusy(true);
		setActionError(null);
		try {
			if (action === "freeze" || action === "unfreeze") {
				await organizerApi("freeze", {
					method: action === "freeze" ? "POST" : "DELETE",
					json: { reason: reason.trim() },
				});
			} else {
				await organizerApi.post("publication", {
					json: {
						snapshotId: action === "publish" ? selectedSnapshot : null,
						reason: reason.trim(),
					},
				});
			}
			await refresh();
			setAction(null);
			setReason("");
		} catch (cause) {
			setActionError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	const [selectedSnapshot, setSelectedSnapshot] = useState("");
	const createSnapshot = async () => {
		setBusy(true);
		setActionError(null);
		try {
			const created = await organizerApi.post("snapshots", {
				json: { reason: "Organizer created a results snapshot" },
			}).json<Snapshot>();
			setSnapshots((current) => [created, ...current]);
			setSelectedSnapshot(created.id);
		} catch (cause) {
			setActionError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	const exportCsv = async () => {
		if (!selectedSnapshot) return;
		try {
			const response = await organizerApi.get(
				`snapshots/${selectedSnapshot}/export`,
			);
			const href = URL.createObjectURL(await response.blob());
			const anchor = document.createElement("a");
			anchor.href = href;
			anchor.download = `round-two-results-${selectedSnapshot}.csv`;
			anchor.click();
			URL.revokeObjectURL(href);
		} catch (cause) {
			setActionError(errorMessage(cause));
		}
	};
	const actionCopy = action
		? {
			freeze: [
				"Freeze current results",
				"This saves an immutable snapshot and locks result changes.",
			],
			unfreeze: [
				"Unfreeze results",
				"This unlocks results for further review.",
			],
			publish: [
				"Publish results",
				"This makes the selected complete snapshot available to participants.",
			],
			unpublish: [
				"Unpublish results",
				"This withdraws the currently published results from participant views.",
			],
		}[action]
		: null;

	return (
		<main className="overview-page organizer-results">
			<div className="page-heading">
				<div>
					<div className="eyebrow">
						<span className="eyebrow-mark" /> FALL 2026{" "}
						<span className="eyebrow-separator">/</span> ROUND 2
					</div>
					<h1>Results &amp; leaderboard</h1>
					<p>
						Review stage scores, preserve a snapshot, and control
						results release.
					</p>
				</div>
				<div className="results-heading-actions">
					<Button
						disabled={loading || busy}
						onClick={() => void refresh()}
						variant="secondary"
					>
						<RefreshCw data-icon="inline-start" />Refresh
					</Button>
					<Button
						disabled={loading || busy}
						onClick={() => void createSnapshot()}
						variant="primary"
					>
						<ShieldCheck data-icon="inline-start" />Create snapshot
					</Button>
				</div>
			</div>
			{loading && (
				<div className="results-state" role="status">
					Loading organizer results…
				</div>
			)}
			{error && (
				<div className="results-state results-state-error" role="alert">
					Results could not be loaded: {error}{" "}
					<Button
						onClick={() =>
							void refresh()}
						size="sm"
						variant="secondary"
					>
						Retry
					</Button>
				</div>
			)}
			{actionError && (
				<div className="results-state results-state-error" role="alert">
					{actionError}
				</div>
			)}
			{data && !loading && (
				<>
					<section
						className="results-summary"
						aria-label="Results status"
					>
						<Card>
							<CardHeader>
								<CardDescription>Teams</CardDescription>
								<CardTitle>{data.teams}</CardTitle>
							</CardHeader>
						</Card>
						<Card>
							<CardHeader>
								<CardDescription>Complete</CardDescription>
								<CardTitle>{data.completed}</CardTitle>
							</CardHeader>
						</Card>
						<Card>
							<CardHeader>
								<CardDescription>Pending</CardDescription>
								<CardTitle>{data.pending}</CardTitle>
							</CardHeader>
						</Card>
						<Card>
							<CardHeader>
								<CardDescription>Release</CardDescription>
								<CardTitle>
									{isPublished ? "Published" : "Private"}
								</CardTitle>
							</CardHeader>
						</Card>
					</section>
					<Card className="results-card">
						<CardHeader className="results-card-header">
							<div>
								<div className="section-title-line">
									<CardTitle>Round 2 standings</CardTitle>
									<Badge
										tone={data.frozen
											? "warning"
											: "neutral"}
									>
										{data.frozen ? "Frozen" : "Live scores"}
									</Badge>
								</div>
								<CardDescription>
									Analysis contributes 10%; pull-request
									evaluation contributes 90%. Incomplete teams
									remain pending.
								</CardDescription>
							</div>
							<label className="results-track-filter">
								Track<select
									aria-label="Filter by track"
									value={track}
									onChange={(event) =>
										setTrack(event.currentTarget.value)}
								>
									<option>All tracks</option>
									{tracks.map((item) => (
										<option key={item}>{item}</option>
									))}
								</select>
							</label>
						</CardHeader>
						<CardContent className="results-table-wrap">
							<table className="results-table">
								<thead>
									<tr>
										<th>RANK</th>
										<th>TEAM</th>
										<th>TRACK</th>
										<th>ANALYSIS · 10%</th>
										<th>PULL REQUEST · 90%</th>
										<th>FINAL SCORE</th>
										<th>STATUS</th>
									</tr>
								</thead>
								<tbody>
									{rows.map((team, index) => {
										const final =
											calculateDisplayedFinalScore(
												team.analysisAverage,
												team.engineeringAverage,
											);
										return (
											<tr key={team.teamId}>
												<td className="results-rank">
													{team.rank ??
														(team.status === "READY"
															? index + 1
															: "—")}
												</td>
												<td>
													<strong>
														{team.teamName}
													</strong>
													<small>
														{team
																.repositorySelection ===
																"CONFLICT"
															? "Repository selection needs attention"
															: team
																	.repositorySelection ===
																	"NOT_SELECTED"
															? "No track selected"
															: `${
																team.analysisJudgeCount +
																team.engineeringJudgeCount
															} submitted stage reviews`}
													</small>
												</td>
												<td>
													{team.track ?? "Unassigned"}
												</td>
												<td>
													{formatScore(
														team.analysisAverage,
													)}
													<small>
														{team
															.analysisJudgeCount}
														{" "}
														judge{team
																.analysisJudgeCount ===
																1
															? ""
															: "s"}
													</small>
												</td>
												<td>
													{formatScore(
														team.engineeringAverage,
													)}
													<small>
														{team
															.engineeringJudgeCount}
														{" "}
														judge{team
																.engineeringJudgeCount ===
																1
															? ""
															: "s"}
													</small>
												</td>
												<td className="results-final">
													{final === null
														? "Pending"
														: final.toFixed(1)}
												</td>
												<td>
													<Badge
														tone={team.status ===
																"READY"
															? "success"
															: "warning"}
													>
														{team.status === "READY"
															? "Complete"
															: "Pending"}
													</Badge>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
							{rows.length === 0 && (
								<div className="results-state">
									No teams are assigned to this track.
								</div>
							)}
						</CardContent>
						<div className="results-weight-note">
							<span>
								<strong>10%</strong> Analysis document
							</span>
							<span>
								<strong>90%</strong> Pull-request review
							</span>
							<span>
								0 is a valid score; “Pending” means no score was
								submitted.
							</span>
						</div>
					</Card>
					<Card className="results-controls">
						<CardHeader>
							<div>
								<CardTitle>Release controls</CardTitle>
								<CardDescription>
									Snapshots are immutable. Every state change
									requires an organizer reason.
								</CardDescription>
							</div>
						</CardHeader>
						<CardContent>
							<div className="results-control-state">
								<span>
									{data.frozen
										? <LockKeyhole />
										: <UnlockKeyhole />} Results{" "}
									{data.frozen ? "frozen" : "unfrozen"}
								</span>
								<span>
									{isPublished
										? "Participant release is on"
										: "Scores remain organizer-only"}
								</span>
							</div>
							<div className="results-control-actions">
								<Button
									disabled={busy || data.frozen}
									onClick={() => openAction("freeze")}
									variant="secondary"
								>
									<LockKeyhole data-icon="inline-start" />Freeze
									results
								</Button>
								<Button
									disabled={busy || !data.frozen}
									onClick={() => openAction("unfreeze")}
									variant="secondary"
								>
									<UnlockKeyhole data-icon="inline-start" />Unfreeze
									results
								</Button>
								<label className="results-snapshot-select">
									Snapshot<select
										aria-label="Select snapshot"
										value={selectedSnapshot ||
											data.publication?.snapshotId || ""}
										onChange={(event) =>
											setSelectedSnapshot(
												event.currentTarget.value,
											)}
									>
										<option value="">
											Choose a snapshot
										</option>
										{snapshots.map((snapshot) => (
											<option
												key={snapshot.id}
												value={snapshot.id}
											>
												{new Date(snapshot.createdAt)
													.toLocaleString()} ·{" "}
												{snapshot.id.slice(0, 8)}
											</option>
										))}
									</select>
								</label>
								<Button
									disabled={busy || !selectedSnapshot ||
										isPublished}
									onClick={() => openAction("publish")}
									variant="primary"
								>
									<Check data-icon="inline-start" />Publish
								</Button>
								<Button
									disabled={busy || !isPublished}
									onClick={() => openAction("unpublish")}
									variant="secondary"
								>
									Unpublish
								</Button>
								<Button
									disabled={!selectedSnapshot || busy}
									onClick={() => void exportCsv()}
									variant="secondary"
								>
									<ArrowDownToLine data-icon="inline-start" />Export
									CSV
								</Button>
							</div>
						</CardContent>
					</Card>
					{action && actionCopy && (
						<div
							className="results-dialog-backdrop"
							role="presentation"
						>
							<section
								aria-labelledby="results-dialog-title"
								aria-modal="true"
								className="results-dialog"
								role="dialog"
							>
								<h2 id="results-dialog-title">
									{actionCopy[0]}
								</h2>
								<p>{actionCopy[1]}</p>
								<label htmlFor="results-action-reason">
									Reason
								</label>
								<textarea
									autoFocus
									id="results-action-reason"
									maxLength={1000}
									minLength={10}
									onChange={(event) =>
										setReason(event.currentTarget.value)}
									placeholder="At least 10 characters"
									value={reason}
								/>
								{actionError && (
									<p
										className="results-dialog-error"
										role="alert"
									>
										{actionError}
									</p>
								)}
								<div>
									<Button
										disabled={busy ||
											!transitionConfirmation(
												action,
												reason,
											)}
										onClick={() => void confirmAction()}
										variant="primary"
									>
										{busy ? "Saving…" : "Confirm"}
									</Button>
									<Button
										disabled={busy}
										onClick={() => setAction(null)}
										variant="secondary"
									>
										Cancel
									</Button>
								</div>
							</section>
						</div>
					)}
				</>
			)}
		</main>
	);
}
