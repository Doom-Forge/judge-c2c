# Doomforge Judge Flow Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a role-aware dashboard that uses authenticated competition data and supports a complete judge review flow from assigned queue through evidence, draft, submission, and history.

**Architecture:** Keep the React application as the dashboard shell. Route organizer overview/team operations to the existing organizer command center, participant routes to the existing participant dashboard, and judge routes to an API-backed queue/workspace/history. Use authenticated same-origin APIs for all product data and keep mock records in test fixtures only.

**Tech Stack:** React 19, TypeScript, React Router, Vite, Playwright, existing Cloudflare Worker same-origin APIs.

## Global Constraints

- Preserve evaluation integrity above model sophistication or speed.
- Marks stay on the authenticated dashboard. GitHub receives only the DoomBot evaluating notice and avatar; never publish category scores or marks to GitHub.
- Contracts, assignments, baseline and head are immutable evaluation inputs. Preserve failed and superseded history. Retries create new attempts.
- Feature work stays on a feature branch or coherent open PR; never merge or push feature work to main without explicit user authorization.
- Use synthetic fixtures or isolated test resources for review deployments; never copy production secrets/bindings into previews.
- Run `npm run ui:typecheck`, `npm run ui:build`, and `npm run ui:test` for this frontend work. Do not commit, push, or deploy during recovery.
- Do not ship a product demo mode, demo role selector, sample record fallback, or simulated write path. Test fixtures may use synthetic records only inside tests.

---

## Files and ownership

- `frontend/src/app/app.tsx`: session-aware role routing, sign-in/out route handling, organizer and participant route wiring.
- `frontend/src/app/session-notice.tsx`: accessible live-session sign-in affordance and explicit demo entry.
- `frontend/src/lib/api.ts`: same-origin API helpers for login/logout/status and typed round-two reads/writes.
- `frontend/src/features/overview/judge-overview.tsx`: live assigned queue, filtering, counts, activity derived from API records, and team navigation.
- `frontend/src/features/judge/judge-workspace.tsx`: existing review workspace loaded from the selected team API scope.
- `frontend/src/features/judge/judge-workspace-helpers.ts`: scoring and validation helpers, avoiding ambiguous `.ts`/`.tsx` resolution.
- `frontend/src/features/organizer/command-center.tsx`: only minimal route anchors or props if required to expose real organizer sections.
- `frontend/src/features/participant/participant-dashboard.tsx`: only correct authenticated participant/results display wiring if needed.
- `frontend/playwright.config.ts`: include the new queue/workspace regression suite.
- `frontend/tests/*`: authenticated queue, evidence, draft/submit/revision/history, API error and stale-response regressions.
- `docs/superpowers/plans/2026-11-08-judge-flow-recovery.md`: this execution plan.

Shared styles and layout components (`frontend/src/components/layout/*`, CSS files) are owned by the dashboard design worker and are outside this plan's edit scope.

## Task 1: Add failing React route and authenticated queue tests

**Files:**
- Modify: `frontend/tests/shell.spec.ts`
- Create: `frontend/tests/judge-flow.spec.ts`
- Modify: `frontend/playwright.config.ts`

- [ ] Add Playwright fixtures for `/api/organization/status`, assigned teams, team details, review GET responses, and review POST responses.
- [ ] Assert live judge `/queue` loads assigned teams and accurate counts, and opens `/workspace?teamId=...`.
- [ ] Assert an empty assigned queue has an explicit empty state and does not fall back to fixture/demo submissions.
- [ ] Include `judge-flow.spec.ts` in the frontend Playwright config and run it to establish failures before implementation.

## Task 2: Wire session controls and role-aware routes

**Files:**
- Modify: `frontend/src/app/app.tsx`
- Modify: `frontend/src/app/session-notice.tsx`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/features/organizer/command-center.tsx` only if an anchor or prop is needed.

- [ ] Add same-origin login/logout calls using the existing `/api/organization/login` and `/api/organization/logout` contract; refresh session status after login and clear state after logout.
- [ ] Render a functional sign-in control when signed out. Keep product routes and account identity role-driven by the authenticated session only.
- [ ] Route organizer `/`, `/teams`, `/assignments`, `/deadlines`, `/communications`, `/results` to real existing organizer views or meaningful anchored sections; do not display placeholder pages for these paths.
- [ ] Route judge `/` and `/queue` to live assigned queue, `/workspace` to the API-backed team workspace, and `/history` to submitted review history.
- [ ] Route participant `/`, `/submission`, and `/evaluation` to the existing participant dashboard.
- [ ] Gate each route by authenticated role and do not render records while signed out.

## Task 3: Connect judge overview and workspace to live review APIs

**Files:**
- Modify: `frontend/src/features/overview/judge-overview.tsx`
- Modify: `frontend/src/features/judge/judge-workspace.tsx`
- Rename: `frontend/src/features/judge/judge-workspace.ts` to `frontend/src/features/judge/judge-workspace-helpers.ts`
- Modify: `frontend/tests/judge-workspace.spec.ts`

- [ ] Load assigned teams, deadlines, and team detail from `/api/organization/round-two/teams` and `/teams/:teamId`.
- [ ] Derive queue totals and status counts from fetched teams and actual submissions; remove constant metric values and fabricated activity.
- [ ] Add search/filter/sort behavior over the assigned live team records and a visible error/retry state.
- [ ] Load Analysis and Engineering data from `/reviews?teamId=...&stage=...`; preserve current draft, submission, rubric pinning, stale document and revision validation.
- [ ] Preserve same-origin document downloads and provide visible action success/error feedback.
- [ ] Ensure async responses cannot replace data for a newer team/stage selection.
- [ ] Do not add local simulated mutation paths; all successful live mutations must be confirmed by the server response.

## Task 4: Verify end-to-end review flow and limitations

**Files:**
- Modify: `frontend/tests/judge-flow.spec.ts`
- Modify: `frontend/playwright.config.ts`

- [ ] Cover evidence display and downloads, draft save, final submission lock, revision reason, and review history using API fixtures.
- [ ] Cover API failure and delayed stale response behavior.
- [ ] Run `npm run ui:typecheck`, `npm run ui:build`, and `npm run ui:test`.
- [ ] Run focused root round-two review and browser integration checks against synthetic fixtures where the local Worker configuration supports them.
- [ ] Report any limitation that prevents a real authenticated local API run; do not claim that fixture tests prove a production GitHub installation.

## Spec coverage and boundaries

This plan implements the existing judge experience priority: assigned queue, team/PR/evidence inspection, private review drafts and submissions, revision history, authenticated role scoping, and visible loading/error/empty states. It does not add new evaluation criteria, GitHub publication behavior, AI judging, or production deployment changes.
