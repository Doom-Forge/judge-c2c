# Operations and readiness

## Live dashboard routing (2026-11-08)

`https://doombot.180dcvitc.org` is the canonical dashboard on Worker
`doomforge-arena`. Arena continues to own OAuth, teams, judge assignments,
webhooks, queues and its D1 database. Its server-side `MATRIX_BACKEND` binding
forwards `/api/organization/*`, `/auth/github/*` and `/webhooks/organization`
to `doomforge-matrix` while preserving the browser request. The browser receives
no Matrix bearer token. The Matrix Worker remains the service backend and serves
its direct worker hostname for operations; do not move the custom domain onto it.
The existing DoomBot App webhook still targets the Matrix Worker, and that exact
legacy worker origin remains allowlisted while webhook configuration stays put.

Build and deploy the Arena gateway from the `Judgeing-platform` checkout with
`npm run deploy` (the predeploy step builds assets into Doomforge's `public/`).
Deploy the backend from the Doomforge checkout with
`npx wrangler deploy --config wrangler.matrix.jsonc`. The backend config binds
the production organization/evaluation databases, private artifact bucket,
Containers and Arena service. Remote D1 backups and migrations must be completed
before deploying schema-dependent backend changes.

The two existing matrix profiles are Noyyal Treasury and Rasoi Offer Roulette.
Four additional Container classes exist for Mazhai Cover, PricingPulse, Veera
Footwear and Janus. Their official evaluation profiles remain unconfigured until
approved challenge specifications are supplied. The organizer-only
`/api/organization/matrix-container-check` is an infrastructure diagnostic: it
reads the exact temporary `src/diagnostic.py` commit from each fixed public repo,
runs it under the pinned container sandbox, and returns runtime readiness only.
It cannot generate competition marks or establish official scoring readiness.
An organizer POSTs the four full 40-character commit IDs as JSON, keyed by
`mazhai-cover`, `pricingpulse`, `veera-footwear` and `janus`. The source must be
at `src/diagnostic.py`, at most 4 KiB, and print the fixed
`CONTAINER_DIAGNOSTIC_OK` marker after its sandbox assertions. Each check uses a
fresh, single-use Container with internet disabled and is destroyed before the
response. The endpoint permits two attempts per 30 minutes so an isolated
runtime startup failure can be retried without opening an unbounded path.
`RUNNER_ENABLED=false` is a legacy runner setting and does not disable Matrix
Containers; current Matrix operation is selected by `MATRIX_MODE=true`.

Historical deployment notes below describe earlier versions and may mention
retired preview workers, runner backends or setup blockers. Follow the live
routing and command above for the current production dashboard.

The foundation has one high-entropy organizer bearer credential. Add individual verified
identities, scoped roles and audit actors before a multi-organizer event. Rotate secrets
through Wrangler. Protect GitHub branches and deployment environments independently.

HMAC validates raw bounded bytes before payload/repository/installation/assignment checks.
GitHub signatures have no signed timestamp. Persistent delivery identity plus exact-input
identity suppress replay, event timestamps order updates, and the evaluator rechecks the
current head. Keep delivery identities throughout the event. See
[GitHub validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

Preview builds require approval of the exact commit and a separate account token because
malicious application PRs can exfiltrate build credentials. No `pull_request_target`
workflow runs PR code. Preview runtime data comes from public GitHub PRs and reviewer-authored expectations.
The public review API creates only per-session test evaluations; its privileged admin
writes are disabled. The separate organization service supports authenticated organizer
management of isolated test-organization state from explicitly allowed review origins.
Unknown/fork preview origins cannot use that service.
Review D1 is separate from production and contains no production secrets.

## Recovery

- D1 batch transactions commit runs, supersession and outbox together. The two-minute
  production cron reconciles undispatched queued work. Durable workflow IDs equal run IDs.
- Stages recheck the latest submission. Input history survives supersession. Bounded
  fetches have timeouts and no redirects; stale work stops at stage boundaries.
- GitHub failures/rate limits get bounded retries. Persisted objective evidence survives
  stage failure. Logs never contain provider response bodies or credentials.
- AI receives two bounded attempts. Failure produces an objective-only report and explicit
  AI failure. Oversized context skips reasoning instead of truncating authoritative rules.
- Authorized retries create new attempts; failed history is preserved. Publication retries
  reuse Check external IDs after lost acknowledgments. Exhausted publication failures
  require operator inspection; scheduled publication recovery is a follow-up.

Logs include correlation identity, sanitized error code, duration and HTTP status; never
headers or request bodies. Recognized secrets are redacted from retained source/patch
context. Arbitrary secrets cannot be perfectly detected; a stronger scanner/artifact
redaction policy is pending. Never put sensitive data in public challenges/model context.

## Current deployment

On 2026-10-02 the review Worker was deployed and its separate D1 database migrated.
Local D1 integration tests validate the SQL. R2 creation was rejected because R2 is
disabled. Existing OAuth can deploy Workers but Workers Builds administration/log APIs
returned 403. The PR discovered an existing native Builds connection for `judge-c2c`;
its initial build failed, and root Worker naming/build configuration was corrected.
The next native build passed. Preview URL routing was enabled (production route remains
disabled), and the automatic branch Preview at
`https://feat-evaluation-foundation-judge-c2c.dakshx.workers.dev` returned HTTP 200.
The root preview configuration now binds the separate review D1 and the existing public
review Workflow. The internal `judge-c2c-review` host has no public routes and no judging
secrets. Its Workflow stages must be deployed before pushing changes to the PR preview. Native Previews are active and update on branch commits.
No scoped Actions deployment token or evaluation GitHub App credentials were available.
GitHub also rejected required-reviewer environment protection with a billing-plan error.
Only the alternative Actions deployments stay disabled pending a supported approval gate
and credentials. Keep production judging secrets out of native preview parent/base config.
No production version was deployed by this work.

## Real-event gates

- Register/install the App and verify genuine events, exact-head reads and Check publication.
- Freeze baselines, approve contracts and map teams/issues.
- Implement/provision isolated execution and trusted checks; precompute baseline evidence.
- Enable R2 and verify bounds, integrity, redaction and artifact retention.
- Add individual authentication, authorization and audited human adjudication.
- Exercise staging supersession/retries and GitHub/AI/storage failures end to end.
- Run adversarial sandbox/egress/resource drills on disposable runner infrastructure.
- Measure deadline-burst queue delay, latency and resource capacity; add budgets/alerts,
  backup/retention/recovery and rollback.
- Review CI and the preview. Human decides merges; production stays disabled until ready.

## Public PR review workspace

`PREVIEW_TESTING=true` is honored only in `local`/`review`. Browser sessions use random
256-bit HttpOnly SameSite=Strict cookies, hashed database identities and owner-scoped reads.
Mutations require an exact same-origin header. URL validation restricts input to GitHub
PRs; all outbound reads use fixed `api.github.com` and `raw.githubusercontent.com` endpoints,
exact SHAs, bounded bodies,
timeouts and no redirects. GitHub authorization headers are absent. No code is executed.
Expectations, request keys and captured commit snapshots are immutable; a new submission
action makes a new attempt. Source content is hashed rather than retained, and recognized
credentials are redacted from patches. Do not treat this as a complete secret scanner.

Limits: ten requests per IP/session per hour, twenty global reviews per hour, ten active
runs, 100 changed files, 100 KB source reads, 5,000 characters per displayed patch. A
two-minute cron on the existing internal host redispatches undelivered work and fails
runs older than fifteen minutes without erasing evidence. Session access expires in
24 hours; test runs are removed after seven days. Review cleanup never touches the
production evaluation tables. Unauthenticated GitHub API rate limits may be shared by
Cloudflare egress; GITHUB_HTTP_403/429 remains an explicit failed review.

Apply review migrations with `npx wrangler d1 migrations apply DB --env review --remote`,
then update the existing internal host with `npm run deploy:review`. Native Previews bind
this deployed Workflow, so they do not each run independently versioned Workflow code.
Root/main public routes remain disabled; updating the host does not deploy live judging.
After pushing, inspect native Builds and test the **existing** branch URL. Verify an
actual public PR completes and another browser cannot read its run. A browser fixture
test alone is not evidence of a deployed GitHub-to-Workflow-to-D1 evaluation.

PR preparation persists the baseline-relative file comparison once; objective checks reuse
it rather than requesting the same diff again. Public source assertions read bounded UTF-8
files at exact SHAs from GitHub raw storage without credentials. This reduces REST API
usage while keeping immutable attribution. It does not remove metadata API rate limits.

A trusted operator can prepare public PR metadata using
`node --experimental-strip-types scripts/prepare-public-pr.mjs <public-PR-URL> --remote`.
The script uses unauthenticated GitHub reads on the operator's network and stores normalized
public PR/compare metadata with capture time and a SHA-256 digest. No participant code runs.
There is no HTTP write endpoint for this immutable cache. On GitHub 403/429/5xx only,
preparation may reuse a matching cache captured within 24 hours. It validates repository,
PR, public visibility, exact commits and digest, then marks latest-head refresh UNVERIFIED
and displays its provenance. Missing, mismatched or corrupt cache entries cannot produce
a silently fabricated current submission. Prepared caches are a review testing aid, not a
replacement for the installed GitHub App required for live hackathon evaluation.

## Organization test integration

The existing internal `judge-c2c-review` host also serves the authenticated organization
console through `ORG_SERVICE`; no additional public URL is provisioned. `ORG_DB` is
`judge-c2c-organization`, separate from synthetic and public-review sessions.

Apply both databases' migrations before updating the host:

```sh
npx wrangler d1 migrations apply DB --env review --remote
npx wrangler d1 migrations apply ORG_DB --env review --remote
node scripts/bootstrap-organization.mjs --remote
npm run deploy:review
```

Bootstrap saves private access/vault files under ignored `.wrangler/` with mode 0600,
and uploads only to the internal host. It reuses existing valid values; do not delete
or rotate the vault key without decrypting/re-encrypting the stored App credentials.
Back it up privately. Never bind these secrets or ORG_DB to the public preview Worker.
The script repairs a trailing literal newline left by an earlier bootstrap version.
For local integration, bootstrap without `--remote` and migrate ORG_DB with `--local`.
Local registration needs a reachable HTTPS callback and should use a separate test App.

Login creates an eight-hour HttpOnly session; logout revokes it. Registration state
expires after one hour. Ten login attempts per minute per IP are permitted. Only the
configured exact origin may invoke the console. The single organizer access code is a
test bootstrap credential; rotate it and revoke all sessions if compromised. Separate
organizer identities and roles are required before broader hackathon use.

After owner approval, installation-repository events refresh selected access; deletion
or suspension revokes repository visibility and supersedes active work. Token minting
also enforces GitHub's current access. Repository sync can be retried from the console.
Check the actual App webhook deliveries and Check publication on an assigned real PR
before claiming the end-to-end integration is proven. App registration, installation,
and a real assigned submission must be tested with owner approval; mock fixtures do
not prove these external steps.

## Isolated runner and reviewer checks

Migration `0006_execution.sql` adds append-only execution records. Apply it to both review
and organization D1 before deploying this host version. Baseline/head results use separate
request hashes, immutable image identity and bounded redacted outputs. Retrying creates
new records; do not edit historical results. Large artifact/R2 operation remains a follow-up.

`RUNNER_ENABLED=false` in the checked-in Cloudflare-container configuration is deliberate.
The account does not have paid Containers access and
the owner declined enablement for now. Normal `npm run deploy:review` does not provision
containers. The public native preview has no runner or AI binding; it forwards only
session-protected organization operations to the internal host. AI runs through Workers AI
on that host with bounded prompts, two attempts and validated output. Provider failure
retains the deterministic report. The Test AI reviewer button runs a clearly labeled
synthetic diagnostic, limited to two invocations per minute, and records the attempt in audit.

Future enablement requires paid access and deployed adversarial validation. Build the trusted
`runner/Dockerfile` image, upload to the account managed registry, and record its digest URI.
The dedicated lockfile pins evaluator ESLint. After approval, set `JUDGE_RUNNER_ENABLE=true`
and `JUDGE_RUNNER_IMAGE` to that immutable URI, run `node scripts/runner-config.mjs`, review
the generated `.wrangler/runner.json`, then deploy that configuration to the existing internal
host. It allows four instances. Freeze new contracts with this exact image; an old
UNCONFIGURED contract stays non-executable. Updating ordinary review configuration disables
execution again. Do not rotate image content underneath a recorded contract.

The development alternative is now the local Docker runner through an authenticated tunnel.
`npm run runner:connect` deploys its ignored configuration to the existing internal host
with execution enabled. Trusted image boot, cleanup, resource/network controls, signed
baseline/head canaries and the deployed protected-console diagnostic have passed.
See [local Docker operations](local-docker-runner.md). Actual participant behavior remains
unverified in the README-only challenge repositories. The paid Cloudflare-container path
and production host-escape resistance remain unproven. Ordinary review deployment disables
execution; use the explicit local-runner connection command to preserve that configuration.

## GitHub operations

Use authenticated `gh` / `gh api` for live repository, issue, PR, installation,
label, collaborator and CI state. Verify `gh auth status` first and inspect an
object before writing it. Reuse a coherent open PR, inspect expected commits and
checks after each push, and discover the Cloudflare preview from actual PR comments
or checks. Never print token/secret values, invent GitHub state, or merge without
an explicit instruction. Owner permission updates and sensitive repository governance
changes require their appropriate authorized workflow; development CLI credentials
never replace the backend's short-lived GitHub App credentials.

## OpenAI reviewer

The isolated review backend uses `AI_PROVIDER=callmissed` and
`CALLMISSED_MODEL=kimi-k2.6`. This catalog ID is not an immutable snapshot;
traces retain the actual returned model, and reproducibility is limited by the provider.
Set `CALLMISSED_API_KEY` with
`npx wrangler secret put CALLMISSED_API_KEY --env review`, using a CallMissed key
with only the `llm` permission. Never put it in Wrangler vars, public assets,
GitHub issue text or participant containers. Local development can use ignored
`.dev.vars`. Production needs its own explicit key and configuration. The existing
organization service binding keeps the key on the internal backend. The earlier
OpenAI key is unused; this integration never calls api.openai.com.

The [CallMissed Responses API reference](https://docs.callmissed.com/docs/chat-completion)
documents structured output. Strict schema output still goes
through local criterion/evidence validation. Requests have no tools, no redirects,
bounded output and timeouts and `store:false`. The chosen free-plan model is not
advertised as a zero-data-retention route. `store:false` disables Responses storage,
not upstream retention; review data is sent to CallMissed and its model backend. Traces record provider/model/response ID/usage;
errors contain only allowlisted codes, never arbitrary provider prose. Credits,
model access, and rate limits must be available for a real review. Failed AI review
retains deterministic evidence and requires honest human attention.

The QA report and capability matrix are in `docs/qa/`. Run `npm run qa:docker`
only with the trusted development Docker image present; it executes bounded
controlled fixtures inside guests, never participant code on the host.
