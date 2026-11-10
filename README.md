# Judge-C2C

The current Doomforge pilot uses deterministic Cloudflare Containers and numerical
matrix scores, with no AI judging or GitHub Actions. See [DOOMFORGE.md](DOOMFORGE.md)
and [the container runbook](docs/container-matrix.md) for the current deployment.
The original platform documentation below retains historical architecture context.

GitHub engineering evaluation with immutable contracts, baseline comparison and
evidence-backed human review. AI interprets evidence; it does not establish facts.

**[Automatic PR Preview](https://feat-evaluation-foundation-judge-c2c.dakshx.workers.dev)** — test real public PRs in your own browser session.
See [current capabilities and operation](docs/system-capabilities.md) and the [live verification checkpoint](docs/qa/current-completion-state.md). Production/event-scale verification remains pending.

## Try the real review flow

1. Open the existing bot-managed PR Preview above.
2. Select **Use prepared public example**, or paste a public GitHub PR URL and describe the expected behavior.
3. Optionally provide a frozen baseline SHA, a literal source assertion and protected paths.
4. Select **Evaluate PR**. Inspect exact commits, changed files, baseline-relative evidence,
   requirement assessments and the timeline. Download the complete review JSON.

For a small reproducible example, use `https://github.com/octocat/Hello-World/pull/1`,
expected behavior “Document the Git initialization steps in README”, and a source assertion
for `README` containing `$ git init`. This tests real GitHub reads, not runtime behavior.

The preview uses public GitHub metadata APIs and exact-commit raw files without credentials and never publishes to external
PRs. It persists each attempt in a separate review database. Your HttpOnly session lasts
24 hours; runs are retained for seven days and are visible only to that session. A new
Evaluate action captures a new head without overwriting earlier attempts. Without an
explicit baseline, it captures the PR merge base rather than an organizer-frozen baseline.
Public API rate limits and a 100-file diff limit can cause a review to fail explicitly.
The prepared example is a real public PR snapshot fetched by a trusted preparation script,
not synthetic data. When live metadata reads are blocked, it is labeled **Frozen GitHub
snapshot** with its capture time; the latest PR head remains UNVERIFIED. Source assertions
still fetch real files at the frozen commits. Snapshots expire from fallback use after 24 hours.
Operators can prepare another public PR without credentials:

```sh
node --experimental-strip-types scripts/prepare-public-pr.mjs https://github.com/owner/repo/pull/123 --remote
```

Use Node 24+. Omit `--remote` for local D1. Only operator deployment access can populate
this immutable, integrity-checked cache; no browser API accepts participant snapshots.
Build/tests/benchmarks/security scans and AI review are not run here. Functional behavior
remains **UNVERIFIED**. Do not enter sensitive information into this review environment.

## Delivered foundation

- TypeScript Cloudflare Worker and responsive judge dashboard.
- Protected organizer APIs for versioned contracts and PR/team/issue assignments.
- Raw webhook HMAC validation, repository/installation allowlists, delivery deduplication,
  exact-input identity, transactional D1 outbox and scheduled reconciliation.
- Immutable baseline/head/contract/team snapshots, supersession and auditable retry attempts.
- Short-lived repository-scoped GitHub App tokens, bounded commit contents/diffs and
  rejection of non-descendant baselines or truncated comparisons.
- Objective source/documentation assertions and protected-path checks with baseline
  attribution. Explainable risk signals flag sensitive components/dependencies/CI/test deletion.
- Optional Workers AI requirement review: versioned policy, bounded context, validated
  schema/evidence references, rejection of unsupported PASS and waived criteria.
- Durable evaluation stages, partial evidence, concise GitHub Check publication,
  protected R2 artifact support and correlated structured logs.
- Passing GitHub CI and native Cloudflare branch Previews that update on PR commits.
  Optional Actions deployment definitions remain disabled pending credentials/approval gates.

**Authenticated organization evaluations support isolated participant execution** through the trusted Node HTTP runner profile and configured build/test/scanner/coverage/benchmark checks. The credential-free public preview does not execute that full pipeline. Missing execution remains UNVERIFIED; literal source assertions prove only their exact criterion. Additional contributions require evidence and organizer recognition. See the current capability document for the supported boundaries.

## Local development

Use Node 24 (minimum 22.12) and npm. Dependencies are pinned.

```sh
npm ci
npm run db:local
npm run dev
```

Open `http://localhost:8787`. Default mode supports the isolated public PR review workspace. Set `PREVIEW_TESTING=false`
to use the synthetic read-only fixtures.
For local live mode, copy `.dev.vars.example` to `.dev.vars` and provide test GitHub App
credentials and separate random organizer/webhook secrets; set `PREVIEW_TESTING=false`. Never use production secrets.
The browser keeps its organizer credential only in tab memory.

```sh
npm run check
npx playwright install chromium
npm run test:browser
REVIEW_URL=https://feat-evaluation-foundation-judge-c2c.dakshx.workers.dev npm run test:browser
```

Tests use signed adversarial fixtures and real local D1. No hostile code executes on
the developer host. Browser checks cover filtering, evidence navigation, mobile layout
public review submission/polling/download, escaping hostile patches, and privileged write restrictions.
The browser fixtures do not claim to exercise GitHub; a deployed real public PR smoke check
is performed separately.

## Configure real GitHub intake

Register a GitHub App on selected hackathon repositories with **Metadata: read**,
**Contents: read**, **Pull requests: read**, **Checks: write**, and **Pull request** events.
Set webhook URL `/webhooks/github` and a strong secret. Production never uses a personal
access token. Convert GitHub's usual PKCS1 private key to PKCS8 for `GITHUB_APP_PRIVATE_KEY`:

```sh
openssl pkcs8 -topk8 -nocrypt -in github-app.private-key.pem -out github-app.pkcs8.pem
```

Adapt `examples/contract.json` with actual repository/installation IDs, full frozen SHA
and approved issues. Register outside participant repositories:

```sh
curl -X POST "$JUDGE_ORIGIN/api/contracts" \
  -H "Authorization: Bearer $JUDGE_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @challenge.json
curl -X POST "$JUDGE_ORIGIN/api/assignments" \
  -H "Authorization: Bearer $JUDGE_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"repositoryId":123,"prNumber":24,"teamId":"northstar","teamName":"Northstar","issueNumbers":[12]}'
```

Assignments cover the contract's entire issue set. Each assignment pins its immutable contract hash; registering a different PR's
challenge does not change existing assignments. Pass `contractHash` explicitly when
configuring assignments concurrently.
Unassigned PRs fail explicitly instead of guessing a team or using participant judging
policy. Redeliver an event rejected before assignment registration.

`file_contains` is permitted for source/documentation criteria only. `runner` references an authoritative trusted acceptance case. The development Docker/tunnel adapter is enabled for the controlled payment-engine rehearsal; production execution remains disabled. Functional criteria without trusted execution remain UNVERIFIED; `human` criteria do not become PASS merely through source inspection. AI cannot waive requirements, mint evidence or override objective failures.

## PR review and deployment

Work on a feature branch and update the existing PR; the human decides merges. The
[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) connection
automatically updates the existing branch Preview on commits. Do not provision a new
public Worker for each change. GitHub Actions `Validate` runs types, tests, Worker build,
dependency audit and browser tests. Fork PRs receive credential-free CI.

Root and `previews` bind only the separate **review** D1 database and the existing
`judge-c2c-public-preview-evaluator` Workflow hosted by `judge-c2c-review`. That internal
Worker has its public workers.dev and version preview routes disabled. Cloudflare
[preview Workflows](https://developers.cloudflare.com/workers/previews/resources/) run
the code of the deployed Workflow host, not the application branch Preview. When changing
its stages, first migrate review D1 and run `npm run deploy:review` to update this existing
internal host, then push the PR. Changes shared by several simultaneous branch previews
would require versioned Workflow hosts; this slice serves the current coherent PR.
The public Worker has no App secrets. A protected organization console proxies to the
internal host, which uses its own organization D1 and encrypted test-App credentials.
Only the configured branch origin can reach that console. These are isolated test
resources, not production bindings. The public workspace stays credential-free.

The parent `judge-c2c` production route stays disabled. Optional Actions deployment
workflows remain disabled and require scoped credentials and a supported approval gate.
GitHub rejected required-reviewer environment protection on the current billing plan.
Never put production judging credentials in the native preview parent/base configuration.

Production remains disabled until `CLOUDFLARE_PRODUCTION_ENABLED=true`. It runs only on
human-merged main pushes through `cloudflare-production`, with its own token/account,
`PRODUCTION_DATABASE_ID`, `PRODUCTION_ARTIFACT_BUCKET`, `PUBLIC_ORIGIN` and account variable.
`scripts/production-config.mjs` rejects missing resources. Provision D1/R2, then Worker
secrets `ADMIN_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`.
R2 must first be enabled in the Cloudflare account dashboard.

AI supports Cloudflare Workers AI or CallMissed. The current live review backend uses CallMissed `kimi-k2.6`; Cloudflare model selection uses `AI_MODEL`. Both paths enforce objective precedence, known citations, bounded context and structured output. Provider credentials stay server-side.

## API

All live organizer endpoints require `Authorization: Bearer <credential>` (at least
32 characters). The protected organization console separates organizer and read-only judge role codes; individual revocable identities and team-scoped participant permissions are implemented; production configuration still requires independent verification. `/health` is liveness, not a readiness attestation.

| Endpoint                          | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `GET /api/overview`               | Counts and latest 100 evaluations                        |
| `GET /api/repositories`           | Repositories and active contracts                        |
| `POST /api/contracts`             | Validate/store immutable contract and activate version   |
| `POST /api/assignments`           | Assign exact repository/PR/team/issues                   |
| `GET /api/evaluations/:id`        | Snapshots, report, evidence, timeline, artifact metadata |
| `POST /api/evaluations/:id/retry` | Redispatch or create a new failed-run attempt            |
| `GET /api/artifact?key=…`         | Authorized download with SHA-256 metadata                |

See [design](docs/design.md), [product baseline](docs/product-requirements.md),
[operations](docs/runbook.md), [runner boundary](docs/runner-boundary.md),
and [roadmap](docs/roadmap.md).

## Connect Daksh-Codebase

Use **GitHub organization** on the existing branch Preview. Unlock using the private
code in `.wrangler/organization-access.txt`, then select **Register GitHub App**.
GitHub requires an organization owner to approve registration and installation.
Choose Daksh-Codebase and only the repositories you want to test. No private key
or personal GitHub token needs to be pasted into the browser.

The [GitHub manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
registers an organization-owned private App with contents and PR read access, Issues write access, and Checks write access. Subscribe to Issues, Issue comment and Pull request events. Registration callbacks use expiring, session-bound, one-use
state. Installation IDs are validated server-side against the App and organization.
App keys and webhook secrets are encrypted in the separate organization database;
short-lived installation tokens are scoped to the selected repository.

Choose a repository, PR and issue, enter team and authoritative acceptance criteria,
confirm the frozen baseline SHA, and start evaluation. Future opened/synchronize/reopened
PR events use that assignment. Unconfigured PRs fail explicitly. GitHub Check detail
links open the protected organization report. The public workspace cannot read it.

This slice performs immutable baseline/head comparison and configured source checks.
The development Docker VM compares trusted baseline/head HTTP acceptance and bounded supplemental commands. Real payment-engine evaluations and CallMissed reviews are recorded in [readiness evidence](docs/qa/readiness-cycle-report.md). Production isolated capacity remains unprovisioned. Missing execution stays UNVERIFIED, and AI cannot override objective results. Real model calibration found inaccurate prose despite valid citation IDs: judges must check narrative claims against evidence.

The organization console shows execution/reviewer configuration and offers an authenticated,
rate-limited synthetic reviewer diagnostic. Select the payment retry test profile only after
approving its exact requirements. The [reference fixture](examples/payment-retry/README.md)
is organizer-authored, not participant work. Stored execution logs and hashes appear under
Isolated execution in authorized reports. See [runner operation](docs/runner-boundary.md)
for supported limits and explicit future enablement. No additional public URL is created.

Development execution on the organizer machine: [Docker + tunnel guide](docs/local-docker-runner.md). Cloudflare Containers remain disabled; the website URL stays unchanged.

## Acceptance audit and issue operations

[The master acceptance ledger](docs/master-acceptance.md) records all 714 requirements
with verification methods and explicit boundaries. `npm run acceptance:check` rejects
generic placeholder audits, nonexistent local evidence and PASS claims based only on
source inspection. Passing fixture tests do not attest a production hackathon launch.

Configure numeric `organizerGitHubIds` in event policy before using native GitHub
label overrides. Only those identities can suppress evaluator-owned labels; other
changes are auditable review signals. Organizer console decisions are separately
authenticated. Priority/difficulty parsed from exact structured issue metadata are
advisory; organizer overrides prevail. Security and repeated-report signals route
to review without public exploit comments, automatic closure or competitive credit.

Issue queries combine repository, source, team, type, label, priority, difficulty and
judging progress. The UI exposes organizer priority, difficulty, technical severity
and recognition rationale separately. GitHub closure never proves completion, and
closed issues cannot receive new assignments. Reservation expiry preserves audit history.

Trusted Node HTTP policies can configure supplemental build, test, lint, integration,
typecheck, format, coverage, security and dependency command kinds. Tools must exist
in the immutable image; unavailable tools remain unavailable, and participant command
success never proves functional criteria. The profile does not install participant
dependencies or grant guest networking.

Container-free execution: [GitHub Actions/QEMU setup](docs/actions-vm-runner.md).
Additional backend reviewers: [Gemini and Groq](docs/ai-providers.md). These adapters require explicit provisioning and live validation before event activation.
