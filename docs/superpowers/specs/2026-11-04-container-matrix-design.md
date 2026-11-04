# Doomforge deterministic container judging pilot

## Approved direction

Replace AI judging for the Doomforge pilot with trusted, repository-specific
container checks. The dashboard currently connects the organization repositories
`180DC-VIT-CHENNAI/noyyal-treasury` and
`180DC-VIT-CHENNAI/rasoi-offer-roulette`. Report scalability, security and usefulness
with both status and numerical scores. This document defines the proposed scoring
defaults for owner review.

Owner clarification: use Cloudflare Containers only for judging execution. Do not
dispatch pilot runs to GitHub Actions, QEMU hosts, tunnels, or local runners.
Owner reporting update: keep numerical scores on the dashboard only. GitHub gets
a single “DoomBot is evaluating your PR.” comment and a Doom-inspired avatar,
without marks, category results or score check runs.

## Architecture and alternatives

Deploy the dashboard Worker and two repository-specific container configurations
to Cloudflare account `Technical.vitc@180dc.org's Account`
(`2d8e86c5870a28947cb3eea1e20a8d86`) using Wrangler. Each configuration contains
trusted versioned judging tools and its own matrix. Create fresh execution state
for each submission; do not reuse a contaminated participant environment.

This is preferred to a shared mutable container because dependencies and judging
rules differ by repository. Keeping the existing Actions/QEMU execution service
would minimize infrastructure changes, but does not meet the requested Cloudflare
container deployment. Exactly two container configurations does not imply two
permanently running instances: instances start for evaluations and stop afterward.

The existing signed GitHub webhook validates the repository and PR, pins the head
SHA, and queues an asynchronous run. Resolve the trusted matrix by repository ID,
not from participant files. Fetch code with installation credentials only in the
control plane, then pass a bounded snapshot into the execution environment without
credentials. Persist normalized results and publish them to the dashboard. Post
only the DoomBot evaluating notice to GitHub. Recheck the latest PR head;
retain superseded attempts in history.

## Matrix and scoring

Each repository has a versioned organizer-owned matrix with exact test IDs,
category, description, positive weight, executable check, expected outcome,
time/resource limits, and mandatory flag. Record its digest with every run.
Participants cannot edit this matrix through their PR.

- Scalability: deterministic workloads at increasing input sizes, with fixed
  runtime and memory limits and correctness assertions at each size. Report
  observed timing and resource values alongside thresholds.
- Security: explicitly scoped input-abuse, path/file boundary, and relevant API
  checks. A pass describes only tested properties. Infrastructure isolation is
  separately verified and is never inferred from participant test output.
- Usefulness: hidden functional acceptance cases for each repository's expected
  behavior. Existing private pilot tests can supply cases after compatibility and
  baseline validation; reference solutions and hidden datasets stay private.

Each completed test earns its configured weight on PASS and zero on FAIL. For a
category with all checks executed, score = 100 * passed weight / total weight,
rounded to one decimal place. Category weights are equal: the overall score is
the mean of the three category scores, rounded to one decimal place. A mandatory
failure makes the category FAIL regardless of its numerical score; otherwise a
fully passing category is PASS and a mix of passing/failing checks is PARTIAL.

Missing evidence, infrastructure failure, unsupported checks, or incomplete runs
produce UNVERIFIED and a null final score for the affected category. The overall
score is null unless all three category scores are available. Completed test
results remain visible. Deterministic workload timeouts count as FAIL only when
the judge proves the workload started and exceeded its configured bound;
provisioning and transport timeouts remain execution errors.

Run frozen baseline and PR head against the same matrix/image, retaining both
results so existing failures and regressions are distinguishable. Baseline
failures do not silently change the absolute PR score.

## Isolation, persistence and dashboard

Participant code receives no GitHub, Cloudflare, database, callback-signing, or
organizer credentials. Enforce process, memory, CPU, filesystem, output and wall
time limits and restricted networking. Trusted checks and their expected results
must not be writable by participant processes. Verify these boundaries against
Cloudflare's supported runtime before enabling real participant execution. If a
required boundary cannot be enforced, expose the blocker and leave execution
disabled rather than publishing unsupported scores.

Persist repo, PR, baseline/head SHA, matrix version/digest, image/tool identity,
attempt ID, category scores/statuses, individual outcomes, timings, bounded
redacted logs and timestamps. Retries create new attempts. Duplicate deliveries
do not duplicate scoring, and new PR commits supersede older queued work.

Replace AI reviewer controls and narratives in the pilot UI with three category
results, overall score, baseline comparison, per-test evidence and execution
errors. Preserve historical evaluations and distinguish their evaluation method.
Remove AI calls, bindings and provider secrets from the new pilot deployment;
never relabel historical AI reports as container test results.

## Deployment and verification

Provision account-local databases and artifact storage for the technical account;
existing bindings belong to the personal account and cannot simply be reused.
Do not delete or overwrite the old deployment or its data. Verify a backup and
an explicit data migration strategy before moving existing organization state;
reuse the organization-owned GitHub App configuration without exposing secrets.
Change its webhook destination only after the new deployment passes verification.

Keep feature work on the coherent existing branch and PR; never merge to main
without authorization. Use synthetic fixtures and isolated resources in previews.
Run the repository's `npm run check` and `npm run test:browser`, matrix validation
and scoring tests, isolation checks, and deployed baseline/failing/passing canaries
for both repositories. Confirm webhook-to-dashboard results on exact head SHAs,
duplicate delivery handling, supersession, failed execution and retry history.

Deployment requires Workers Paid on the target account and a Docker-compatible
engine for building local images. Verify both before deploying containers.
Report preview URLs, deployment versions and measured limitations honestly.
Synthetic test success does not establish event-scale readiness.
