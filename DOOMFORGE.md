# Doomforge — 180DC VIT Chennai judge

This workspace contains the complete Judge-C2C application from
<https://github.com/daksh1403/judge-c2c>, including the Cloudflare Worker,
organization dashboard, GitHub App onboarding and webhooks, issue and PR review,
AI evidence review, migrations, tests, and isolated GitHub Actions/QEMU runner.

Target organization: <https://github.com/180DC-VIT-CHENNAI/>.

Deployment origin: <https://judge-c2c-doomforge.dakshx.workers.dev>.

## Operate this workspace

Use Node 24.14 or a compatible Node 24 release. Install the pinned dependencies
with `npm ci`. Node 26 caused local Wrangler commands to take too long to exit
and prevented the browser test server from starting within its deadline.

The deployment has its own evaluation database, organization database, artifact
KV namespace, two durable Workflows, and fresh console credentials. Its private
Wrangler configuration and provisioning journal are in
`.wrangler/workspaces/doomforge/`. The organizer access code is saved separately
in `.wrangler/organization-access.txt` after deployment. These files are ignored
by Git and must stay private.

The existing Actions runner App dispatches work only to the public
`daksh1403/judge-c2c` runner repository. This workspace pins the workflow ref and
exact commit on `feat/180dc-doomforge-runner`. That branch permits callbacks only
to this deployment's exact origin; the original main workflow's origin remains
unchanged. Runner credentials stay on the Cloudflare backend. Participant code
executes in the digest-pinned guest image, without backend or GitHub credentials.
Changing the runner branch requires updating the pinned workflow SHA in the
private deployment configuration before using it again.

Workers AI supplies the reviewer using
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Availability and grounded output must be
verified through the authenticated reviewer diagnostic; a successful liveness
request alone does not establish judging readiness.

Validate source and the browser flow:

```sh
npm run check
npm audit --audit-level=high
npm run test:browser
```

Deploy the explicitly selected workspace configuration:

```sh
npx wrangler deploy --config .wrangler/workspaces/doomforge/config.json
```

Register and install the organization-owned evaluation GitHub App from the
authenticated organization console. It requires Contents and Pull requests read
access, and Issues and Checks write access. Register actual teams, immutable
baselines, criteria and assignments before evaluating participant work. Do not
invent criteria or award scores to unassigned repositories.

## Preserved old databases

With explicit owner approval on 2026-11-02, the detached old
`judge-c2c-production` and retired `judge-c2c-organization-production` databases
were backed up and deleted to free the two D1 slots required by this workspace.
Their SQL backups and SHA-256/integrity verification records are retained
privately in `.wrangler/backups/2026-11-02/`. Both exports were restored into local
SQLite and passed `PRAGMA integrity_check` before deletion. The retired
organization export retains its five historical evaluations, team and connection.
These historical records are not part of this organization's new databases.

Live deployment, connection and diagnostic receipts are recorded privately in
`.wrangler/operator/`; source tests and synthetic diagnostics do not establish
event capacity or the correctness of real participant submissions.
