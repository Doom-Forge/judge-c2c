import { useCallback, useEffect, useRef, useState } from "react";
import {
	ArrowDownToLine,
	ExternalLink,
	RefreshCw,
	Save,
	Send,
} from "lucide-react";
import {
	calculateEngineeringScore,
	type EngineeringCriterion,
	parseReviewScore,
	preferredReviewSource,
	type ReviewFeedback,
	validateEngineeringCriteria,
	validateReview,
} from "./judge-workspace-helpers";
import "./judge-workspace.css";

type Team = {
	id: string;
	name: string;
	submission_count: number;
	document_count: number;
};
type Document = {
	id: string;
	version: number;
	filename: string;
	content_type: string;
	bytes: number;
	sha256: string;
	status: string;
	created_at: string;
};
type CriterionScore = {
	criterionId: string;
	score: number | null;
	comment: string;
};
type ReviewRecord = {
	id?: string | undefined;
	score: number | null;
	payload: Record<string, unknown>;
	document_id: string | null;
	revision?: number | undefined;
	reason?: string | undefined;
	submitted_at?: string | undefined;
	updated_at?: string | undefined;
	rubric_version_id?: string | null | undefined;
	scoreShared?: boolean | undefined;
	includedInPublishedSnapshot?: boolean | undefined;
};
type ReviewData = {
	currentDocument: {
		id: string;
		version: number;
		filename: string;
		created_at: string;
	} | null;
	rubric: {
		id: string;
		repositoryId: number;
		version: number;
		criteria: EngineeringCriterion[];
	} | null;
	rubricError: string | null;
	documentStale: boolean;
	draft: ReviewRecord | null;
	drafts: ReviewRecord[];
	submissions: ReviewRecord[];
};
type Detail = {
	team: { id: string; name: string; status: string };
	members: Array<{
		id: string;
		github_login: string;
		display_name: string | null;
	}>;
	repositories: Array<{
		id: number;
		full_name: string;
		default_branch: string;
	}>;
	submissions: Array<{
		repository_id: number;
		pr_number: number;
		head_sha: string;
		author_login: string;
		status: string;
		mapping_reason: string;
		github_updated_at: string;
		full_name: string;
	}>;
	matrixSubmissions: Array<{
		repository_id: number;
		full_name: string;
		pr_number: number;
		head_sha: string;
		author_login: string | null;
		mapping_status: string;
		updated_at: string;
		closed: number;
		evaluation_status: string | null;
		failure_code: string | null;
		report: Record<string, unknown> | null;
	}>;
	documents: Document[];
	deadlines: {
		analysisDocumentDeadline: string | null;
		pullRequestDeadline: string | null;
	} | null;
};
type Props = { history?: boolean; initialTeamId?: string };
type Stage = "ANALYSIS" | "ENGINEERING";
const API = "/api/organization/round-two";
const emptyFeedback: ReviewFeedback = {
	problemUnderstanding: "",
	remediation: "",
	innovationImpact: "",
	overall: "",
};
const feedbackFields: Array<{ key: keyof ReviewFeedback; label: string }> = [
	{ key: "problemUnderstanding", label: "Problem understanding" },
	{ key: "remediation", label: "Remediation" },
	{ key: "innovationImpact", label: "Innovation impact" },
	{ key: "overall", label: "Overall feedback" },
];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${API}${path}`, {
		...init,
		credentials: "same-origin",
		headers: {
			accept: "application/json",
			...(init?.body ? { "content-type": "application/json" } : {}),
			...init?.headers,
		},
	});
	const payload = (await response.json().catch(() => ({}))) as T & {
		error?: string;
	};
	if (!response.ok) {
		throw new Error(payload.error ?? `Request failed (${response.status})`);
	}
	return payload;
}
const dateText = (value: string | null | undefined) => {
	if (!value) return "Not set";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};
const errorText = (error: unknown) =>
	error instanceof Error
		? error.message
		: "The review service returned an unknown error.";
const humanBytes = (bytes: number) =>
	bytes < 1024 * 1024
		? `${Math.ceil(bytes / 1024)} KB`
		: `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function JudgeWorkspace({
	history = true,
	initialTeamId = "",
}: Props) {
	const [teams, setTeams] = useState<Team[]>([]);
	const [deadlines, setDeadlines] = useState<Detail["deadlines"]>(null);
	const [teamId, setTeamId] = useState(initialTeamId);
	const [detail, setDetail] = useState<Detail | null>(null);
	const [stage, setStage] = useState<Stage>("ANALYSIS");
	const [review, setReview] = useState<ReviewData | null>(null);
	const [loadedScope, setLoadedScope] = useState("");
	const [score, setScore] = useState("");
	const [feedback, setFeedback] = useState<ReviewFeedback>(emptyFeedback);
	const [criteriaScores, setCriteriaScores] = useState<CriterionScore[]>([]);
	const [reason, setReason] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [sharingReviewId, setSharingReviewId] = useState<string | null>(null);
	const refreshRequest = useRef(0);

	const refresh = useCallback(async () => {
		const requestId = ++refreshRequest.current;
		setLoadedScope("");
		setLoading(true);
		setError(null);
		try {
			const queue = await request<{
				teams: Team[];
				deadlines: Detail["deadlines"];
			}>("/teams");
			if (requestId !== refreshRequest.current) return;
			setTeams(queue.teams);
			setDeadlines(queue.deadlines);
			const selectedId = queue.teams.some((team) => team.id === teamId)
				? teamId
				: (queue.teams[0]?.id ?? "");
			setTeamId(selectedId);
			if (!selectedId) {
				setDetail(null);
				setReview(null);
				setLoadedScope("");
				return;
			}
			const [nextDetail, nextReview] = await Promise.all([
				request<Detail>(`/teams/${encodeURIComponent(selectedId)}`),
				request<ReviewData>(
					`/reviews?teamId=${
						encodeURIComponent(selectedId)
					}&stage=${stage}`,
				),
			]);
			if (requestId !== refreshRequest.current) return;
			setDetail(nextDetail);
			setReview(nextReview);
			setLoadedScope(`${selectedId}:${stage}`);
		} catch (cause) {
			if (requestId === refreshRequest.current) {
				setError(errorText(cause));
			}
		} finally {
			if (requestId === refreshRequest.current) setLoading(false);
		}
	}, [stage, teamId]);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	useEffect(() => {
		if (initialTeamId && initialTeamId !== teamId) setTeamId(initialTeamId);
	}, [initialTeamId, teamId]);
	useEffect(() => {
		const source = preferredReviewSource(
			review?.submissions[0],
			review?.draft,
		);
		setScore(source?.score == null ? "" : String(source.score));
		const payload = source?.payload as
			| (ReviewFeedback & { criteriaScores?: CriterionScore[] })
			| undefined;
		setFeedback(
			payload && stage === "ANALYSIS"
				? { ...emptyFeedback, ...payload }
				: { ...emptyFeedback, overall: payload?.overall ?? "" },
		);
		setCriteriaScores(
			(review?.rubric?.criteria ?? []).map(
				({ id }) =>
					payload?.criteriaScores?.find((item) =>
						item.criterionId === id
					) ?? {
						criterionId: id,
						score: null,
						comment: "",
					},
			),
		);
		setReason("");
	}, [review, stage]);
	const criteria = review?.rubric?.criteria ?? [];
	const engineeringInputs = Object.fromEntries(
		criteriaScores.map((
			{ criterionId, score: value },
		) => [criterionId, value]),
	);
	const criteriaValidation = validateEngineeringCriteria(
		criteria,
		engineeringInputs,
	);
	const engineeringScore = criteriaValidation.valid
		? calculateEngineeringScore(
			criteria,
			Object.fromEntries(
				criteriaScores.map(({ criterionId, score: value }) => [
					criterionId,
					value!,
				]),
			),
		)
		: null;
	const revisionMode = Boolean(review?.submissions[0]);
	const hasSavedDraft = Boolean(review?.draft);
	const currentScope = `${teamId}:${stage}`;
	const reviewReady = loadedScope === currentScope;
	const latestSubmission = review?.submissions[0];
	const pinnedRubricId = revisionMode
		? latestSubmission?.rubric_version_id
		: review?.draft?.rubric_version_id;
	const hasPinnedEngineeringReview = revisionMode || Boolean(review?.draft);
	const rubricMismatch = stage === "ENGINEERING" &&
		hasPinnedEngineeringReview &&
		Boolean(
			!pinnedRubricId ||
				!review?.rubric ||
				pinnedRubricId !== review.rubric.id,
		);
	const currentDocumentId = review?.currentDocument?.id ?? "";
	const draftMatchesForm = Boolean(
		review?.draft &&
			(stage === "ANALYSIS"
				? review.draft.document_id === currentDocumentId &&
					review.draft.score === parseReviewScore(score) &&
					JSON.stringify(review.draft.payload) ===
						JSON.stringify(feedback)
				: review.draft.score === engineeringScore &&
					JSON.stringify(
							(review.draft.payload as {
								criteriaScores?: CriterionScore[];
							})
								.criteriaScores ?? [],
						) === JSON.stringify(criteriaScores) &&
					(review.draft.payload as { overall?: string }).overall ===
						(feedback.overall ?? "")),
	);
	const parsedScore = stage === "ENGINEERING"
		? engineeringScore
		: parseReviewScore(score);

	async function act(action: "SAVE_DRAFT" | "SUBMIT" | "REVISE") {
		if (!reviewReady || loading || saving || error) return;
		if (stage === "ANALYSIS" && score.trim() === "") {
			setError("Enter an Analysis score from 0 to 100.");
			return;
		}
		if (stage === "ENGINEERING" && !criteriaValidation.valid) {
			setError("Score every Engineering criterion from 0 to 100.");
			return;
		}
		const validation = validateReview(
			stage,
			parsedScore,
			stage === "ANALYSIS" ? feedback : null,
			action === "REVISE" ? reason : undefined,
		);
		if (!validation.valid) {
			setError(
				validation.reason === "score"
					? "Enter a score from 0 to 100."
					: validation.reason === "revision"
					? "Give a revision reason of at least 10 characters."
					: "Complete all four Analysis feedback fields.",
			);
			return;
		}
		if (action === "REVISE" && reason.trim().length < 10) {
			setError("Give a revision reason of at least 10 characters.");
			return;
		}
		if (stage === "ANALYSIS" && !currentDocumentId) {
			setError(
				"A current Analysis document is required before saving or submitting.",
			);
			return;
		}
		if (stage === "ENGINEERING" && !review?.rubric) {
			setError(
				review?.rubricError ??
					"The selected repository has no active track rubric.",
			);
			return;
		}
		if (action === "SUBMIT" && !hasSavedDraft) {
			setError("Save a draft before submitting this review.");
			return;
		}
		if (action === "SUBMIT" && !draftMatchesForm) {
			setError("Save your latest changes before submitting this review.");
			return;
		}
		if (rubricMismatch && action !== "SAVE_DRAFT") {
			setError(
				"The saved review uses an unavailable rubric version. Save a new draft against the active rubric before submitting, or ask an organizer to restore the pinned rubric before revising.",
			);
			return;
		}
		if (stage === "ENGINEERING" && !feedback.overall?.trim()) {
			setError(
				"Add overall Engineering feedback before saving or submitting.",
			);
			return;
		}
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			if (action === "SUBMIT") {
				await request("/reviews", {
					method: "POST",
					body: JSON.stringify({ action, teamId, stage }),
				});
			} else if (stage === "ANALYSIS") {
				await request("/reviews", {
					method: "POST",
					body: JSON.stringify({
						action,
						teamId,
						stage,
						score: Number(score),
						feedback,
						documentId: currentDocumentId,
						...(action === "REVISE"
							? { reason: reason.trim() }
							: {}),
					}),
				});
			} else {
				await request("/reviews", {
					method: "POST",
					body: JSON.stringify({
						action,
						teamId,
						stage,
						criteriaScores: criteriaScores.map((item) => ({
							...item,
							score: item.score!,
						})),
						overall: feedback.overall ?? "",
						...(action === "REVISE"
							? { reason: reason.trim() }
							: {}),
					}),
				});
			}
			setNotice(
				action === "SAVE_DRAFT"
					? "Draft saved."
					: action === "REVISE"
					? "Revision submitted."
					: "Review submitted.",
			);
			await refresh();
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setSaving(false);
		}
	}

	async function updateScoreSharing(item: ReviewRecord, shared: boolean) {
		if (!item.id || !teamId) return;
		setSharingReviewId(item.id);
		setError(null);
		setNotice(null);
		try {
			await request("/reviews/share", {
				method: "POST",
				body: JSON.stringify({ teamId, stage, reviewId: item.id, shared }),
			});
			setNotice(shared
				? "Your stage score is selected to share with this team. It appears only in results published from a snapshot containing this review."
				: "Your stage score is no longer selected to share with this team.");
			await refresh();
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setSharingReviewId(null);
		}
	}
	async function downloadDocument(document: Document) {
		setError(null);
		try {
			const response = await fetch(
				`${API}/teams/${encodeURIComponent(teamId)}/documents/${
					encodeURIComponent(document.id)
				}`,
				{ credentials: "same-origin" },
			);
			if (!response.ok) {
				throw new Error(
					`Document download failed (${response.status})`,
				);
			}
			const url = URL.createObjectURL(await response.blob());
			const link = window.document.createElement("a");
			link.href = url;
			link.download = document.filename;
			link.click();
			URL.revokeObjectURL(url);
		} catch (cause) {
			setError(errorText(cause));
		}
	}
	const selectedSubmission = detail?.matrixSubmissions[0] ?? null;

	return (
		<main className="judge-workspace">
			<header className="jw-header">
				<div>
					<p className="jw-eyebrow">DOOMFORGE / ROUND TWO</p>
					<h1>Judge workspace</h1>
					<p className="jw-subtitle">
						Review assigned teams against submitted evidence.
					</p>
				</div>
				<div className="jw-header-actions">
					<button
						className="jw-button jw-button-quiet"
						type="button"
						onClick={() => void refresh()}
						disabled={loading}
					>
						<RefreshCw size={16} /> Refresh
					</button>
				</div>
			</header>
			{error && (
				<div className="jw-alert jw-alert-error" role="alert">
					{error}
					<button type="button" onClick={() => setError(null)}>
						Dismiss
					</button>
				</div>
			)}
			{notice && (
				<div className="jw-alert jw-alert-notice" role="status">
					{notice}
					<button type="button" onClick={() => setNotice(null)}>
						Dismiss
					</button>
				</div>
			)}
			{loading && (
				<div className="jw-state" role="status">
					Loading assigned teams and review evidence…
				</div>
			)}
			{!loading && !error && teams.length === 0 && (
				<div className="jw-state">
					<h2>No teams assigned</h2>
					<p>
						Your assigned review queue is empty. Check again when
						assignments are available.
					</p>
				</div>
			)}
			{!loading && teams.length > 0 && (
				<>
					<div className="jw-toolbar">
						<label className="jw-team-select">
							<span>Assigned team</span>
							<select
								value={teamId}
								disabled={saving || loading}
								onChange={(event) =>
									setTeamId(event.target.value)}
							>
								{teams.map((team) => (
									<option key={team.id} value={team.id}>
										{team.name}
									</option>
								))}
							</select>
						</label>
						<div className="jw-weight-summary">
							<span>
								<strong>10%</strong> Analysis
							</span>
							<i />
							<span>
								<strong>90%</strong> Engineering
							</span>
						</div>
					</div>
					{detail && reviewReady && (
						<>
							<section className="jw-team-card">
								<div className="jw-team-title">
									<div>
										<p className="jw-eyebrow">
											TEAM REVIEW
										</p>
										<h2>{detail.team.name}</h2>
									</div>
									<span className="jw-status">
										{detail.team.status}
									</span>
								</div>
								<div className="jw-team-meta">
									<div>
										<span>Members</span>
										<strong>
											{detail.members.length
												? detail.members
													.map(
														(member) =>
															member
																.display_name ||
															member.github_login,
													)
													.join(", ")
												: "No member records"}
										</strong>
									</div>
									<div>
										<span>Repositories</span>
										<strong>
											{detail.repositories.length
												? detail.repositories
													.map((repo) =>
														repo.full_name
													)
													.join(", ")
												: "None selected"}
										</strong>
									</div>
									<div>
										<span>Analysis deadline</span>
										<strong>
											{dateText(
												deadlines
													?.analysisDocumentDeadline,
											)}
										</strong>
									</div>
									<div>
										<span>Pull request deadline</span>
										<strong>
											{dateText(
												deadlines?.pullRequestDeadline,
											)}
										</strong>
									</div>
								</div>
							</section>
							<div className="jw-grid">
								<div className="jw-evidence-column">
									<section className="jw-panel">
										<div className="jw-panel-heading">
											<div>
												<p className="jw-eyebrow">
													SUBMITTED MATERIAL
												</p>
												<h3>Analysis documents</h3>
											</div>
											<span className="jw-count">
												{detail.documents.length}{" "}
												versions
											</span>
										</div>
										{review?.documentStale && (
											<div className="jw-warning">
												A newer Analysis document exists
												than the one attached to at
												least one submitted review.
												Confirm the document version
												before scoring.
											</div>
										)}
										{detail.documents.length === 0
											? (
												<p className="jw-muted">
													No stored Analysis
													documents.
												</p>
											)
											: (
												<div className="jw-doc-list">
													{detail.documents.map((
														doc,
													) => (
														<article
															className={`jw-document ${
																doc.id ===
																		currentDocumentId
																	? "is-current"
																	: ""
															}`}
															key={doc.id}
														>
															<div className="jw-doc-icon">
																PDF
															</div>
															<div className="jw-doc-copy">
																<strong>
																	{doc.filename}
																</strong>
																<span>
																	Version{" "}
																	{doc.version}
																	{" "}
																	·{" "}
																	{humanBytes(
																		doc.bytes,
																	)} ·{" "}
																	{doc.content_type}
																</span>
																<span>
																	Uploaded
																	{" "}
																	{dateText(
																		doc.created_at,
																	)} · SHA-256
																	{" "}
																	{doc.sha256}
																</span>
															</div>
															<button
																className="jw-icon-button"
																type="button"
																aria-label={`Download ${doc.filename}`}
																onClick={() =>
																	void downloadDocument(
																		doc,
																	)}
															>
																<ArrowDownToLine
																	size={17}
																/>
															</button>
														</article>
													))}
												</div>
											)}
									</section>
									<section className="jw-panel">
										<div className="jw-panel-heading">
											<div>
												<p className="jw-eyebrow">
													CODE EVIDENCE
												</p>
												<h3>Pull requests & CI</h3>
											</div>
											<span className="jw-count">
												{detail.matrixSubmissions
													.length} evaluated
											</span>
										</div>
										{!detail.matrixSubmissions.length &&
												!detail.submissions.length
											? (
												<p className="jw-muted">
													No pull request submissions
													are available.
												</p>
											)
											: (
												<div className="jw-pr-list">
													{detail.matrixSubmissions
														.map((item) => (
															<article
																className="jw-pr-card"
																key={`${item.repository_id}-${item.pr_number}`}
															>
																<div className="jw-pr-top">
																	<strong>
																		{item
																			.full_name}
																		{" "}
																		<span>
																			#{item
																				.pr_number}
																		</span>
																	</strong>
																	<span className="jw-status">
																		{item
																			.evaluation_status ??
																			item.mapping_status}
																	</span>
																</div>
																<p>
																	Head{" "}
																	<code>
																		{item
																			.head_sha
																			.slice(
																				0,
																				12,
																			)}
																	</code>{" "}
																	· {item
																		.author_login ??
																		"Unknown author"}
																	{" "}
																	· Updated
																	{" "}
																	{dateText(
																		item.updated_at,
																	)}
																</p>
																{item
																	.failure_code &&
																	(
																		<div className="jw-warning">
																			Evaluation
																			issue:
																			{" "}
																			{item
																				.failure_code}
																		</div>
																	)}
																<details>
																	<summary>
																		Evaluation
																		report
																		and
																		checks
																	</summary>
																	<pre>
                                {JSON.stringify(
                                  item.report ?? {
                                    status: item.evaluation_status,
                                    mapping: item.mapping_status,
                                  },
                                  null,
                                  2,
                                )}
																	</pre>
																</details>
																{item
																			.mapping_status ===
																		"MAPPED" &&
																	(
																		<a
																			className="jw-text-link"
																			href={`https://github.com/${item.full_name}/pull/${item.pr_number}`}
																			target="_blank"
																			rel="noreferrer"
																		>
																			Open
																			pull
																			request
																			{" "}
																			<ExternalLink
																				size={13}
																			/>
																		</a>
																	)}
										<PullRequestEvidence teamId={teamId} repositoryId={item.repository_id} prNumber={item.pr_number} />
															</article>
														))}
													{detail.submissions
														.filter(
															(item) =>
																!detail
																	.matrixSubmissions
																	.some(
																		(
																			matrix,
																		) => matrix
																					.repository_id ===
																				item.repository_id &&
																			matrix
																					.pr_number ===
																				item.pr_number,
																	),
														)
														.map((item) => (
															<article
																className="jw-pr-card"
																key={`${item.repository_id}-${item.pr_number}`}
															>
																<div className="jw-pr-top">
																	<strong>
																		{item
																			.full_name}
																		{" "}
																		#{item
																			.pr_number}
																	</strong>
																	<span className="jw-status">
																		{item
																			.status}
																	</span>
																</div>
																<p>
																	Head{" "}
																	<code>
																		{item
																			.head_sha
																			.slice(
																				0,
																				12,
																			)}
																	</code>{" "}
																	· {item
																		.author_login}
																	{" "}
																	· {item
																		.mapping_reason}
																</p>
																<a
																	className="jw-text-link"
																	href={`https://github.com/${item.full_name}/pull/${item.pr_number}`}
																	target="_blank"
																	rel="noreferrer"
																>
																	Open pull
																	request{" "}
																	<ExternalLink
																		size={13}
																	/>
																</a>
															</article>
														))}
												</div>
											)}
									</section>
									{selectedSubmission?.report && (
										<p className="jw-evidence-note">
											Evaluation report is objective
											evidence. Scores remain the judge’s
											assessment; unexecuted criteria stay
											unverified.
										</p>
									)}
								</div>
								<div className="jw-review-column">
									<nav
										className="jw-stage-tabs"
										aria-label="Review stage"
									>
										<button
											type="button"
											disabled={saving}
											className={stage === "ANALYSIS"
												? "is-active"
												: ""}
											onClick={() => setStage("ANALYSIS")}
										>
											<span>01</span> Analysis <b>10%</b>
										</button>
										<button
											type="button"
											disabled={saving}
											className={stage === "ENGINEERING"
												? "is-active"
												: ""}
											onClick={() =>
												setStage("ENGINEERING")}
										>
											<span>02</span> Engineering{" "}
											<b>90%</b>
										</button>
									</nav>
									<section className="jw-panel jw-review-panel">
										<div className="jw-panel-heading">
											<div>
												<p className="jw-eyebrow">
													{stage === "ANALYSIS"
														? "ANALYSIS REVIEW"
														: "TRACK RUBRIC"}
												</p>
												<h3>
													{stage === "ANALYSIS"
														? "Problem & impact"
														: "Engineering quality"}
												</h3>
											</div>
											<span className="jw-count">
												{revisionMode
													? `Revision ${
														review?.submissions[0]
															?.revision ?? 1
													}`
													: hasSavedDraft
													? "Draft in progress"
													: "New review"}
											</span>
										</div>
										{stage === "ANALYSIS"
											? (
												<>
													{review?.currentDocument &&
														(
															<div className="jw-current-document">
																<span>
																	Scoring
																	against
																</span>
																<strong>
																	v{review
																		.currentDocument
																		.version}
																	{" "}
																	· {review
																		.currentDocument
																		.filename}
																</strong>
																<span>
																	Uploaded
																	{" "}
																	{dateText(
																		review
																			.currentDocument
																			.created_at,
																	)}
																</span>
															</div>
														)}
													<label className="jw-field jw-score-field">
														<span>
															Analysis score{" "}
															<small>0–100</small>
														</span>
														<div>
															<input
																type="number"
																min="0"
																max="100"
																disabled={saving}
																value={score}
																onChange={(
																	event,
																) => setScore(
																	event.target
																		.value,
																)}
																placeholder="00"
															/>
															<em>/ 100</em>
														</div>
													</label>
													{feedbackFields.map((
														{ key, label },
													) => (
														<label
															className="jw-field"
															key={key}
														>
															<span>{label}</span>
															<textarea
																disabled={saving}
																value={feedback[
																	key
																] ?? ""}
																onChange={(
																	event,
																) => setFeedback(
																	(
																		current,
																	) => ({
																		...current,
																		[key]:
																			event
																				.target
																				.value,
																	}),
																)}
																rows={key ===
																		"overall"
																	? 3
																	: 2}
																placeholder={`Notes on ${label.toLowerCase()}…`}
															/>
														</label>
													))}
												</>
											)
											: (
												<>
													{review?.rubricError && (
														<div className="jw-warning">
															Track rubric
															unavailable:{" "}
															{review.rubricError}
														</div>
													)}
													{review?.rubric && (
														<p className="jw-muted">
															Rubric v{review
																.rubric.version}
															{" "}
															· weights total 100%
															· engineering score
															{" "}
															<strong>
																{engineeringScore
																	?.toFixed(
																		1,
																	) ?? "—"}
															</strong>
															{!criteriaValidation
																.valid && (
																<span>
																	Score every
																	criterion to
																	calculate.
																</span>
															)}
														</p>
													)}
													{rubricMismatch && (
														<div
															className="jw-warning"
															role="alert"
														>
															This stored review
															uses a different
															rubric version. The
															judge API does not
															provide its original
															criteria and
															weights. Save a
															fresh draft to
															update an
															unsubmitted review;
															submitted revisions
															remain blocked until
															the pinned rubric is
															available.
														</div>
													)}
													{revisionMode &&
															rubricMismatch
														? (
															<p className="jw-muted">
																The submitted
																criterion scores
																and comments
																remain in review
																history. The
																pinned rubric is
																unavailable in
																the judge API,
																so this editor
																cannot safely
																calculate or
																revise them.
															</p>
														)
														: criteria.length
														? (
															criteria.map(
																(criterion) => {
																	const value =
																		criteriaScores
																			.find(
																				(
																					item,
																				) => item
																					.criterionId ===
																					criterion
																						.id,
																			);
																	return (
																		<div
																			className="jw-criterion"
																			key={criterion
																				.id}
																		>
																			<div className="jw-criterion-heading">
																				<label
																					htmlFor={`criterion-${criterion.id}`}
																				>
																					{criterion
																						.label}
																				</label>
																				<span>
																					{criterion
																						.weight}%
																				</span>
																			</div>
																			<div className="jw-criterion-inputs">
																				<input
																					id={`criterion-${criterion.id}`}
																					type="number"
																					min="0"
																					max="100"
																					disabled={saving}
																					value={value
																						?.score ??
																						""}
																					onChange={(
																						event,
																					) => setCriteriaScores(
																						(
																							current,
																						) => current
																							.map(
																								(
																									item,
																								) => item
																										.criterionId ===
																										criterion
																											.id
																									? {
																										...item,
																										score:
																											event
																													.target
																													.value ===
																													""
																												? null
																												: Number(
																													event
																														.target
																														.value,
																												),
																									}
																									: item,
																							),
																					)}
																				/>
																				<span>
																					/
																					100
																				</span>
																				<input
																					aria-label={`${criterion.label} score slider`}
																					type="range"
																					min="0"
																					max="100"
																					disabled={saving ||
																						value
																								?.score ==
																							null}
																					value={value
																						?.score ??
																						0}
																					onChange={(
																						event,
																					) => setCriteriaScores(
																						(
																							current,
																						) => current
																							.map(
																								(
																									item,
																								) => item
																										.criterionId ===
																										criterion
																											.id
																									? {
																										...item,
																										score:
																											Number(
																												event
																													.target
																													.value,
																											),
																									}
																									: item,
																							),
																					)}
																				/>
																			</div>
																			<textarea
																				aria-label={`${criterion.label} feedback`}
																				disabled={saving}
																				rows={2}
																				placeholder={`Evidence and feedback for ${criterion.label.toLowerCase()}…`}
																				value={value
																					?.comment ??
																					""}
																				onChange={(
																					event,
																				) => setCriteriaScores(
																					(
																						current,
																					) => current
																						.map(
																							(
																								item,
																							) => item
																									.criterionId ===
																									criterion
																										.id
																								? {
																									...item,
																									comment:
																										event
																											.target
																											.value,
																								}
																								: item,
																						),
																				)}
																			/>
																		</div>
																	);
																},
															)
														)
														: (
															<p className="jw-muted">
																Select exactly
																one active
																repository with
																a configured
																track rubric to
																score
																Engineering.
															</p>
														)}
													<label className="jw-field">
														<span>
															Overall engineering
															feedback
														</span>
														<textarea
															rows={3}
															disabled={saving}
															value={feedback
																.overall ?? ""}
															onChange={(event) =>
																setFeedback((
																	current,
																) => ({
																	...current,
																	overall:
																		event
																			.target
																			.value,
																}))}
															placeholder="Summarize the strongest evidence and remaining concerns…"
														/>
													</label>
												</>
											)}
										{revisionMode && (
											<label className="jw-field jw-reason-field">
												<span>
													Reason for revision{" "}
													<small>
														Required, at least 10
														characters
													</small>
												</span>
												<textarea
													rows={2}
													disabled={saving}
													value={reason}
													onChange={(event) =>
														setReason(
															event.target.value,
														)}
													placeholder="Explain what new evidence or correction prompted this revision…"
												/>
											</label>
										)}
										<div className="jw-review-actions">
											<button
												type="button"
												className="jw-button jw-button-secondary"
												disabled={saving || loading ||
													!reviewReady ||
													revisionMode}
												onClick={() =>
													void act("SAVE_DRAFT")}
											>
												<Save size={16} /> Save draft
											</button>
											<button
												type="button"
												className="jw-button jw-button-primary"
												disabled={saving ||
													loading ||
													!reviewReady ||
													rubricMismatch ||
													(!revisionMode &&
														(!hasSavedDraft ||
															!draftMatchesForm))}
												onClick={() =>
													void act(
														revisionMode
															? "REVISE"
															: "SUBMIT",
													)}
											>
												<Send size={16} /> {saving
													? "Saving…"
													: revisionMode
													? "Submit revision"
													: "Submit review"}
											</button>
										</div>
										<p className="jw-submit-note">
											{revisionMode
												? "Submitted reviews are immutable; revisions create a new preserved history entry."
												: "Submitting requires a saved draft. Save your review first, then submit it."}
										</p>
									</section>
									{history && (
										<section className="jw-panel jw-history-panel">
											<div className="jw-panel-heading">
												<div>
													<p className="jw-eyebrow">
														AUDIT TRAIL
													</p>
													<h3>Review history</h3>
												</div>
											</div>
											{(review?.submissions ?? []).map((
												item,
												index,
											) => (
												<div
													className="jw-history-entry"
													key={`sub-${index}`}
												>
													<div className="jw-history-row">
														<span>
															{stage}{" "}
															· submitted revision
															{" "}
															{item.revision ??
																index + 1}
															{item.reason
																? ` · ${item.reason}`
																: ""}
														</span>
														<strong>
															{item.score
																?.toFixed(1) ??
																"—"}
														</strong>
														<time>
															{dateText(
																item.submitted_at,
															)}
														</time>
													</div>
													<details className="jw-history-detail">
														<summary>
															View submitted
															scores and feedback
														</summary>
														<pre>{JSON.stringify(item.payload, null, 2)}</pre>
													</details>
													{item.id && (index === 0 || item.scoreShared || item.includedInPublishedSnapshot) && (
														<div className="jw-score-sharing">
															<div>
																<strong>{item.scoreShared ? "Stage score selected to share" : "Stage score is private"}</strong>
																<p>{item.includedInPublishedSnapshot
																	? "This exact review is part of the current published snapshot."
																	: "Sharing appears to participants only after an organizer publishes a snapshot containing this exact review."}</p>
															</div>
															<button
															className="jw-button jw-button-secondary"
															disabled={sharingReviewId !== null}
															onClick={() => void updateScoreSharing(item, !item.scoreShared)}
															type="button"
															aria-pressed={item.scoreShared === true}
														>
															{sharingReviewId === item.id
																? "Saving…"
																: item.scoreShared ? "Stop sharing score" : "Share stage score"}
														</button>
														</div>
													)}
												</div>
											))}
											{(review?.drafts ?? []).map((
												item,
												index,
											) => (
												<div
													className="jw-history-row"
													key={`draft-${index}`}
												>
													<span>
														{stage} · draft saved
													</span>
													<strong>
														{item.score?.toFixed(
															1,
														) ?? "—"}
													</strong>
													<time>
														{dateText(
															item.updated_at,
														)}
													</time>
												</div>
											))}
							{!review?.submissions.length &&
												!review?.drafts.length && (
												<p className="jw-muted">
													No review history yet.
												</p>
											)}
										</section>
									)}
								</div>
							</div>
						</>
					)}
				</>
			)}
		</main>
	);
}

export { calculateEngineeringScore, validateReview };

type PageInfo = { status: "available" | "unavailable"; page: number; hasMore: boolean; reason?: string };
type PullRequestEvidencePayload = {
	pullRequest: { number: number; title: string; htmlUrl: string; author: string; openedAt: string; updatedAt: string; state: string; additions: number; deletions: number };
	captured: { headSha: string; baselineSha: string | null };
	currentHeadSha: string | null;
	stale: boolean;
	changedFiles: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string | null; patchTruncated: boolean; patchUnavailable: boolean }>;
	commits: Array<{ sha: string; message: string; messageTruncated: boolean; author: string; date: string }>;
	reviews: Array<{ author: string; state: string; submittedAt: string; body: string; bodyTruncated: boolean }>;
	checks: Array<{ name: string; status: string; conclusion: string | null; detailsUrl: string | null }>;
	securityFindings: Array<{ rule: string; description: string; severity: string; state: string; url: string | null; createdAt: string; fixedAt: string | null; path: string | null; line: number | null }>;
	changedFilesPage: PageInfo;
	commitsPage: PageInfo;
	reviewsPage: PageInfo;
	checksPage: PageInfo;
	securityFindingsPage: PageInfo;
	automatedEvaluation: { status: "available" | "incomplete" | "unavailable"; state: string | null; failureCode: string | null; checks: Array<{ id: string; category: string; status: string; detail: string }>; categories: Record<string, unknown>; overallScore: number | null };
};

function PullRequestEvidence({ teamId, repositoryId, prNumber }: { teamId: string; repositoryId: number; prNumber: number }) {
	const [expanded, setExpanded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [evidence, setEvidence] = useState<PullRequestEvidencePayload | null>(null);
	async function load() {
		if (loading) return;
		setExpanded(true);
		if (evidence) return;
		setLoading(true);
		setError("");
		try {
			const response = await fetch(`${API}/teams/${encodeURIComponent(teamId)}/pull-requests/${repositoryId}/${prNumber}`, { credentials: "same-origin" });
			const payload = await response.json().catch(() => null) as PullRequestEvidencePayload | { error?: string } | null;
			if (!response.ok) throw new Error(payload && "error" in payload ? payload.error ?? `Request failed (${response.status})` : `Request failed (${response.status})`);
			if (!payload || !("pullRequest" in payload)) throw new Error("Pull request evidence response was invalid.");
			setEvidence(payload);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Pull request evidence is unavailable.");
		} finally {
			setLoading(false);
		}
	}
	return <div className="jw-pr-evidence">
		<button className="jw-button jw-button-quiet" type="button" aria-expanded={expanded} onClick={() => expanded ? setExpanded(false) : void load()}>{expanded ? "Hide GitHub evidence" : "Load GitHub evidence"}</button>
		{expanded && <div className="jw-pr-evidence-content">
			{loading && <p className="jw-muted" role="status">Loading captured pull request evidence…</p>}
			{error && <p className="jw-warning" role="alert">{error}</p>}
			{evidence && <>
				{evidence.stale && <p className="jw-warning" role="status">GitHub head changed since this submission was captured. Captured {evidence.captured.headSha.slice(0, 12)}; current {evidence.currentHeadSha?.slice(0, 12) ?? "unavailable"}. Review the captured submission and treat current checks as newer evidence.</p>}
				<header><strong>{evidence.pullRequest.title}</strong><span>{evidence.pullRequest.state} · +{evidence.pullRequest.additions} / −{evidence.pullRequest.deletions}</span><a className="jw-text-link" href={evidence.pullRequest.htmlUrl} target="_blank" rel="noreferrer">Open on GitHub <ExternalLink size={13} /></a></header>
				<p className="jw-muted">By {evidence.pullRequest.author} · opened {dateText(evidence.pullRequest.openedAt)} · captured base {evidence.captured.baselineSha?.slice(0, 12) ?? "unavailable"}</p>
				<h4>Changed files</h4>{evidence.changedFilesPage.status === "unavailable" ? <p className="jw-muted">File details unavailable: {evidence.changedFilesPage.reason ?? "GitHub did not return them."}</p> : evidence.changedFiles.length ? evidence.changedFiles.map(file => <details key={`${file.filename}-${file.status}`}><summary>{file.filename} · {file.status} · +{file.additions} / −{file.deletions}{file.patchTruncated ? " · patch truncated" : ""}</summary>{file.patch ? <pre>{file.patch}</pre> : <p className="jw-muted">{file.patchUnavailable ? "Patch is unavailable for this file." : "No patch returned."}</p>}</details>) : <p className="jw-muted">No changed files on this page.</p>}
				{evidence.changedFilesPage.hasMore && <p className="jw-muted">More files are available through the evidence API.</p>}
				<h4>Commits</h4>{evidence.commitsPage.status === "unavailable" ? <p className="jw-muted">Commit list unavailable: {evidence.commitsPage.reason ?? "GitHub did not return them."}</p> : evidence.commits.map(commit => <p key={commit.sha}><code>{commit.sha.slice(0, 12)}</code> {commit.message}{commit.messageTruncated ? "…" : ""} · {commit.author} · {dateText(commit.date)}</p>)}
				<h4>Reviews and checks</h4>{evidence.reviewsPage.status === "unavailable" ? <p className="jw-muted">Reviews unavailable: {evidence.reviewsPage.reason ?? "GitHub did not return them."}</p> : evidence.reviews.map((review, index) => <p key={`${review.author}-${index}`}>{review.author} · {review.state} · {dateText(review.submittedAt)}{review.body ? ` · ${review.body}${review.bodyTruncated ? "…" : ""}` : ""}</p>)}{evidence.checksPage.status === "unavailable" ? <p className="jw-muted">Checks unavailable: {evidence.checksPage.reason ?? "GitHub did not return them."}</p> : evidence.checks.map((check, index) => <p key={`${check.name}-${index}`}>{check.name} · {check.status}{check.conclusion ? ` · ${check.conclusion}` : ""}</p>)}
				<h4>Security findings</h4>{evidence.securityFindingsPage.status === "unavailable" ? <p className="jw-muted">Security findings unavailable: {evidence.securityFindingsPage.reason ?? "GitHub did not return them."}</p> : evidence.securityFindings.length ? evidence.securityFindings.map((finding, index) => <p key={`${finding.rule}-${index}`}>{finding.severity} · {finding.rule} · {finding.description}{finding.path ? ` · ${finding.path}${finding.line ? `:${finding.line}` : ""}` : ""}</p>) : <p className="jw-muted">No security findings returned.</p>}
				<h4>Automated evaluation</h4><p>{evidence.automatedEvaluation.status}: {evidence.automatedEvaluation.state ?? "No evaluation state"}{evidence.automatedEvaluation.failureCode ? ` · ${evidence.automatedEvaluation.failureCode}` : ""}</p>{evidence.automatedEvaluation.checks.map(check => <p key={check.id}>{check.category} · {check.status} · {check.detail}</p>)}
			</>}
		</div>}
	</div>;
}
