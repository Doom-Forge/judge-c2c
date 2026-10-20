import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const evidence = JSON.parse(
  await readFile(
    'docs/qa/current-production-original-rehearsal-validation.json',
    'utf8',
  ),
);
const retryOnly = process.env.REHEARSAL_PR8_RETRY === 'true';
if (retryOnly) {
  const retry = JSON.parse(
    await readFile('docs/qa/current-production-pr8-retry.json', 'utf8'),
  );
  assert.equal(retry.status, 'PASS');
  evidence.evaluations = [retry];
}
const outputStem = retryOnly
  ? 'docs/qa/current-production-pr8-retry-decisions'
  : 'docs/qa/current-production-judge-decisions';
const origin = evidence.origin;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const output = {
  at: new Date().toISOString(),
  origin,
  boundary:
    'Pre-event single-owner calibration assignment only. Decisions do not award event credit or claim successful AI review.',
  decisions: [],
  guards: [],
};
try {
  await page.goto(origin + '/?organization=1');
  await page
    .locator('#organization-token')
    .fill(
      (
        await readFile(
          process.env.ORGANIZER_TOKEN_FILE ||
            '.wrangler/production-organization-access.txt',
          'utf8',
        )
      ).trim(),
    );
  await page.locator('#organization-login').getByRole('button').click();
  await page.locator('[data-tab="issues"]').waitFor();
  await page.locator('[data-tab="issues"]').click();
  const loaded = page.waitForResponse((r) =>
    /\/manage\/issues\/1371407339\/6$/.test(r.url()),
  );
  await page.locator('[data-detail="issues/1371407339/6"]').click();
  const detail = await (await loaded).json();
  const assignment = detail.assignments.find(
    (a) => a.team_id === evidence.team.id && a.status === 'ACTIVE',
  );
  assert.ok(assignment);
  output.assignmentId = assignment.id;
  const form = page.locator('#assignment-decision');
  async function decide(run, decision, reason, expected) {
    const existing = detail.decisions.find(
      (d) =>
        d.run_id === run.runId &&
        d.decision === decision &&
        d.reason === reason,
    );
    if (expected === 201 && existing)
      return {
        pr: run.pr,
        runId: run.runId,
        decision,
        reused: true,
        result: existing,
      };
    await form.locator('[name="assignmentId"]').fill(assignment.id);
    await form.locator('[name="decision"]').selectOption(decision);
    await form.locator('[name="runId"]').fill(run.runId);
    await form.locator('[name="reason"]').fill(reason);
    const pending = page.waitForResponse(
      (r) =>
        r
          .url()
          .endsWith('/manage/assignments/' + assignment.id + '/completion') &&
        r.request().method() === 'POST',
    );
    await form.getByRole('button').click();
    const response = await pending,
      body = await response.json();
    assert.equal(response.status(), expected, JSON.stringify(body));
    if (expected === 409) assert.equal(body.error, 'REQUIREMENTS_NOT_VERIFIED');
    return {
      pr: run.pr,
      runId: run.runId,
      decision,
      http: response.status(),
      result: body,
    };
  }
  for (const pr of retryOnly ? [8] : [8, 9]) {
    const run = evidence.evaluations.find((r) => r.pr === pr);
    assert.ok(run);
    assert.ok(
      run.requirements.some((r) => r.status !== 'PASS') ||
        run.evidence.some((e) => e.kind === 'policy' && e.status === 'FAIL'),
    );
    output.guards.push(
      await decide(
        run,
        'ACCEPTED',
        'Rehearsal guard probe: acceptance must fail when objective criteria are unavailable or protected tests were changed. No override requested.',
        409,
      ),
    );
    output.decisions.push(
      await decide(
        run,
        'CHANGES_REQUESTED',
        retryOnly
          ? 'Pre-event rehearsal only: trusted execution proves retry-bounded FAIL while the other three criteria PASS. The mandatory attempt limit is missing; request changes. AI quota exhaustion remains UNVERIFIED and cannot waive this failure.'
          : pr === 8
            ? 'Pre-event rehearsal only: objective criteria remain UNVERIFIED because RUNNER_UNAVAILABLE. Retry as a new attempt after runner recovery; AI_OUTPUT_INVALID does not prove functionality.'
            : 'Pre-event rehearsal only: protected server.test.mjs was changed. Trusted policy failure prevents acceptance even when functional probes pass. AI remains unverified.',
        201,
      ),
    );
  }
  if (!retryOnly) {
    const run = evidence.evaluations.find((r) => r.pr === 7);
    assert.ok(run);
    assert.ok(run.requirements.every((r) => r.status === 'PASS'));
    assert.ok(
      !run.evidence.some((e) => e.kind === 'policy' && e.status === 'FAIL'),
    );
    output.decisions.push(
      await decide(
        run,
        'ACCEPTED',
        'Pre-event calibration only, no event credit: mandatory retry criteria have trusted execution PASS and protected tests are unchanged. Accept this objective scope; failed AI remains UNVERIFIED and requires separate manual contextual review.',
        201,
      ),
    );
  }
  const reloaded = page.waitForResponse((r) =>
    /\/manage\/issues\/1371407339\/6$/.test(r.url()),
  );
  await page.locator('[data-detail="issues/1371407339/6"]').click();
  const persisted = await (await reloaded).json();
  output.persistedDecisions = persisted.decisions;
  for (const d of output.decisions)
    assert.ok(
      persisted.decisions.some(
        (p) => p.run_id === d.runId && p.decision === d.decision,
      ),
    );
  await page.screenshot({
    path: outputStem + '.png',
    fullPage: true,
  });
  output.status = 'PASS';
} catch (e) {
  output.status = 'FAIL';
  output.failure = e.message;
  process.exitCode = 1;
} finally {
  await writeFile(outputStem + '.json', JSON.stringify(output, null, 2) + '\n');
  await browser.close();
  console.log(
    JSON.stringify({
      status: output.status,
      failure: output.failure,
      decisions: output.decisions.map((d) => ({
        pr: d.pr,
        decision: d.decision,
      })),
    }),
  );
}
