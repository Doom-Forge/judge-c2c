# Doomforge — 180DC Cloudflare container judge

Dashboard: <https://doomforge-matrix.technical-vitc.workers.dev/>.
Organization: <https://github.com/180DC-VIT-CHENNAI/>.
Cloudflare account: `Technical.vitc@180dc.org's Account`.

The current pilot replaces AI judging with deterministic tests in two Cloudflare
Container applications, one for `noyyal-treasury` and one for
`rasoi-offer-roulette`. PR webhooks freeze the exact head, baseline, matrix digest
and image identity. The dashboard displays scalability, security and usefulness
statuses, 0–100 category scores, an equal-weight overall score, individual checks
and baseline comparisons. Incomplete evidence remains UNVERIFIED with no final
overall score. Historical and superseded attempts are retained.

Scores are shown only on the authenticated dashboard. The GitHub App, **DoomBot
180DC**, posts a single avatar-backed “DoomBot is evaluating your PR.” notice per
PR. It does not publish numeric marks or category results to GitHub. New heads and
retries reuse that notice instead of adding duplicate comments.

Actual judging runs exclusively on Cloudflare Containers. There are no AI
bindings or external runner credentials in this deployment. GitHub Actions
workflows were disabled and removed at the owner's request on 2026-11-04; do not
re-enable them. Local Docker is authorized only for image builds and validation.

## Operate

```sh
npm ci
npm run check
npm run test:browser
npx wrangler deploy --config wrangler.matrix.jsonc
```

The committed configuration pins the trusted image in Cloudflare's registry.
Read [the container runbook](docs/container-matrix.md) before changing an image,
matrix or baseline. Always validate a new image with the synthetic passing,
failing and isolation canaries on Cloudflare before enabling real submissions.
These narrow pilot checks do not establish full challenge scoring or event-scale
capacity. Their exact scope is documented in `matrix-runner/README.md`.

The main organizer credential is kept privately in
`.wrangler/workspaces/technical-matrix/secrets.json` as `ADMIN_TOKEN`. Credentials,
SQL backups, deployment receipts, canary results and screenshots are ignored by
Git and must remain private. The existing organization-owned GitHub App connection
and selected repositories were migrated with the organization database.

An isolated synthetic review is available at
<https://doomforge-matrix-review.technical-vitc.workers.dev/> with public demo
credential `preview`. It has no live databases, secrets or execution bindings.
Its generated results are not participant evaluations.

## Retained historical deployment

The previous Worker at <https://judge-c2c-doomforge.dakshx.workers.dev/> and its
personal-account databases are retained for history. Verified SQL backups and
SHA-256 receipts are stored privately under
`.wrangler/workspaces/technical-matrix/`. They were restored into local SQLite and
passed integrity checks before import into the technical account. No old database
was deleted during this migration.

The private pilot factory remains in `.private/doomforge-factory`, a separate
ignored private repository. Its reference solutions and hidden datasets are not
part of the public matrix container. Older Actions/QEMU and AI evidence remains
historical; it does not describe the new pilot execution path.

Earlier retired database backups from 2026-11-02 remain in
`.wrangler/backups/2026-11-02/`. The current change review is
<https://github.com/daksh1403/judge-c2c/pull/15>; it remains unmerged.
