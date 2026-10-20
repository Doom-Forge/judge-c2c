import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin =
  process.env.REVIEW_URL || 'https://judge-c2c-production.dakshx.workers.dev';
const browser = await chromium.launch({ headless: true }),
  context = await browser.newContext(),
  page = await context.newPage();
const output = {
  at: new Date().toISOString(),
  origin,
  mode: 'ACTUAL_HEADLESS_FRONTEND_NO_MOCKS_NO_DIRECT_TEST_API_CALLS',
  boundary:
    'Real daksh1403 account and actual original calibration PRs. One real participant, not an event-scale hackathon. AI failures are retained per attempt; successful model review and event capacity are not implied.',
  evaluations: [],
};
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  output.stage = 'login';
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
  await page
    .getByRole('heading', { name: 'Hackathon workflow', exact: true })
    .waitFor({ timeout: 20000 });
  await page.locator('[data-configure]').first().waitFor({ timeout: 20000 });
  output.app = {
    slug: 'judge-c2c-daksh-codebase-prod',
    installationId: 167916563,
  };
  assert.equal(await page.locator('[data-configure]').count(), 1);
  const observed = JSON.parse(
    await readFile(
      'docs/qa/current-production-original-rehearsal.json',
      'utf8',
    ),
  );
  output.team = observed.team;
  output.submissions = observed.submissions;
  output.negativeMapping = observed.negativeMapping;
  for (const pr of [7, 11, 8, 9]) {
    output.stage = 'evaluate-pr-' + pr;
    console.log(JSON.stringify({ stage: output.stage }));
    const runId = output.submissions.find(
      (s) => s.pr_number === pr,
    ).latest_run_id;
    assert.ok(runId);
    const finished = page.waitForResponse(
      async (r) => {
        if (!r.url().endsWith('/api/organization/evaluations/' + runId))
          return false;
        const d = await r.json();
        return ['COMPLETED', 'FAILED', 'SUPERSEDED'].includes(d.state);
      },
      { timeout: 300000 },
    );
    await page.goto(origin + '/?organization=1&evaluation=' + runId);
    const run = await (await finished).json();
    const report =
      typeof run.report === 'string'
        ? JSON.parse(run.report || '{}')
        : run.report || {};
    run.evidence =
      typeof run.evidence === 'string'
        ? JSON.parse(run.evidence || '[]')
        : run.evidence || [];
    const requirements =
      run.requirementResults ?? report.requirementResults ?? [];
    output.evaluations.push({
      pr,
      runId,
      state: run.state,
      ai: run.ai_status,
      head: run.head_sha,
      requirements,
      aiFailure: report.aiTrace?.failureCode,
      publication: run.publication_status,
      artifacts: run.artifacts,
      execution: run.execution,
      evidence: run.evidence,
      attention: run.attentionItems,
    });
    assert.equal(run.state, 'COMPLETED');
    if (run.ai_status === 'FAILED')
      assert.ok(
        report.aiTrace?.failureCode,
        'Failed AI must preserve its actual failure code',
      );
    assert.equal(run.publication_status, 'PUBLISHED');
    output.evaluations.at(-1).objectiveCriteriaPresent = (
      run.evidence || []
    ).some((e) => e.kind === 'execution' && e.criterionId);
    if (pr === 9)
      assert.ok(
        run.evidence.some((e) => e.kind === 'policy' && e.status === 'FAIL'),
      );
    const downloads = [];
    for (const kind of ['evidence', 'report', 'execution-submission-1']) {
      const a = (run.artifacts || []).find(
        (a) => a.kind === kind && a.status === 'STORED',
      );
      if (!a) continue;
      const url = '/api/organization/artifact?key=' + encodeURIComponent(a.key);
      const pending = page.waitForEvent('download');
      await page.locator('a[href="' + url + '"]').click();
      const download = await pending;
      assert.equal(await download.failure(), null);
      const body = await readFile(await download.path());
      const digest = createHash('sha256').update(body).digest('hex');
      assert.equal(digest, a.sha256);
      assert.equal(body.length, a.bytes);
      downloads.push({
        kind,
        bytes: body.length,
        sha256: digest,
        integrity: 'PASS',
      });
    }
    output.evaluations.at(-1).downloadChecks = downloads;
    await page.screenshot({
      path: 'docs/qa/current-production-original-pr' + pr + '.png',
      fullPage: true,
    });
    await page.goto(origin + '/?organization=1');
    await page.locator('[data-tab="submissions"]').click();
  }
  output.status = 'EXISTING_RUNS_AND_ARTIFACTS_INSPECTED';
  output.calibrationComplete = output.evaluations.every(
    (r) => r.objectiveCriteriaPresent,
  );
  output.errors = errors;
  assert.equal(errors.length, 0);
} catch (e) {
  output.status = 'FAIL';
  output.failure = e.message;
  await page.screenshot({
    path: 'docs/qa/current-production-original-validation-failure.png',
    fullPage: true,
  });
} finally {
  await writeFile(
    'docs/qa/current-production-original-rehearsal-validation.json',
    JSON.stringify(output, null, 2) + '\n',
  );
  await browser.close();
  console.log(
    JSON.stringify({
      status: output.status,
      stage: output.stage,
      failure: output.failure,
      runs: output.evaluations.map((r) => ({
        pr: r.pr,
        state: r.state,
        ai: r.ai,
      })),
    }),
  );
  if (output.status === 'FAIL') process.exitCode = 1;
}
