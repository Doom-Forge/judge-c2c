import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createAssignment, createIdentity, getGitHubStatus, getIdentities, getRepositories, getRubric, getTeams, getJudgeAssignments, publishRubric, revokeAssignment, revokeIdentity, startGitHubAppRegistration, syncRepositories, rubricCategories, type ConsoleIdentity, type JudgeAssignment, type RepositoryRecord, type RubricCategory, type RubricCriterion, type TeamRecord } from "./command-center/api";

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
  const [registeringOrganization, setRegisteringOrganization] = useState("");
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
  async function registerApp(organization: string) {
    setRegisteringOrganization(organization); setError("");
    try {
      const registration = await startGitHubAppRegistration(organization);
      const form = document.createElement("form");
      form.method = "POST";
      form.action = registration.action;
      const manifest = document.createElement("input");
      manifest.type = "hidden";
      manifest.name = "manifest";
      manifest.value = JSON.stringify(registration.manifest);
      form.append(manifest);
      document.body.append(form);
      form.submit();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub App registration could not be started.");
      setRegisteringOrganization("");
    }
  }
  const activeOrganization = status?.organization ?? "Doom-Forge";
  const connections = status?.connections ?? (status?.app ? [{
    organization: activeOrganization,
    id: status.app.id,
    slug: status.app.slug,
    installationId: status.app.installationId,
    suspended: status.app.suspended,
    installUrl: status.app.installUrl,
  }] : []);
  const activeConnection = connections.find(item => item.organization.toLowerCase() === activeOrganization.toLowerCase());
  const activeInstallationSuspended = activeConnection?.suspended === true;
  const supportedOrganizations = [
    { name: "Doom-Forge", flag: status?.organizationSelection?.doomForge },
    { name: "180DC-VIT-CHENNAI", flag: status?.organizationSelection?.vitc },
  ];
  const organizations = status?.organizationSelection
    ? supportedOrganizations
    : [{ name: activeOrganization, flag: undefined }];
  return <Card id="organizer-github"><CardHeader><div><CardTitle>GitHub connection</CardTitle><CardDescription>Check the App installation and the four authorized challenge repositories.</CardDescription></div></CardHeader><CardContent className="github-panel-content">
    {error && <ErrorLine>{error}</ErrorLine>}
    {status === null ? <p role="status">Loading GitHub connections…</p> : <>
      {status.organizationSelection && <div className="github-sync-row"><span>Active GitHub organization: <strong>{activeOrganization}</strong></span></div>}
      <ul aria-label="GitHub organization connections" className="github-repository-list">{organizations.map(({ name, flag }) => {
        const connection = connections.find(item => item.organization.toLowerCase() === name.toLowerCase());
        const active = name.toLowerCase() === activeOrganization.toLowerCase();
        return <li className="github-repository-card" key={name}>
          <div className="github-repository-heading"><strong>{name}</strong><Badge tone={active ? "success" : "info"}>{status.organizationSelection ? `${name === "Doom-Forge" ? "USE_DOOMFORGE_ORG" : "USE_180DC_ORG"}=${flag ? "true" : "false"}` : active ? "Current organization" : "Available organization"}</Badge></div>
          {connection ? <div className="github-connection-state">
            <div className="github-connection-heading"><span><strong>GitHub App</strong><small>{connection.slug}</small></span><Badge tone={connection.suspended ? "danger" : connection.installationId === null ? "warning" : "success"}>{connection.suspended ? "Suspended" : connection.installationId === null ? "Installation needed" : "Connected"}</Badge></div>
            <dl className="github-connection-details"><div><dt>App</dt><dd>{connection.slug}</dd></div><div><dt>Installation ID</dt><dd>{connection.installationId ?? "Not installed"}</dd></div></dl>
            {connection.installationId === null && <a className="github-install-link" href={connection.installUrl}>Manage GitHub App installation</a>}
          </div> : <div className="github-connection-state" role="status"><Badge tone="warning">Not configured</Badge><p>Register a GitHub App for this organization to enable its connection.</p><Button disabled={registeringOrganization !== ""} onClick={() => void registerApp(name)}>{registeringOrganization === name ? "Opening GitHub…" : "Register GitHub App"}</Button></div>}
        </li>;
      })}</ul>
    </>}
    <div className="github-sync-row"><Button disabled={busy || activeConnection?.installationId == null || activeInstallationSuspended} onClick={() => void sync()}>{busy ? "Syncing repositories…" : "Sync repositories"}</Button><span>{repositories.length} repositories synced</span></div>
    {activeInstallationSuspended && <ErrorLine>The active organization’s GitHub App installation is suspended. Resume it in GitHub before syncing repositories.</ErrorLine>}
    {message && <p className="github-feedback github-feedback-success" role="status">{message}</p>}
    {repositories.length ? <ul aria-label="Authorized GitHub repositories" className="github-repository-list">{repositories.map(repo => <li className="github-repository-card" key={repo.id}>
      <div className="github-repository-heading"><strong>{repo.full_name}</strong><Badge tone={repo.accessible ? "success" : "danger"}>{repo.accessible ? "Accessible" : "Unavailable"}</Badge></div>
      <dl><div><dt>Default branch</dt><dd><code>{repo.default_branch || "Not reported"}</code></dd></div><div><dt>Visibility</dt><dd>{repo.private ? "Private" : "Public"}</dd></div></dl>
    </li>)}</ul> : status?.app?.installationId ? <p className="github-empty-state">No repositories have been synchronized yet. Sync to check the four authorized challenge repositories.</p> : null}
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
  const activeTeams = teams.filter(team => team.status === "ACTIVE");
  return <Card id="organizer-assignments"><CardHeader><div><CardTitle>Judges and assignments</CardTitle><CardDescription>Create judge credentials, assign active teams, and revoke assignments with the organization API</CardDescription><p className="admin-panel-marking-note">Assigned judges enter marks in Review workspace after signing in with their judge access code.</p></div></CardHeader><CardContent className="space-y-5">
    {error && <ErrorLine>{error}</ErrorLine>}
    <form className="admin-panel-form" onSubmit={event => void createJudge(event)}><label className="admin-panel-field">Judge name<input autoComplete="name" required value={name} onChange={event => setName(event.currentTarget.value)} /><small>Use the name the judge will recognize when signing in.</small></label><div className="admin-panel-submit"><Button disabled={busy || !name.trim()}>{busy ? "Creating judge…" : "Create judge"}</Button>{!name.trim() && <small>Enter a name to enable this action.</small>}</div></form>
    {credential && <div className="rounded border border-[var(--border)] p-3"><strong>One-time judge access code</strong><p className="break-all font-mono">{credential}</p><p className="text-sm text-[var(--muted)]">Copy and share this code securely; the API returns it only when the identity is created.</p><Button onClick={() => void navigator.clipboard?.writeText(credential)}>Copy code</Button></div>}
    {activeJudges.length ? <ul className="admin-panel-identity-list">{activeJudges.map(judge => <li key={judge.id}><span><strong>{judge.name}</strong><small>Active judge</small></span><Button disabled={busy} variant="secondary" onClick={() => void revokeJudge(judge.id)}>Revoke judge</Button></li>)}</ul> : <p className="admin-panel-empty">No active judges yet. Create a judge above to enable team assignments.</p>}
    <form className="admin-panel-form admin-panel-form-assignment" onSubmit={event => void assign(event)}><label className="admin-panel-field">Judge<select aria-label="Judge" required value={judgeId} onChange={event => setJudgeId(event.currentTarget.value)}><option value="">Select judge</option>{activeJudges.map(judge => <option key={judge.id} value={judge.id}>{judge.name}</option>)}</select><small>Only active judges can receive assignments.</small></label><label className="admin-panel-field">Active team<select aria-label="Active team" required value={teamId} onChange={event => setTeamId(event.currentTarget.value)}><option value="">Select team</option>{activeTeams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select><small>Choose an active team to add it to this judge’s queue.</small></label><div className="admin-panel-submit"><Button disabled={busy || !judgeId || !teamId}>{busy ? "Assigning…" : "Assign team"}</Button>{activeJudges.length === 0 ? <small>Create an active judge above before assigning a team.</small> : activeTeams.length === 0 ? <small>No active teams are available to assign.</small> : (!judgeId || !teamId) && <small>Select a judge and an active team to enable this action.</small>}</div></form>
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
  function update(index: number, field: "id" | "label" | "weight" | "category", value: string) {
    setCriteria(current => current.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      if (field === "weight") return { ...item, weight: Number(value) };
      if (field === "category") {
        if (!value) {
          const { category: _category, ...withoutCategory } = item;
          return withoutCategory;
        }
        return { ...item, category: value as RubricCategory };
      }
      return { ...item, [field]: value };
    }));
  }
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
		{repositoryId && <form className="space-y-3" onSubmit={event => void publish(event)}><div className="flex flex-wrap gap-3">{criteria.map((item, index) => <fieldset className="grid min-w-56 gap-2 rounded border border-[var(--border)] p-3" key={`${item.id}-${index}`}><legend>{item.id}</legend><label className="grid gap-1 text-sm">Criterion ID<input required value={item.id} onChange={event => update(index, "id", event.currentTarget.value)} /></label><label className="grid gap-1 text-sm">Label<input required value={item.label} onChange={event => update(index, "label", event.currentTarget.value)} /></label><label className="grid gap-1 text-sm">Weight<input required type="number" min="1" max="100" value={item.weight} onChange={event => update(index, "weight", event.currentTarget.value)} /></label><label className="grid gap-1 text-sm">Category (optional)<select value={item.category ?? ""} onChange={event => update(index, "category", event.currentTarget.value)}><option value="">No category selected</option>{rubricCategories.map(category => <option key={category} value={category}>{category}</option>)}</select></label>{item.category && <p className="text-xs text-[var(--muted)]">Current category: {item.category}</p>}<Button type="button" variant="secondary" onClick={() => setCriteria(current => current.filter((_, itemIndex) => itemIndex !== index))}>Remove criterion</Button></fieldset>)}</div><p>Total weight: {criteria.reduce((sum, item) => sum + item.weight, 0)} / 100</p><div className="flex gap-2"><Button type="button" variant="secondary" onClick={() => setCriteria(current => { let number = current.length + 1; while (current.some(item => item.id === `criterion-${number}`)) number++; return [...current, { id: `criterion-${number}`, label: "", weight: 1 }]; })}>Add criterion</Button><Button disabled={busy}>{busy ? "Publishing…" : "Publish new rubric version"}</Button></div></form>}
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
