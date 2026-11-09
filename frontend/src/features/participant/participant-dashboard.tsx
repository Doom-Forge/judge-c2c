import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { AlertCircle, ArrowUpRight, Clock3, FileText, GitPullRequest, UploadCloud, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
type UploadCandidate = Pick<File, "name" | "size" | "type">;
export function validateAnalysisDocument(file: UploadCandidate): string | null {
  if (file.size < 1 || file.size > MAX_DOCUMENT_BYTES) return "Choose a file up to 2 MB.";
  const extension = file.name.toLowerCase().split(".").pop();
  if (!((extension === "pdf" && (file.type === PDF || file.type === "")) ||
    (extension === "docx" && (file.type === DOCX || file.type === "")))) {
    return "Choose a PDF or DOCX file.";
  }
  return null;
}

type DocumentRecord = { id: string; version: number; filename: string; bytes: number; created_at: string };
type ParticipantPayload = {
  team: { id: string; name: string; status: string };
  track: { repositoryId: number; fullName: string } | null;
  members?: Array<{ displayName: string; email: string; githubLogin: string | null; githubLinked: boolean }>;
  currentMember?: { displayName: string; email: string; githubLogin: string | null; githubLinked: boolean } | null;
  githubLinked?: boolean;
  submissions: Array<{ repository_id: number; pr_number: number; status: string; github_updated_at: string; full_name: string }>;
  evaluations: Array<{ id: string; state: string; created_at: string }>;
};
type TrackOption = { repositoryId: number; fullName: string };
const challengeTracks = [
  { fullName: "180DC-VIT-CHENNAI/mazhai-cover", name: "Mazhai Cover", brief: "Micro-insurance pricing" },
  { fullName: "180DC-VIT-CHENNAI/pricingpulse", name: "PricingPulse", brief: "Dynamic pricing simulator" },
  { fullName: "180DC-VIT-CHENNAI/veera-footwear", name: "Veera Footwear", brief: "Borrowed-audience campaign" },
  { fullName: "180DC-VIT-CHENNAI/janus", name: "JANUS", brief: "Geospatial intelligence" },
] as const;
type Announcement = { id: string; title: string; body: string; createdAt: string };
type ReleasedFeedbackItem = { problemUnderstanding?: string; remediation?: string; innovationImpact?: string; overall?: string; criteriaScores?: Array<{ criterionId: string; comment: string }> };
type ReleasedFeedback = { analysis?: ReleasedFeedbackItem[]; engineering?: ReleasedFeedbackItem[] };
type ParticipantResult = { teamId: string; teamName: string; track: string | null; status: string; analysisAverage: number | null; analysisJudgeCount: number; engineeringAverage: number | null; engineeringJudgeCount: number; finalScore: number | null; feedback?: ReleasedFeedback };
type SharedStageScore = { stage: "ANALYSIS" | "ENGINEERING"; score: number; sharedAt: string };
type ParticipantDeadlines = {
  analysisDocumentDeadline: string | null;
  pullRequestDeadline: string | null;
} | null;
type LoadState = "loading" | "ready" | "empty" | "error";
type ParticipantView = "overview" | "submission" | "evaluation";
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(`/api/organization/participant${path}`, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Request failed (${response.status})`);
  return response.json() as Promise<T>;
}
function prettyDate(value: string) { return new Date(value).toLocaleString(); }
function bytesLabel(bytes: number) { return `${(bytes / 1024).toFixed(0)} KB`; }

function FeedbackList({ stage, items }: { stage: string; items: ReleasedFeedbackItem[] }) {
  const fields: Array<[keyof ReleasedFeedbackItem, string]> = [
    ["problemUnderstanding", "Problem understanding"],
    ["remediation", "Remediation"],
    ["innovationImpact", "Innovation impact"],
    ["overall", "Overall feedback"],
  ];
  const populated = items.map(item => ({ item, comments: fields.filter(([key]) => typeof item[key] === "string" && item[key]!.trim()) }));
  if (!populated.some(({ comments }) => comments.length || false) && !items.some(item => item.criteriaScores?.some(criterion => criterion.comment.trim()))) return null;
  return <section className="rounded-lg border border-[var(--border)] p-4"><h4 className="font-semibold">{stage} feedback</h4><ol className="mt-3 space-y-3">{populated.map(({ item, comments }, index) => <li className="border-t border-[var(--border)] pt-3" key={`${stage}-${index}`}>{comments.map(([key, label]) => <p className="mb-2 text-sm" key={key}><strong>{label}:</strong> {String(item[key] ?? "")}</p>)}{item.criteriaScores?.filter(criterion => criterion.comment.trim()).map(criterion => <p className="mb-2 text-sm" key={criterion.criterionId}><strong>{criterion.criterionId}:</strong> {criterion.comment}</p>)}</li>)}</ol></section>;
}

export function ParticipantDashboard({ view = "overview" }: { readonly view?: ParticipantView }) {
  const loadRequestId = useRef(0);
  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<ParticipantPayload | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [deadlines, setDeadlines] = useState<ParticipantDeadlines>(null);
  const [trackOptions, setTrackOptions] = useState<TrackOption[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [resultsUnavailable, setResultsUnavailable] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [trackBusy, setTrackBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [publishedResults, setPublishedResults] = useState<{ results: ParticipantResult[]; ranking: Array<{ teamId: string; rank: number }>; sharedStageScores: SharedStageScore[] } | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [announcementError, setAnnouncementError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linkingGithub, setLinkingGithub] = useState(false);
  const [githubLinked, setGithubLinked] = useState(false);
  const [githubUsername, setGithubUsername] = useState(() => sessionStorage.getItem("doomforge.participant-github-username") ?? "");

  async function load() {
    const requestId = ++loadRequestId.current;
    setState("loading");
    setResultsUnavailable(false);
    setAnnouncementError("");
    try {
      const [consoleData, documentData, trackData, results, announcementData] = await Promise.all([
        request<ParticipantPayload>(""),
        request<{ documents: DocumentRecord[]; deadlines: ParticipantDeadlines }>("/documents"),
        request<{ repositories: TrackOption[] }>("/track-options"),
        request<{ published: boolean; results?: ParticipantResult[]; ranking?: Array<{ teamId: string; rank: number }>; sharedStageScores?: SharedStageScore[] }>("/results").catch(() => null),
        fetch("/api/organization/announcements", { credentials: "same-origin" }).then(async response => {
          if (!response.ok) throw new Error(`Announcements unavailable (${response.status})`);
          return response.json() as Promise<{ announcements: Announcement[] }>;
        }).catch(cause => ({ announcements: [], error: cause instanceof Error ? cause.message : "Announcements are unavailable." })),
      ]);
      if (requestId !== loadRequestId.current) return;
      setData(consoleData);
      setSelectedRepositoryId(consoleData.track?.repositoryId ?? null);
      setDocuments(documentData.documents);
      setDeadlines(documentData.deadlines);
      setTrackOptions(trackData.repositories);
      setAnnouncements(announcementData.announcements);
      setAnnouncementError("error" in announcementData ? announcementData.error : "");
      setGithubLinked(consoleData.githubLinked === true || consoleData.currentMember?.githubLinked === true);
      setResultsUnavailable(results === null);
      setPublishedResults(results?.published === true ? {
        results: results.results ?? [],
        ranking: results.ranking ?? [],
        sharedStageScores: results.sharedStageScores ?? [],
      } : null);
      setState(consoleData.team && consoleData.team.status === "ACTIVE" ? "ready" : "empty");
    } catch (cause) {
      if (requestId !== loadRequestId.current) return;
      setError(cause instanceof Error ? cause.message : "Participant information is unavailable.");
      setState("error");
    }
  }
  useEffect(() => { void load(); }, []);

  async function upload(file: File) {
    const validation = validateAnalysisDocument(file);
    setUploadError(validation ?? "");
    if (validation) return;
    setUploading(true); setProgress(12);
    try {
      const form = new FormData(); form.append("file", file);
      setProgress(35);
      await request<{ document: DocumentRecord }>("/documents", { method: "POST", body: form });
      setProgress(100);
      const latest = await request<{ documents: DocumentRecord[] }>("/documents");
      setDocuments(latest.documents);
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setUploading(false);
      window.setTimeout(() => setProgress(0), 700);
    }
  }
  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void upload(file);
  }
  async function confirmTrackSelection() {
    const repositoryId = selectedRepositoryId;
    if (!repositoryId || !data) return;
    setTrackBusy(true); setError("");
    try {
      await request("/track", { method: "POST", body: JSON.stringify({ repositoryId }) });
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Track selection failed.";
      setError(message === "TRACK_LOCKED" ? "Repository changes are locked after engineering review starts." : message);
    } finally { setTrackBusy(false); }
  }

  async function linkGithub() {
    const username = githubUsername.trim().replace(/^@/, "");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(username)) {
      setLinkError("Enter a valid GitHub username first.");
      return;
    }
    sessionStorage.setItem("doomforge.participant-github-username", username);
    setLinkingGithub(true);
    setLinkError("");
    try {
      await request<{ linked: boolean; github: { login: string } }>("/github/link", { method: "POST", body: JSON.stringify({ login: username }) });
      setGithubLinked(true);
      sessionStorage.removeItem("doomforge.participant-github-username");
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "GitHub could not be linked.";
      setLinkError(message === "GITHUB_USERNAME_MISMATCH"
        ? `The signed-in GitHub account does not match @${username}. Sign in to the GitHub account you entered.`
        : message === "GITHUB_SESSION_REQUIRED"
          ? "Continue with GitHub first, then return here and verify your username."
          : message);
    } finally {
      setLinkingGithub(false);
    }
  }

  function beginGithubLink(event: MouseEvent<HTMLAnchorElement>) {
    const username = githubUsername.trim().replace(/^@/, "");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(username)) {
      event.preventDefault();
      setLinkError("Enter a valid GitHub username before continuing.");
      return;
    }
    sessionStorage.setItem("doomforge.participant-github-username", username);
    setLinkError("");
  }

  if (state === "loading") return <main className="page-content"><p role="status">Loading participant workspace…</p></main>;
  if (state === "error") return <main className="page-content"><Card><CardContent className="pt-5"><p role="alert"><AlertCircle className="mr-2 inline" />Participant workspace unavailable: {error}</p><Button className="mt-4" onClick={() => void load()}>Try again</Button></CardContent></Card></main>;
  if (state === "empty" || !data) return <main className="page-content"><Card><CardContent className="pt-5"><p>No active team workspace is available.</p></CardContent></Card></main>;

  const latestDocument = documents[0];
  const heading = view === "submission" ? "My submission" : view === "evaluation" ? "Evaluation" : `Welcome, ${data.team.name}`;
  return <main className="page-content space-y-5">
    {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
    <section className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="mb-2 text-xs uppercase tracking-[.16em] text-[var(--muted)]">Participant workspace</p><h1 className="text-3xl font-semibold">{heading}</h1><p className="mt-2 text-sm text-[var(--muted)]">{view === "submission" ? "Manage your team track, documents, and pull request activity." : view === "evaluation" ? "Follow published scores and judge feedback for your team." : "Your team’s engineering arena workspace and review status."}</p></div>
      <Badge tone="success">{data.team.status}</Badge>
    </section>
    {(view === "overview" || view === "submission") && <>
    <div className="grid gap-4 lg:grid-cols-3">
      <Card><CardHeader><div><CardTitle>Assigned track</CardTitle><CardDescription>Repository linked to this team</CardDescription></div><GitPullRequest className="text-[var(--accent)]" /></CardHeader><CardContent>
        {data.track ? <a className="font-medium text-[var(--info)]" href={`https://github.com/${data.track.fullName}`} target="_blank" rel="noreferrer">{data.track.fullName}<ArrowUpRight className="ml-1 inline size-4" /></a> : <p className="text-sm text-[var(--muted)]">No repository selected yet.</p>}
        <fieldset className="mt-5 min-w-0" disabled={trackBusy}>
          <legend className="mb-3 text-sm font-semibold">Choose your challenge repository</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {challengeTracks.map(challenge => {
              const repo = trackOptions.find(option => option.fullName.toLowerCase() === challenge.fullName.toLowerCase());
              const selected = repo !== undefined && selectedRepositoryId === repo.repositoryId;
              const current = repo !== undefined && data.track?.repositoryId === repo.repositoryId;
              return <div key={challenge.fullName} className={`min-w-0 rounded-lg border p-3 ${selected ? "border-[var(--accent)] bg-[var(--raised)]" : "border-[var(--border)]"}`}>
                <button type="button" aria-pressed={selected} disabled={!repo} onClick={() => repo && setSelectedRepositoryId(repo.repositoryId)} className="flex min-h-11 w-full items-start justify-between gap-3 text-left disabled:cursor-not-allowed disabled:opacity-60">
                  <span className="min-w-0"><span className="block font-semibold">{challenge.name}</span><span className="mt-1 block text-xs text-[var(--muted)]">{challenge.brief}</span></span>
                  <span className="shrink-0 text-xs text-[var(--muted)]">{!repo ? "Unavailable" : current ? "Current" : selected ? "Selected" : "Select"}</span>
                </button>
                {repo ? <a className="mt-2 inline-flex min-h-11 max-w-full items-center break-all text-xs text-[var(--info)] underline-offset-2 hover:underline" href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer" aria-label={`${challenge.name} GitHub repository`}>{repo.fullName}<ArrowUpRight className="ml-1 size-3 shrink-0" /></a> : <p className="mt-2 text-xs text-[var(--muted)]">This challenge repository is not currently available.</p>}
              </div>;
            })}
          </div>
          <Button className="mt-4 w-full sm:w-auto" disabled={trackBusy || selectedRepositoryId === null || selectedRepositoryId === data.track?.repositoryId || !trackOptions.some(option => option.repositoryId === selectedRepositoryId)} onClick={() => void confirmTrackSelection()}>{trackBusy ? "Saving selection…" : data.track ? "Confirm repository change" : "Confirm repository"}</Button>
        </fieldset>
      </CardContent></Card>
      <Card><CardHeader><div><CardTitle>Requirements</CardTitle><CardDescription>Round 2 submission checklist</CardDescription></div><FileText className="text-[var(--accent)]" /></CardHeader><CardContent><ul className="space-y-3 text-sm"><li>Analysis document: PDF or DOCX, up to 2 MB</li><li>Engineering work submitted through pull requests</li><li>Keep your analysis findings, fixes, and proposed features clear</li></ul></CardContent></Card>
      <Card><CardHeader><div><CardTitle>Deadlines</CardTitle><CardDescription>Competition schedule</CardDescription></div><Clock3 className="text-[var(--accent)]" /></CardHeader><CardContent>{deadlines && (deadlines.analysisDocumentDeadline || deadlines.pullRequestDeadline) ? <dl className="space-y-3 text-sm">{deadlines.analysisDocumentDeadline && <div><dt className="text-[var(--muted)]">Analysis document</dt><dd>{prettyDate(deadlines.analysisDocumentDeadline)}</dd></div>}{deadlines.pullRequestDeadline && <div><dt className="text-[var(--muted)]">Pull request</dt><dd>{prettyDate(deadlines.pullRequestDeadline)}</dd></div>}</dl> : <p className="text-sm text-[var(--muted)]">No deadlines have been set.</p>}</CardContent></Card>
    </div>
    {view === "overview" && <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><div><CardTitle>Team members</CardTitle><CardDescription>Roster connected to this team workspace</CardDescription></div><Users className="text-[var(--accent)]" /></CardHeader><CardContent>{data.members?.length ? <ul className="space-y-3">{data.members.map(member => <li className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3 text-sm" key={member.email}><span><strong>{member.displayName}</strong><small className="ml-2 text-[var(--muted)]">{member.email}</small></span><span className="text-xs text-[var(--muted)]">{member.githubLogin ? `@${member.githubLogin}` : "GitHub not linked"}</span></li>)}</ul> : <p className="text-sm text-[var(--muted)]">No member roster is available yet.</p>}</CardContent></Card>
      <Card><CardHeader><div><CardTitle>GitHub account</CardTitle><CardDescription>Enter the username you use for the competition</CardDescription></div><GitPullRequest className="text-[var(--accent)]" /></CardHeader><CardContent>{githubLinked ? <p className="text-sm" role="status">GitHub account @{data.currentMember?.githubLogin ?? data.members?.find(member => member.githubLinked)?.githubLogin ?? "linked"} is linked.</p> : <><label className="mb-2 block text-sm font-medium" htmlFor="participant-github-username">GitHub username</label><input autoComplete="username" className="mb-3 block w-full rounded-md border border-[var(--border)] bg-[var(--background)] p-2" id="participant-github-username" onChange={event => { setGithubUsername(event.currentTarget.value); setLinkError(""); }} placeholder="e.g. octocat" value={githubUsername} /><p className="mb-3 text-sm text-[var(--muted)]">Continue with GitHub, then return here to verify that the signed-in account matches this username.</p><a className="mr-4 inline-flex min-h-11 items-center text-sm text-[var(--info)]" href="/api/auth/github" onClick={beginGithubLink}>Continue with GitHub <ArrowUpRight className="ml-1 inline size-4" /></a><Button disabled={linkingGithub} onClick={() => void linkGithub()}>{linkingGithub ? "Verifying…" : "Verify username"}</Button>{linkError && <p className="mt-2 text-sm text-[var(--error)]" role="alert">{linkError}</p>}</>}</CardContent></Card>
    </div>}
    {view === "overview" && <Card><CardHeader><div><CardTitle>Announcements</CardTitle><CardDescription>Updates from competition organizers</CardDescription></div><Clock3 className="text-[var(--accent)]" /></CardHeader><CardContent>{announcementError ? <p className="text-sm text-[var(--error)]" role="alert">{announcementError}</p> : announcements.length ? <ol className="space-y-4">{announcements.map(item => <li className="border-t border-[var(--border)] pt-3" key={item.id}><h3 className="font-semibold">{item.title}</h3><time className="text-xs text-[var(--muted)]">{prettyDate(item.createdAt)}</time><p className="mt-2 whitespace-pre-wrap text-sm">{item.body}</p></li>)}</ol> : <p className="text-sm text-[var(--muted)]">No announcements have been posted.</p>}</CardContent></Card>}
    </>}
    {view === "submission" && <>
    <Card><CardHeader><div><CardTitle>Analysis document</CardTitle><CardDescription>Private to your team and authorized reviewers. Replacement keeps prior versions.</CardDescription></div><Badge tone={latestDocument ? "success" : "warning"}>{latestDocument ? "Submitted" : "Needed"}</Badge></CardHeader><CardContent>
      {latestDocument ? <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--raised)] p-4"><div><strong>{latestDocument.filename}</strong><p className="mt-1 text-xs text-[var(--muted)]">Version {latestDocument.version} · {bytesLabel(latestDocument.bytes)} · {prettyDate(latestDocument.created_at)}</p></div><a className="text-sm text-[var(--info)]" href={`/api/organization/participant/documents/${latestDocument.id}`}>Download current</a></div> : <p className="mb-4 text-sm text-[var(--muted)]">No analysis document submitted yet.</p>}
      <label className={`flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-5 text-center ${dragging ? "border-[var(--accent)] bg-[var(--raised)]" : "border-[var(--border)]"}`} onDragEnter={event => { event.preventDefault(); setDragging(true); }} onDragOver={event => event.preventDefault()} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={onDrop}><UploadCloud className="mb-2 text-[var(--accent)]" /><span className="font-medium">{dragging ? "Drop analysis document" : latestDocument ? "Choose or drop replacement document" : "Choose or drop analysis document"}</span><span className="mt-1 text-xs text-[var(--muted)]">PDF or DOCX · maximum 2 MB</span><input aria-label="Analysis document file" className="sr-only" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={uploading} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void upload(file); event.currentTarget.value = ""; }} /></label>
      {uploading && <div className="mt-3" role="status"><p className="mb-2 text-xs">Uploading…</p><Progress aria-label="Upload progress" value={progress} /></div>}{uploadError && <p className="mt-3 text-sm text-[var(--error)]" role="alert">{uploadError}</p>}
      <h3 className="mb-2 mt-5 text-sm font-semibold">Version history</h3>{documents.length ? <ol className="space-y-2">{documents.map(document => <li className="flex justify-between gap-3 border-t border-[var(--border)] py-3 text-sm" key={document.id}><span>v{document.version} · {document.filename}<small className="ml-2 text-[var(--muted)]">{prettyDate(document.created_at)}</small></span><a className="text-[var(--info)]" href={`/api/organization/participant/documents/${document.id}`}>Download</a></li>)}</ol> : <p className="text-xs text-[var(--muted)]">Uploaded versions will appear here.</p>}
    </CardContent></Card>
    <Card><CardHeader><div><CardTitle>Pull request activity</CardTitle><CardDescription>Latest repository activity and evaluation progress</CardDescription></div><GitPullRequest className="text-[var(--accent)]" /></CardHeader><CardContent>
      {data.submissions.length ? <ol className="space-y-3">{data.submissions.map(pr => <li key={`${pr.repository_id}-${pr.pr_number}`} className="flex flex-wrap items-center justify-between gap-4 border-t border-[var(--border)] pt-3"><div><a className="font-semibold text-[var(--info)]" href={`https://github.com/${pr.full_name}/pull/${pr.pr_number}`} target="_blank" rel="noreferrer">{pr.full_name} #{pr.pr_number}<ArrowUpRight className="ml-1 inline size-4" /></a><p className="text-xs text-[var(--muted)]">updated {prettyDate(pr.github_updated_at)}</p></div><Badge tone={pr.status === "COMPLETED" ? "success" : "info"}>{pr.status}</Badge></li>)}</ol> : <p className="text-sm text-[var(--muted)]">No pull requests have been recorded yet.</p>}
      <p className="mt-4 text-xs text-[var(--muted)]">{data.evaluations.length} evaluation record{data.evaluations.length === 1 ? "" : "s"} · CI and review checks appear with tracked pull requests.</p>
    </CardContent></Card>
    </>}
    {view === "evaluation" && <>
    <Card><CardHeader><div><CardTitle>Feedback and results</CardTitle><CardDescription>Visible only after organizers publish participant results</CardDescription></div><Badge tone={resultsUnavailable ? "neutral" : publishedResults ? "success" : "neutral"}>{resultsUnavailable ? "Unavailable" : publishedResults ? "Released" : "Not released"}</Badge></CardHeader><CardContent>{resultsUnavailable ? <p className="text-sm text-[var(--muted)]" role="status">Results are temporarily unavailable.</p> : publishedResults ? <>
      {(() => { const result = publishedResults.results.find(item => item.teamId === data.team.id); const ranking = publishedResults.ranking.find(item => item.teamId === data.team.id); return result ? <div className="space-y-4"><p className="flex flex-wrap items-end gap-3"><strong className="text-3xl font-semibold">{result.finalScore === null ? "Pending" : result.finalScore.toFixed(1)}</strong><span className="text-sm text-[var(--muted)]">final score</span>{ranking && <span className="text-lg">Rank #{ranking.rank}</span>}</p><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-xs uppercase text-[var(--muted)]">Analysis average</dt><dd>{result.analysisAverage?.toFixed(1) ?? "—"} · {result.analysisJudgeCount} judge{result.analysisJudgeCount === 1 ? "" : "s"}</dd></div><div><dt className="text-xs uppercase text-[var(--muted)]">Engineering average</dt><dd>{result.engineeringAverage?.toFixed(1) ?? "—"} · {result.engineeringJudgeCount} judge{result.engineeringJudgeCount === 1 ? "" : "s"}</dd></div><div><dt className="text-xs uppercase text-[var(--muted)]">Track</dt><dd>{result.track ?? "Not selected"}</dd></div><div><dt className="text-xs uppercase text-[var(--muted)]">Publication status</dt><dd>{result.status}</dd></div></dl><FeedbackList stage="Analysis" items={result.feedback?.analysis ?? []} /><FeedbackList stage="Engineering" items={result.feedback?.engineering ?? []} /></div> : <p className="text-sm text-[var(--muted)]">Published results do not include a score for this team yet.</p>; })()}
      <section className="rounded-lg border border-[var(--border)] bg-[var(--raised)] p-4" aria-labelledby="judge-shared-scores"><h3 id="judge-shared-scores" className="font-semibold">Judge-shared stage scores</h3><p className="mt-1 text-xs text-[var(--muted)]">These scores are shown only when a judge chooses to share them and the published results include that exact review.</p>{publishedResults.sharedStageScores.length ? <ul className="mt-3 grid gap-2 sm:grid-cols-2">{publishedResults.sharedStageScores.map((item, index) => <li className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2" key={`${item.stage}-${item.sharedAt}-${index}`}><span className="text-sm">{item.stage === "ANALYSIS" ? "Analysis" : "Engineering"} review</span><strong>{item.score}</strong></li>)}</ul> : <p className="mt-3 text-sm text-[var(--muted)]">No judge has chosen to share an individual stage score.</p>}</section>
      </> : <p className="text-sm text-[var(--muted)]">Feedback and results have not been released to participants.</p>}</CardContent></Card>
    </>}
  </main>;
}
