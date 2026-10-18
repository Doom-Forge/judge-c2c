# Doom-Forge event activation

The owner selected **Doom-Forge** as the sole active event organization. Its GitHub ID is `339267430`. Authenticated inspection confirmed `daksh1403` has active owner/admin membership and access to `Doom-Forge/Bot-Backend` (ID `1409179117`). That repository remains private. Access does not establish judging criteria or assignments.

## Prepared deployment

Use workspace `doom-forge` and origin `https://judge-c2c-doom-forge.dakshx.workers.dev`. The existing generator gives it a separate Worker, two Workflows, two empty D1 databases and artifact KV namespace. Select `--artifact-storage kv`: R2 is not enabled on the account. KV retains its platform size and quota limits.

Select `--runner-mode ACTIONS_VM`, public runner repository `daksh1403/judge-c2c` (ID `1400414482`), and image `qemu-vm@sha256:bffe6808899f23b08694a4d8e367ddcdc411856ca87135f3d2c5f67b44819e71`. Tested release `vm-node-v1-20261007` is published. The runner App installation is `169239138`, restricted to that repository. The deployed workflow is pinned to approved main commit `fba7867de640177cd1a60a0800b1a5c997bef39d`. A future main update requires a reviewed update of that pin before new dispatches.

Gemini `gemini-3.1-flash-lite` passed connectivity and three actual provider reviews of source-only synthetic cases. Groq `openai/gpt-oss-120b` passed connectivity and two cases; its protected-file case failed and is retained. Both keys are in ignored private storage and installed on the Doom-Forge Worker through its private setup path. Previews remain credential-free. Gemini is the prepared default, without hidden fallback.

## Ordered tasks

1. Complete workspace code, full checks, PR CI and credential-free Cloudflare review. This prepares the interface, not a live organization connection.
2. Register the Doom-Forge evaluation App with Contents/PR read and Issues/Checks write. Register a separate runner App restricted to Actions write/Contents read on the runner repository. Verify actual ownership, permissions, IDs and selected repositories; store keys only in the backend.
3. Obtain explicit approval for stacked PR #11/#12 merges and production deployment. Publish the tested image and pin the approved main workflow SHA.
4. Provision the fresh Doom-Forge workspace using Actions, KV artifacts, the real runner installation and selected provider. Apply all migrations to both new databases, install secrets and deploy approved main code.
5. Register/install the evaluation App through the new workspace. Verify repository reads, signed webhooks, Actions OIDC execution, reviewer output and frontend evidence. Missing behavior remains UNVERIFIED.
6. Retire previous live event workspaces using a freshly verified replacement receipt. Remove their App installations, fence intake and retain immutable history as a read-only archive. Historical evidence must not be rewritten to claim it ran on Doom-Forge.
7. Register the actual 80 teams/members/repositories, issue criteria, frozen baselines and assignments. Exercise a real participant PR and hostile-workload/capacity/recovery rehearsals before declaring event readiness.

## Verified deployment, 8 October 2026

PRs #12 and #11 were merged with explicit owner approval. Doom-Forge now runs approved main code with separate databases, Workflows and artifact KV. Its evaluation App is `judge-c2c-doom-forge` (ID `5237022`), installation `169239051`, selected only for `Doom-Forge/Bot-Backend`. The runner App is separate and selected only for the public runner repository. App keys, webhook secret and organizer credentials remain private.

The actual deployed synthetic baseline and submission diagnostics completed through GitHub Actions and exact OIDC validation: the expected absent behavior failed and the reference behavior passed. The two successful jobs are [37782710726](https://github.com/daksh1403/judge-c2c/actions/runs/37782710726) and [37782857117](https://github.com/daksh1403/judge-c2c/actions/runs/37782857117). A valid synthetic webhook signature returned 200; an invalid signature returned 401. GitHub redelivered its actual signed setup ping successfully at 13:24 UTC (HTTP 200), preserving the original pre-deployment 404 delivery history. Public health and assets returned 200; unauthenticated organization status exposed no App details.

The first deployed provider diagnostic did not complete; a separate explicit retry completed with Gemini. Its trace retained `AI_UNVERIFIED_OBSERVED` from the first model attempt and marked unsupported narrative claims for human attention. This is synthetic review evidence, not a participant evaluation or model quality guarantee. Subsequent fresh replacement checks again reported provider UNAVAILABLE while their Actions checks passed. AI diagnostic consistency and wider calibration remain readiness work; a successful retry does not erase these failures. Groq is configured but has not been selected as the live provider.

## Remaining event inputs and readiness

The selected event repository currently contains only README.md and .gitignore, has no open issues and remains private. No real team assignments, authoritative event contracts or participant evaluation have been created. Event organizers must supply the actual team/member list, repository code, issues, acceptance criteria, resource policy and deadline. Frozen baselines and assignments can then be registered and a real PR evaluated through webhook, execution, review, dashboard and GitHub publication.

The first VM profile supports bounded Node workloads; arbitrary languages and offline dependencies remain unsupported. Wider hostile-workload, outage/recovery and simultaneous 80-team rehearsals remain required. KV, Actions and AI provider quotas still apply. The synthetic deployment checks do not establish event capacity or unlimited free operation.

Fresh repository verification passed all 543 tests, all 714 acceptance entries, Worker dry run and all 35 local browser scenarios. These checks are distinct from live diagnostics and participant readiness.

## Previous workspaces retired

Both previous Daksh-Codebase judging workspaces reached RETIRED after fresh Doom-Forge verification. The production installation `167916563` and rehearsal installation `167005353` were uninstalled and their webhook intake is fenced. Production retained its five completed evaluations; rehearsal retained its 49. Historical contracts, assignments, evidence and run records remain in their original read-only archives. The unrelated Daksh-Codebase Workboard App remains installed. Doom-Forge is the sole active event workspace.
