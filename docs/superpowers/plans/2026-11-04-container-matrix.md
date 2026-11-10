# Cloudflare container matrix implementation plan

**Goal:** Replace the pilot AI judging flow with Cloudflare-only container checks
and evidence-backed numerical scores for the two connected Python repositories.

**Architecture:** Keep the existing organization GitHub App and authentication.
Add an isolated matrix intake/workflow and persistent tables without modifying
historical evaluation rows. Start a fresh Cloudflare Container per baseline/head
attempt with internet disabled. Serve a matrix dashboard in the new deployment.

**Global constraints:** Cloudflare account 2d8e86c5870a28947cb3eea1e20a8d86;
no AI bindings or runner credentials in new deployment; no participant credentials;
equal category weights; UNVERIFIED category means null overall score; no main merge.

## Task 1 — Trusted Python container and matrices

- [ ] Create `matrix-runner/Dockerfile`, trusted Python controller, two matrices,
      and tests for passing/failing checks and hostile subprocess boundaries.
- [ ] Use pinned dependencies prepared at build time, not participant installs.
- [ ] Run participant modules as an unprivileged subprocess with resource limits;
      compare child outputs in a trusted parent without importing participant code.
- [ ] Keep grading rules outside participant-writable paths. Bound every stream.
- [ ] Container command: `python /opt/judge/controller.py`; stdin carries a JSON
      snapshot `{repository, files:[{path,base64}]}`; stdout is a single JSON document
      `{checks:[{id,category,status,durationMs,detail}]}`. Matrix definitions come from
      trusted source, never snapshot files. Check IDs and schema must be validated.
- [ ] Verify tests locally using Docker only as build/development validation;
      deploy actual judging to Cloudflare Containers exclusively.

## Task 2 — Matrix persistence and GitHub workflow

- [ ] Create `src/matrix.ts`, `src/matrix-workflow.ts`, and a SQL migration.
- [ ] Test score normalization, missing/duplicate checks, replay and input bounds
      before implementation. Scores are 100*passed weights/total; incomplete null.
- [ ] Verify signed organization webhook first, then dispatch matrix PR intake
      before legacy assignment gates. Validate selected repository/installation.
- [ ] Deduplicate delivery and run identity; retain superseded and failed history.
- [ ] Verify current head through GitHub, fetch exact bounded snapshots without
      sending GitHub credentials into the container, and save baseline/head evidence.
- [ ] Export distinct NoyyalMatrixRunner and RasoiMatrixRunner Durable Objects.
      Start with `enableInternet:false`, enforce timeout, destroy after each run.
- [ ] Implement authenticated overview, details and retry APIs. Keep all marks on
      the dashboard; GitHub receives only the DoomBot evaluating notice and avatar.
- [ ] Request Kevin272-dot for ready-for-review PRs in both synced repos, remove
      pending Copilot requests, and disable automatic Copilot reviews in GitHub.

## Task 3 — Matrix dashboard

- [ ] Create `public/matrix.html`, `public/matrix.js`, `public/matrix.css`.
- [ ] Use bearer organizer authentication, no persistent credential storage.
- [ ] Render selected repos, run list, category and overall scores, exact commits,
      per-test evidence, baseline comparison, failures, and retry history.
- [ ] Render all external text with textContent; no AI controls or narratives.
- [ ] Add browser verification for login, results, missing scores and failures.

## Task 4 — Account migration and deployment

- [ ] Verify target account resource inventory and paid Containers capability.
- [ ] Export original databases privately; verify SQLite integrity and checksums.
- [ ] Provision target D1 and artifact resources. Restore organization state to
      preserve connected repos/App; keep backups, keys and hidden tests out of Git.
- [ ] Generate a target-account private Wrangler config with two container apps,
      two Durable Object bindings, matrix workflow, no AI or external runner binding.
- [ ] Run type checking, backend and browser checks and dry-run deployment.
- [ ] Deploy isolated synthetic preview first and verify both container profiles.
- [ ] Deploy live dashboard/resources, validate authenticated routes and canaries,
      then change organization webhook URL after validating the new deployment.
- [ ] Commit/push coherent branch, update existing PR 15, inspect checks and
      review deployment. Report URLs and any measured limitations; never merge.

## Verification ledger

Track test commands, deployment versions, image identities and live receipts in
the private operator directory. Preserve failed runs; never infer PASS from a
successful build or HTTP liveness probe.
