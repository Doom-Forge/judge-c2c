# Doomforge — 180DC Cloudflare container judge

Dashboard: <https://doombot.180dcvitc.org/>.
Organization: <https://github.com/Doom-Forge/>.
Cloudflare account: `Technical.vitc@180dc.org's Account`.

The production dashboard is served by the `doomforge-arena` Worker. It retains
Arena's GitHub OAuth, team, judge, queue, webhook and D1 APIs. The Worker forwards
organization and GitHub App lifecycle paths through its `MATRIX_BACKEND` service
binding to `doomforge-matrix`; browser requests do not receive a backend token.
Arena assets are built from `Judgeing-platform` into this repository's `public/`.

The matrix backend runs the two implemented deterministic profiles for
`noyyal-treasury` and `rasoi-offer-roulette`. PR runs freeze the exact head,
baseline, matrix digest and image. Historical and superseded attempts are
retained. The four additional competition containers (`mazhai-cover`,
`pricingpulse`, `veera-footwear` and `janus`) have runtime classes but still need
approved challenge specifications and source repositories before official
judging can produce marks. The authenticated organizer diagnostic checks those
containers with temporary test code and explicitly produces no competition
marks.

Scores are shown only on the authenticated dashboard. The GitHub App, **DoomBot
180DC**, posts a single avatar-backed “DoomBot is evaluating your PR.” notice per
PR. It does not publish numeric marks or category results to GitHub. New heads and
retries reuse that notice instead of adding duplicate comments.

Actual judging runs exclusively on Cloudflare Containers. There are no AI
bindings or external runner credentials in this deployment. GitHub Actions
workflows were disabled and removed at the owner's request on 2026-11-04; do not
re-enable them. Local Docker is authorized only for image builds and validation.

## Deploy

```sh
npx wrangler deploy --config wrangler.matrix.jsonc
```

Deploy the Arena dashboard and gateway from the `Judgeing-platform` checkout with
`npm run deploy`; its `predeploy` step builds the assets into this repository's
`public/` directory. Deploy the Matrix backend from this repository with the
command above. The committed Matrix configuration binds the private R2 bucket,
organization/evaluation D1 databases, Containers, and the Arena service.
Read [the container runbook](docs/container-matrix.md) before changing an image,
matrix or baseline. Validate new image changes with the isolated sandbox
diagnostic and the existing deterministic profile checks. These checks do not
establish scoring readiness for the four unconfigured challenge profiles or
event-scale capacity; see `matrix-runner/README.md`.

The main organizer credential is kept privately in
`.wrangler/workspaces/technical-matrix/secrets.json` as `ADMIN_TOKEN`. Credentials,
SQL backups, deployment receipts, canary results and screenshots are ignored by
Git and must remain private. The existing organization-owned GitHub App connection
and selected repositories were migrated with the organization database.

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
