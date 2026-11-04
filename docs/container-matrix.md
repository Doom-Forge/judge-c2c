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

The authenticated `POST /api/matrix/diagnostic` endpoint accepts an organizer
snapshot for testing the same Cloudflare execution path. Diagnostics return
results directly and do not create participant submission records. Save their
receipts privately. The read-only synthetic review never implements this route.

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
