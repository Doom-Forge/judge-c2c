# Doomforge Cloudflare container pilot

The matrix deployment uses Cloudflare Containers exclusively for judging. The
Worker handles GitHub intake, authentication and orchestration; D1 retains runs,
checks and baseline comparisons. The organizer dashboard is at the deployed
Worker root. `wrangler.matrix.jsonc` selects the technical Cloudflare account.

The two Container applications are `NoyyalMatrixRunner` and `RasoiMatrixRunner`.
Both use a trusted Python image, with repository-specific checks from
`matrix-runner/matrices.json`. Instances start for execution and are destroyed
when it finishes. There are no AI bindings, provider calls, Actions dispatches,
tunnel runners or participant package installs in this pilot path.
GitHub Actions workflows are removed and disabled at the owner's request. Do not
add an Actions pipeline for validation or deployment. Use the local commands and
Cloudflare diagnostics below.

## Scoring

Scalability, security and usefulness each receive a 0–100 score. Checks carry
positive weights within a category; the overall score is the equal-weight mean
of the three category scores. The pilot currently uses two checks per category.
Security checks are mandatory, so any security failure makes that category FAIL.
A mixture of optional passing/failing checks is PARTIAL even if display rounding
produces 100. Missing or unexecuted evidence is UNVERIFIED, its category has no
final numerical score, and the overall score remains unavailable.

The baseline and PR head are tested with the same frozen matrix and image
identity. Existing baseline failures are displayed separately; they do not award
the submission points. The scope of this initial matrix is described in
`matrix-runner/README.md`; these scores do not replace a complete product audit.

## Operate

Keep credentials in the ignored `.wrangler/workspaces/technical-matrix/` directory.
The dashboard uses the existing main organizer credential, held only in browser
memory. The public synthetic review uses the public demo string `preview`; it
has no live database, container, or organization credential bindings.

```sh
npm run check
npm run test:browser
npx wrangler deploy --dry-run --containers-rollout none --config wrangler.matrix.jsonc
npx wrangler deploy --config wrangler.matrix-review.jsonc
```

Local Docker is used only to build and validate images, with owner approval.
Cloudflare executes deployed submissions. Build for `linux/amd64`, run the
container isolation tests, push the image with `wrangler containers push`, and
pin the returned registry digest in both Container configurations and the
`MATRIX_IMAGE_URI` variable. Repository rows and new attempts freeze that image
URI together with matrix digest/version and baseline SHA. A rollout that cannot
execute the frozen image produces an execution error, never a score from a
substitute image. Run the current matrix version to completion before rolling
out a changed image/matrix; retain previous run reports.
The `durable_object` scheduling policy selects that exact image on startup;
database leases bound each repository to two simultaneous container executions.

The authenticated `POST /api/matrix/diagnostic` endpoint accepts an organizer
snapshot for testing the same Cloudflare execution path. Diagnostics return
results directly and do not create participant submission records. Save their
receipts privately. The read-only synthetic review never implements this route.

## DoomBot notices

Marks remain exclusively on the authenticated dashboard. The installed GitHub App
`doombot-180dc` posts one “DoomBot is evaluating your PR.” comment with its avatar
when evaluation begins. A durable lease and authenticated bot marker reconcile
retries without comment spam. Notification outages do not stop grading.

Matrix execution tokens have no Checks API permission. Previous numeric check
summaries were replaced with neutral notices; new evaluations do not create check
runs. The avatar lives in `public/doombot-avatar.svg` and its PNG export, and is
also configured as the GitHub App's profile image. Changing the App's slug requires
updating both the connection row and its encrypted metadata in the organization
database; its App ID, webhook signing secret and installation stay unchanged.

`DEFAULT_PR_REVIEWER=Kevin272-dot` assigns the human reviewer once per open,
ready-for-review PR. Drafts wait until `ready_for_review`; authors are not asked to
review their own work. Existing requests and completed reviews are recognized.
Pending Copilot bot review requests are removed. Disable automatic Copilot review
in GitHub's applicable user/repository rules as well. Review assignment and its
recovery run through Cloudflare, without GitHub Actions.

DoomBot requires Pull requests read/write on the two selected repositories to
post PR conversation notices and request reviewers. Evaluation snapshots use
read-only tokens; write tokens remain in the control plane. Reviewer failures
remain retryable and never turn grading evidence into a pass.

After the new deployment passes Cloudflare canaries, point the organization-owned
GitHub App webhook at `/webhooks/organization` on the new Worker origin. Opened,
synchronize, reopened and closed PR events update immutable attempt history.
Retries create a new attempt and require the PR still to be the latest open
submission. The two-minute reconciliation job recovers queued dispatch and
GitHub publication failures.

Never copy live secrets into review deployments. Preserve original account data
and backups during migration; neither the old databases nor the old deployment
are deleted by this change. The private backup receipts include SHA-256 hashes
and successful SQLite integrity checks.

## Cross origin clients and Arena integration

`CORS_ALLOWED_ORIGINS` is a comma-separated list of exact HTTPS origins, without
paths, trailing slashes or wildcard domains. Explicit localhost HTTP origins may
be used for local development. Same-origin requests and server-side requests
without an Origin header remain supported. Cross-origin browser clients send the
organizer bearer token; CORS does not replace authentication. Matrix OPTIONS
preflights allow GET, POST, Authorization and Content-Type. Allowed origins receive
CORS headers on API errors as well as successes. No credentialed wildcard or
cookie sharing is enabled. Add a new frontend origin to this variable and deploy
with Wrangler; the production default allows the Arena Worker origin.

The Arena frontend uses its own GitHub OAuth sessions and calls an authenticated
server-side service binding to this Worker. Its `MATRIX_BACKEND_TOKEN` is a secret
containing the existing organizer credential; never bundle this value into
frontend JavaScript or a Vite environment variable. The bridge applies Arena role,
assignment, PR head and publication checks before exposing evidence. Email OTP
sign-in is removed from the Arena application; GitHub OAuth is retained.

See `docs/matrix-cost-controls.md` for the 31-day execution-start budget, four
concurrent execution cap, trusted baseline cache and lower-cost instance choice.
The application budget is not Cloudflare account billing. It does not include
other Workers, D1, queues, storage, logs or pre-migration usage. Only two real
repository matrices are configured; the cap of four does not invent two more
repository profiles or run four always-on instances.
