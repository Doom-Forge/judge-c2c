import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, GitPullRequest, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type TeamRecord = { id: string; name: string; status: string; lead_email?: string | null };
type RosterMember = { id: string; display_name?: string | null; name?: string | null; email?: string | null; github_login?: string | null; active?: number; github_id?: number | null };
type Assignment = { id: string; judge_identity_id: string; judge_name: string; team_id: string; revoked_at: string | null };
type TeamDetail = {
	team: { id: string; name: string; status: string };
	members: Array<{ id: string; github_login: string; display_name: string | null }>;
	repositories: Array<{ id: number; full_name: string; default_branch: string }>;
	submissions: Array<{ repository_id: number; pr_number: number; head_sha: string; author_login: string; status: string; github_updated_at: string; full_name: string }>;
	documents: Array<{ id: string; version: number; filename: string; bytes: number; status: string; created_at: string }>;
	matrixSubmissions: Array<{ repository_id: number; full_name: string; pr_number: number; head_sha: string; author_login: string | null; evaluation_status: string | null; failure_code: string | null; closed: number }>;
	unverifiedPullRequests?: Array<{ repository_id: number; full_name: string; pr_number: number; head_sha: string; author_login: string; check_status: string; closed: number }>;
};
type AdminTeamDetail = { team: TeamRecord; members: RosterMember[]; repositories?: Array<{ full_name: string; repository_id: number; active: number }> };
type TeamResult = { teamId: string; finalScore: number | null; status: string };

async function get<T>(path: string): Promise<T> {
	const response = await fetch(`/api/organization${path}`, { credentials: "same-origin", headers: { accept: "application/json" } });
	const payload = await response.json().catch(() => ({})) as T & { error?: string };
	if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
	return payload;
}

function formatDate(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function OrganizerTeamInspector() {
	const { teamId = "" } = useParams();
	const [team, setTeam] = useState<AdminTeamDetail | null>(null);
	const [detail, setDetail] = useState<TeamDetail | null>(null);
	const [assignments, setAssignments] = useState<Assignment[]>([]);
	const [result, setResult] = useState<TeamResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	useEffect(() => {
		let current = true;
		setLoading(true);
		setError("");
		Promise.all([
			get<AdminTeamDetail>(`/manage/teams/${encodeURIComponent(teamId)}`),
			get<TeamDetail>(`/round-two/teams/${encodeURIComponent(teamId)}`).catch(() => null),
			get<{ assignments: Assignment[] }>("/round-two/assignments").catch(() => ({ assignments: [] })),
			get<{ results: TeamResult[] }>("/round-two/results").catch(() => ({ results: [] })),
		]).then(([teamResult, detailResult, assignmentResult, results]) => {
			if (!current) return;
			setTeam(teamResult);
			setDetail(detailResult);
			setAssignments(assignmentResult.assignments.filter((item) => item.team_id === teamId && !item.revoked_at));
			setResult(results.results.find((item) => item.teamId === teamId) ?? null);
		}).catch((cause) => {
			if (current) setError(cause instanceof Error ? cause.message : "Team inspection data is unavailable.");
		}).finally(() => { if (current) setLoading(false); });
		return () => { current = false; };
	}, [teamId]);

	if (loading) return <main className="page-content"><p role="status">Loading organizer inspection…</p></main>;
	if (error || !team) return <main className="page-content space-y-4"><Link className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--info)]" to="/teams"><ArrowLeft size={16} />Back to teams</Link><p role="alert">{error || "Team is unavailable."}</p></main>;
	const roster = team.members ?? [];
	const documents = detail?.documents ?? [];
	const pullRequests = [
		...(detail?.submissions ?? []).map((item) => ({ ...item, status: item.status || "RECORDED", source: "Repository activity" })),
		...(detail?.matrixSubmissions ?? []).map((item) => ({ ...item, author_login: item.author_login ?? "Unknown author", github_updated_at: "", status: item.evaluation_status ?? "UNVERIFIED", source: "Container evaluation" })),
		...(detail?.unverifiedPullRequests ?? []).map((item) => ({ ...item, author_login: item.author_login, github_updated_at: "", status: "UNVERIFIED", source: "Container evaluation" })),
	];
	return <main className="page-content space-y-5">
		<Link className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--info)]" to="/teams"><ArrowLeft size={16} />Back to team roster</Link>
		<header className="flex flex-wrap items-end justify-between gap-4"><div><p className="mb-2 text-xs uppercase tracking-[.16em] text-[var(--muted)]">Super admin · read-only inspection</p><h1 className="text-3xl font-semibold">{team.team.name}</h1><p className="mt-2 text-sm text-[var(--muted)]">Inspect participant and judging progress without opening a participant session or changing credentials.</p></div><Badge tone={team.team.status === "ACTIVE" ? "success" : "neutral"}>{team.team.status}</Badge></header>
		<div className="grid gap-4 md:grid-cols-3"><Card><CardHeader><CardTitle>Team track</CardTitle><CardDescription>Confirmed repository assignment</CardDescription></CardHeader><CardContent><p className="break-all font-medium">{detail?.repositories?.[0]?.full_name ?? "No repository selected"}</p></CardContent></Card><Card><CardHeader><CardTitle>Official final score</CardTitle><CardDescription>Judge-entered score</CardDescription></CardHeader><CardContent><p className="text-2xl font-semibold">{result?.finalScore === null || !result ? "Pending" : result.finalScore.toFixed(1)}</p></CardContent></Card><Card><CardHeader><CardTitle>Participant view</CardTitle><CardDescription>Inspection stays within organizer access</CardDescription></CardHeader><CardContent><p className="text-sm text-[var(--muted)]">Read-only · no team key or identity switching</p></CardContent></Card></div>
		<Card><CardHeader><div><CardTitle>Participant roster</CardTitle><CardDescription>{roster.length} imported participant{roster.length === 1 ? "" : "s"} · lead email {team.team.lead_email ?? "not listed"}</CardDescription></div><Users className="text-[var(--accent)]" /></CardHeader><CardContent>{roster.length ? <ul className="divide-y divide-[var(--border)]">{roster.map((member) => <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm" key={member.id}><span><strong>{member.display_name ?? member.name ?? "Participant"}</strong><small className="ml-2 text-[var(--muted)]">{member.email ?? "Email not available"}</small></span><span className="text-[var(--muted)]">{member.github_login ? `@${member.github_login}${member.github_id ? ` · GitHub ID ${member.github_id}` : ""}` : "GitHub not linked"}</span></li>)}</ul> : <p className="text-sm text-[var(--muted)]">No imported roster records are available.</p>}</CardContent></Card>
		<Card><CardHeader><div><CardTitle>Analysis documents</CardTitle><CardDescription>Stored submissions available to authorized reviewers</CardDescription></div></CardHeader><CardContent>{documents.length ? <ul className="divide-y divide-[var(--border)]">{documents.map((document) => <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm" key={document.id}><span><strong>{document.filename}</strong><small className="ml-2 text-[var(--muted)]">Version {document.version} · {(document.bytes / 1024).toFixed(0)} KB · {formatDate(document.created_at)}</small></span><Badge tone="neutral">{document.status}</Badge></li>)}</ul> : <p className="text-sm text-[var(--muted)]">No analysis document is stored yet.</p>}</CardContent></Card>
		<Card><CardHeader><div><CardTitle>Pull request and container status</CardTitle><CardDescription>Automated evidence is shown separately from judge marks.</CardDescription></div><GitPullRequest className="text-[var(--accent)]" /></CardHeader><CardContent>{pullRequests.length ? <ul className="divide-y divide-[var(--border)]">{pullRequests.map((pr) => <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm" key={`${pr.repository_id}-${pr.pr_number}-${pr.source}`}><span><strong>{pr.full_name} #{pr.pr_number}</strong><small className="ml-2 text-[var(--muted)]">@{pr.author_login} · {pr.head_sha.slice(0, 12)} · {pr.source}</small></span><Badge tone={pr.status === "COMPLETED" ? "success" : "neutral"}>{pr.status}</Badge></li>)}</ul> : <p className="text-sm text-[var(--muted)]">No pull requests have been recorded.</p>}</CardContent></Card>
		<Card><CardHeader><div><CardTitle>Judge dashboard inspections</CardTitle><CardDescription>Open a judge’s review history for this team in a read-only view.</CardDescription></div></CardHeader><CardContent>{assignments.length ? <ul className="flex flex-wrap gap-3">{assignments.map((assignment) => <li key={assignment.id}><Link className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--border)] px-3 text-sm text-[var(--info)] hover:bg-[var(--raised)]" to={`/inspect/judge?teamId=${encodeURIComponent(teamId)}&judgeIdentityId=${encodeURIComponent(assignment.judge_identity_id)}`}>Inspect {assignment.judge_name}<ExternalLink size={14} /></Link></li>)}</ul> : <p className="text-sm text-[var(--muted)]">No active judge is assigned to this team.</p>}</CardContent></Card>
	</main>;
}
