import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createAssignment, createIdentity, getGitHubStatus, getIdentities, getRepositories, getRubric, getTeams, getJudgeAssignments, publishRubric, revokeAssignment, revokeIdentity, syncRepositories, type ConsoleIdentity, type JudgeAssignment, type RepositoryRecord, type RubricCriterion, type TeamRecord } from "./command-center/api";

function ErrorLine({ children }: { children: string }) { return <p className="text-sm text-[var(--error)]" role="alert">{children}</p>; }

async function loadAllTeams() {
	const teams: TeamRecord[] = [];
	let cursor: string | undefined;
	const seen = new Set<string>();
	do {
		const page = await getTeams(cursor);
		teams.push(...page.teams);
		cursor = page.nextCursor ?? undefined;
		if (cursor && seen.has(cursor)) throw new Error("Team list pagination did not advance.");
		if (cursor) seen.add(cursor);
	} while (cursor);
	return teams;
}

export function GitHubConnectionPanel() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getGitHubStatus>> | null>(null);
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function load() {
    setError("");
    try {
      const [nextStatus, nextRepos] = await Promise.all([getGitHubStatus(), getRepositories()]);
      setStatus(nextStatus);
      setRepositories(nextRepos.repositories);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "GitHub settings are unavailable."); }
  }
  useEffect(() => { void load(); }, []);
  async function sync() {
    setBusy(true); setError(""); setMessage("");
    try { const result = await syncRepositories(); setMessage(`Synced ${result.count} accessible repositories.`); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Repository sync failed."); }
    finally { setBusy(false); }
  }
  return <Card id="organizer-github"><CardHeader><div><CardTitle>GitHub connection</CardTitle><CardDescription>Installation state and repositories returned by the organization API</CardDescription></div></CardHeader><CardContent className="space-y-3">
    {error && <ErrorLine>{error}</ErrorLine>}
    {status === null ? <p role="status">Loading GitHub connection…</p> : !status.app ? <p>No GitHub App is configured.</p> : <><p>App <strong>{status.app.slug}</strong> · installation {status.app.installationId ?? "not installed"}</p>{status.app.installationId === null && <a className="text-[var(--info)]" href={status.app.installUrl}>Manage GitHub App installation</a>}</>}
    <div className="flex flex-wrap items-center gap-3"><Button disabled={busy || status?.app?.installationId == null} onClick={() => void sync()}>{busy ? "Syncing…" : "Sync repositories"}</Button><span className="text-sm text-[var(--muted)]">{repositories.length} repositories returned by the service</span></div>
    {message && <p role="status">{message}</p>}
    {repositories.length ? <ul className="grid gap-2 sm:grid-cols-2">{repositories.map(repo => <li key={repo.id}>{repo.full_name} · {repo.accessible ? "Accessible" : "Unavailable"} · default {repo.default_branch}</li>)}</ul> : status?.app?.installationId ? <p>No repositories are available in the synchronized installation.</p> : null}
  </CardContent></Card>;
}

export function JudgeAdministrationPanel() {
  const [identities, setIdentities] = useState<ConsoleIdentity[]>([]);
  const [assignments, setAssignments] = useState<JudgeAssignment[]>([]);
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [name, setName] = useState("");
  const [judgeId, setJudgeId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [credential, setCredential] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
		const [nextIdentities, nextAssignments, allTeams] = await Promise.all([getIdentities(), getJudgeAssignments(), loadAllTeams()]);
      setIdentities(nextIdentities.identities);
      setAssignments(nextAssignments.assignments);
		setTeams(allTeams);
      if (!judgeId) setJudgeId(nextIdentities.identities.find(item => item.role === "judge" && !item.revoked_at)?.id ?? "");
		if (!teamId) setTeamId(allTeams.find(item => item.status === "ACTIVE")?.id ?? "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Judge administration is unavailable."); }
  }
  useEffect(() => { void load(); }, []);
  async function createJudge(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { const created = await createIdentity({ name: name.trim(), role: "judge" }); setCredential(created.credential); setName(""); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Judge identity could not be created."); }
    finally { setBusy(false); }
  }
  async function assign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await createAssignment({ judgeIdentityId: judgeId, teamId }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Assignment could not be created."); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError("");
    try { await revokeAssignment(id); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Assignment could not be revoked."); }
    finally { setBusy(false); }
  }
  async function revokeJudge(id: string) {
    if (!window.confirm("Revoke this judge identity? Existing review history remains stored.")) return;
    setBusy(true); setError("");
    try { await revokeIdentity(id); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Judge identity could not be revoked."); }
    finally { setBusy(false); }
  }
  const activeJudges = identities.filter(item => item.role === "judge" && !item.revoked_at);
  return <Card id="organizer-assignments"><CardHeader><div><CardTitle>Judges and assignments</CardTitle><CardDescription>Create judge credentials, assign active teams, and revoke assignments with the organization API</CardDescription></div></CardHeader><CardContent className="space-y-5">
    {error && <ErrorLine>{error}</ErrorLine>}
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => void createJudge(event)}><label className="grid gap-1 text-sm">Judge name<input required value={name} onChange={event => setName(event.currentTarget.value)} /></label><Button disabled={busy || !name.trim()}>Create judge</Button></form>
    {credential && <div className="rounded border border-[var(--border)] p-3"><strong>One-time judge access code</strong><p className="break-all font-mono">{credential}</p><p className="text-sm text-[var(--muted)]">Copy and share this code securely; the API returns it only when the identity is created.</p><Button onClick={() => void navigator.clipboard?.writeText(credential)}>Copy code</Button></div>}
    <ul className="space-y-2">{activeJudges.map(judge => <li className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-2" key={judge.id}><span>{judge.name}</span><Button disabled={busy} variant="secondary" onClick={() => void revokeJudge(judge.id)}>Revoke judge</Button></li>)}</ul>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => void assign(event)}><label className="grid gap-1 text-sm">Judge<select required value={judgeId} onChange={event => setJudgeId(event.currentTarget.value)}><option value="">Select judge</option>{activeJudges.map(judge => <option key={judge.id} value={judge.id}>{judge.name}</option>)}</select></label><label className="grid gap-1 text-sm">Active team<select required value={teamId} onChange={event => setTeamId(event.currentTarget.value)}><option value="">Select team</option>{teams.filter(team => team.status === "ACTIVE").map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><Button disabled={busy || !judgeId || !teamId}>Assign team</Button></form>
    {assignments.length ? <ul className="space-y-2">{assignments.map(item => <li className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-2" key={item.id}><span>{item.judge_name} → {item.team_name} · {item.revoked_at ? "Revoked" : "Active"}</span>{!item.revoked_at && <Button disabled={busy} variant="secondary" onClick={() => void revoke(item.id)}>Revoke assignment</Button>}</li>)}</ul> : <p>No judge assignments are recorded.</p>}
  </CardContent></Card>;
}

export function RubricManagementPanel() {
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [criteria, setCriteria] = useState<RubricCriterion[]>([]);
  const [history, setHistory] = useState<Array<{ id: string; version: number; criteria: RubricCriterion[]; created_at: string }>>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getRepositories().then(result => setRepositories(result.repositories)).catch(cause => setError(cause instanceof Error ? cause.message : "Repositories unavailable.")); }, []);
  useEffect(() => {
    if (!repositoryId) { setCriteria([]); setHistory([]); return; }
    void getRubric(Number(repositoryId)).then(result => { setCriteria(result.active?.criteria ?? []); setHistory(result.versions); setError(""); }).catch(cause => setError(cause instanceof Error ? cause.message : "Rubric unavailable."));
  }, [repositoryId]);
  function update(index: number, field: keyof RubricCriterion, value: string) { setCriteria(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: field === "weight" ? Number(value) : value } : item)); }
  async function publish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
		if (!repositoryId || criteria.length === 0 || new Set(criteria.map(item => item.id)).size !== criteria.length || criteria.some(item => !item.id || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(item.id) || !item.label.trim() || !Number.isInteger(item.weight) || item.weight < 1) || criteria.reduce((sum, item) => sum + item.weight, 0) !== 100) { setError("Use unique lowercase criterion IDs, nonempty labels, positive whole-number weights, and a total weight of 100."); return; }
    setBusy(true); setError(""); setMessage("");
    try { const result = await publishRubric(Number(repositoryId), criteria); setMessage(`Published rubric version ${result.rubric.version}. Prior versions remain available.`); const next = await getRubric(Number(repositoryId)); setCriteria(next.active?.criteria ?? []); setHistory(next.versions); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Rubric could not be published."); }
    finally { setBusy(false); }
  }
  return <Card id="organizer-rubrics"><CardHeader><div><CardTitle>Track rubrics</CardTitle><CardDescription>Edit and publish versioned criteria for a synchronized repository; no default rubric is assumed.</CardDescription></div></CardHeader><CardContent className="space-y-3">
    {error && <ErrorLine>{error}</ErrorLine>}{message && <p role="status">{message}</p>}
    <label className="grid max-w-sm gap-1 text-sm">Repository<select value={repositoryId} onChange={event => setRepositoryId(event.currentTarget.value)}><option value="">Select repository</option>{repositories.filter(item => item.accessible).map(item => <option key={item.id} value={item.id}>{item.full_name}</option>)}</select></label>
		{repositoryId && <form className="space-y-3" onSubmit={event => void publish(event)}><div className="flex flex-wrap gap-3">{criteria.map((item, index) => <fieldset className="grid min-w-56 gap-2 rounded border border-[var(--border)] p-3" key={`${item.id}-${index}`}><legend>{item.id}</legend><label className="grid gap-1 text-sm">Criterion ID<input required value={item.id} onChange={event => update(index, "id", event.currentTarget.value)} /></label><label className="grid gap-1 text-sm">Label<input required value={item.label} onChange={event => update(index, "label", event.currentTarget.value)} /></label><label className="grid gap-1 text-sm">Weight<input required type="number" min="1" max="100" value={item.weight} onChange={event => update(index, "weight", event.currentTarget.value)} /></label><Button type="button" variant="secondary" onClick={() => setCriteria(current => current.filter((_, itemIndex) => itemIndex !== index))}>Remove criterion</Button></fieldset>)}</div><p>Total weight: {criteria.reduce((sum, item) => sum + item.weight, 0)} / 100</p><div className="flex gap-2"><Button type="button" variant="secondary" onClick={() => setCriteria(current => { let number = current.length + 1; while (current.some(item => item.id === `criterion-${number}`)) number++; return [...current, { id: `criterion-${number}`, label: "", weight: 1 }]; })}>Add criterion</Button><Button disabled={busy}>{busy ? "Publishing…" : "Publish new rubric version"}</Button></div></form>}
    {history.length > 0 && <details><summary>Version history ({history.length})</summary><ol>{history.map(item => <li key={item.id}>v{item.version} · {new Date(item.created_at).toLocaleString()} · {item.criteria.length} criteria</li>)}</ol></details>}
  </CardContent></Card>;
}

export function OrganizerAnnouncementsPanel() {
  const [items, setItems] = useState<Array<{ id: string; title: string; body: string; createdAt: string }>>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    const response = await fetch("/api/organization/announcements", { credentials: "same-origin" });
    const payload = await response.json() as { announcements?: typeof items; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Announcements unavailable (${response.status})`);
    setItems(payload.announcements ?? []);
  }
  useEffect(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "Announcements unavailable.")); }, []);
  async function publish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/organization/announcements", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Announcement publish failed (${response.status})`);
      setTitle(""); setBody(""); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Announcement could not be published."); }
    finally { setBusy(false); }
  }
  return <Card id="organizer-announcements"><CardHeader><div><CardTitle>Announcements</CardTitle><CardDescription>Publish competition updates for participant dashboards</CardDescription></div></CardHeader><CardContent className="space-y-4">
    {error && <ErrorLine>{error}</ErrorLine>}
    <form className="grid gap-3" onSubmit={event => void publish(event)}><label className="grid gap-1 text-sm">Title<input required maxLength={160} value={title} onChange={event => setTitle(event.currentTarget.value)} /></label><label className="grid gap-1 text-sm">Announcement<textarea required maxLength={5000} rows={4} value={body} onChange={event => setBody(event.currentTarget.value)} /></label><Button disabled={busy || !title.trim() || !body.trim()}>{busy ? "Publishing…" : "Publish announcement"}</Button></form>
    {items.length ? <ol className="space-y-3">{items.map(item => <li className="border-t border-[var(--border)] pt-3" key={item.id}><h3 className="font-semibold">{item.title}</h3><time className="text-xs text-[var(--muted)]">{new Date(item.createdAt).toLocaleString()}</time><p className="mt-2 whitespace-pre-wrap text-sm">{item.body}</p></li>)}</ol> : <p>No announcements have been published.</p>}
  </CardContent></Card>;
}
