import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, FileText, GitPullRequest, RefreshCw, Search, UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getRoundTwoTeams, type JudgeTeam } from "@/lib/api";
import type { Role } from "@/types/session";
import { MetricCard } from "@/features/overview/metric-card";

type QueueFilter = "All teams" | "With PRs" | "With analysis" | "Awaiting work";
function errorText(error: unknown) {
	return error instanceof Error ? error.message : "The assigned queue is unavailable.";
}

export function JudgeOverview({ role }: { readonly role: Role }) {
	const navigate = useNavigate();
	const [teams, setTeams] = useState<JudgeTeam[]>([]);
	const [deadlines, setDeadlines] = useState<{ analysisDocumentDeadline: string | null; pullRequestDeadline: string | null } | null>(null);
	const [filter, setFilter] = useState<QueueFilter>("All teams");
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);

	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		getRoundTwoTeams().then((result) => {
			if (!active) return;
			setTeams(result.teams);
			setDeadlines(result.deadlines);
		}).catch((cause: unknown) => {
			if (active) setError(errorText(cause));
		}).finally(() => {
			if (active) setLoading(false);
		});
		return () => { active = false; };
	}, [refreshKey]);

	const visibleTeams = useMemo(() => teams.filter((team) => {
		const filterMatches = filter === "All teams" ||
			(filter === "With PRs" ? team.submission_count > 0 :
			filter === "With analysis" ? team.document_count > 0 :
			team.submission_count === 0 && team.document_count === 0);
		const queryMatches = `${team.name} ${team.id}`.toLowerCase().includes(query.trim().toLowerCase());
		return filterMatches && queryMatches;
	}), [teams, filter, query]);
	const submittedTeams = teams.filter((team) => team.submission_count > 0).length;
	const docsTeams = teams.filter((team) => team.document_count > 0).length;
	const totalPullRequests = teams.reduce((sum, team) => sum + team.submission_count, 0);
	const title = role === "judge" ? "Your review queue" : role === "participant" ? "Team overview" : "Judging overview";

	return (
		<main className="overview-page">
			<div className="page-heading">
				<div>
					<div className="eyebrow"><span className="eyebrow-mark" /> DOOMFORGE <span className="eyebrow-separator">/</span> ROUND TWO</div>
					<h1>{title}</h1>
					<p>Assigned teams and submitted evidence from the live review queue.</p>
				</div>
				<div className="heading-actions">
					<Button aria-label="Refresh assigned queue" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)} variant="secondary">
						<RefreshCw data-icon="inline-start" /> Refresh
					</Button>
				</div>
			</div>

			<section aria-label="Assigned queue summary" className="metrics-grid">
				<MetricCard detail="Visible in your assignment scope" icon={UsersRound} label="Assigned teams" tone="peach" value={loading ? "—" : String(teams.length)} />
				<MetricCard detail="Teams with at least one tracked PR" icon={GitPullRequest} label="Teams with PRs" tone="blue" value={loading ? "—" : String(submittedTeams)} />
				<MetricCard detail="Total tracked pull requests" icon={GitPullRequest} label="Pull requests" tone="green" value={loading ? "—" : String(totalPullRequests)} />
				<MetricCard detail="Teams with stored analysis files" icon={FileText} label="Analysis documents" tone="gold" value={loading ? "—" : String(docsTeams)} />
			</section>

			<div className="overview-grid">
				<Card className="queue-card">
					<CardHeader className="queue-header">
						<div>
							<div className="section-title-line"><CardTitle>Assigned teams</CardTitle><Badge>{loading ? "Loading" : `${visibleTeams.length} shown`}</Badge></div>
							<CardDescription>Open a team to inspect its source documents, pull requests, checks, and review history.</CardDescription>
						</div>
						<div className="queue-header-actions">
							<label className="overview-search"><Search aria-hidden="true" /><span className="sr-only">Search assigned teams</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search teams" /></label>
						</div>
					</CardHeader>
					<CardContent>
						<div className="queue-filters" role="group" aria-label="Filter assigned teams">
							{(["All teams", "With PRs", "With analysis", "Awaiting work"] as const).map((item) => <Button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)} size="sm" variant={filter === item ? "primary" : "secondary"}>{item}</Button>)}
						</div>
						{loading && <p role="status">Loading assigned teams…</p>}
						{error && <div className="overview-error" role="alert"><AlertCircle aria-hidden="true" /><span>{error}</span><Button onClick={() => setRefreshKey((value) => value + 1)} size="sm" variant="secondary">Try again</Button></div>}
						{!loading && !error && visibleTeams.length === 0 && <div className="queue-empty"><UsersRound aria-hidden="true" /><strong>{teams.length ? "No matching teams" : "No teams assigned"}</strong><span>{teams.length ? "Change the search or filter." : "Your assigned queue is empty. New teams appear here when an organizer assigns them."}</span></div>}
						{!loading && !error && visibleTeams.length > 0 && <div className="assigned-team-list">
							{visibleTeams.map((team) => <article className="assigned-team-row" key={team.id}>
								<div className="assigned-team-copy"><div><h2>{team.name}</h2><Badge tone={team.status === "ACTIVE" ? "success" : "neutral"}>{team.status}</Badge></div><p>{team.submission_count} pull request{team.submission_count === 1 ? "" : "s"} · {team.document_count} analysis document{team.document_count === 1 ? "" : "s"}</p></div>
								<Button onClick={() => navigate(`/workspace?teamId=${encodeURIComponent(team.id)}`)} variant="primary">Open review workspace for {team.name}</Button>
							</article>)}
						</div>}
					</CardContent>
				</Card>
				<Card className="queue-card queue-deadlines">
					<CardHeader><div><CardTitle>Review deadlines</CardTitle><CardDescription>Round Two schedule from the competition workspace.</CardDescription></div></CardHeader>
					<CardContent>{deadlines ? <dl>{deadlines.analysisDocumentDeadline && <div><dt>Analysis document</dt><dd>{new Date(deadlines.analysisDocumentDeadline).toLocaleString()}</dd></div>}{deadlines.pullRequestDeadline && <div><dt>Pull request</dt><dd>{new Date(deadlines.pullRequestDeadline).toLocaleString()}</dd></div>}{!deadlines.analysisDocumentDeadline && !deadlines.pullRequestDeadline && <p>No deadlines have been set.</p>}</dl> : <p>Deadline details are not available.</p>}</CardContent>
				</Card>
			</div>
		</main>
	);
}
