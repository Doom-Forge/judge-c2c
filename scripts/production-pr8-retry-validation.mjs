import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const prior = JSON.parse(
  await readFile(
    'docs/qa/current-production-original-rehearsal-validation.json',
    'utf8',
  ),
).evaluations.find((r) => r.pr === 8);
const origin = 'https://judge-c2c-production.dakshx.workers.dev';
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage();
const output = {
  at: new Date().toISOString(),
  origin,
  pr: 8,
  previousRunId: prior.runId,
  boundary:
    'New attempt for the original deliberately partial pre-event submission. One owner, no event credit or capacity claim.',
  downloads: [],
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
  await page
    .getByRole('heading', { name: 'Hackathon workflow', exact: true })
    .waitFor();
  await page.goto(origin + '/?organization=1&evaluation=' + prior.runId);
  await page.locator('#retry-evaluation').waitFor();
  const created = page.waitForResponse(
    (r) => r.url().includes('/retry') && r.request().method() === 'POST',
  );
  await page.locator('#retry-evaluation').click();
  const response = await created,
    body = await response.json();
  assert.ok(response.status() < 300, JSON.stringify(body));
  output.retry = body;
  output.runId = body.runId || body.id;
  assert.ok(output.runId);
  assert.notEqual(output.runId, prior.runId);
  console.log(
    JSON.stringify({ runId: output.runId, stage: 'queued-new-attempt' }),
  );
  const finished = page.waitForResponse(
    async (r) => {
      if (!r.url().endsWith('/api/organization/evaluations/' + output.runId))
        return false;
      const run = await r.json();
      return ['COMPLETED', 'FAILED', 'SUPERSEDED'].includes(run.state);
    },
    { timeout: 300000 },
  );
  await page.goto(origin + '/?organization=1&evaluation=' + output.runId);
  const run = await (await finished).json();
  output.state = run.state;
  output.head = run.head_sha;
  output.baseline = run.baseline_sha;
  output.ai = run.ai_status;
  output.publication = run.publication_status;
  const report =
    typeof run.report === 'string' ? JSON.parse(run.report) : run.report;
  output.aiFailure = report?.aiTrace?.failureCode;
  output.requirements = run.requirementResults;
  output.evidence =
    typeof run.evidence === 'string' ? JSON.parse(run.evidence) : run.evidence;
  output.artifacts = run.artifacts;
  assert.equal(run.head_sha, prior.head);
  assert.equal(run.state, 'COMPLETED');
  assert.ok(output.requirements.some((r) => r.status === 'PARTIAL'));
  assert.ok(
    output.evidence.some(
      (e) =>
        e.criterionId === 'retry-bounded' &&
        e.kind === 'execution' &&
        e.status === 'FAIL',
    ),
  );
  for (const kind of ['evidence', 'report', 'execution-submission-1']) {
    const artifact = run.artifacts.find(
      (a) => a.kind === kind && a.status === 'STORED',
    );
    assert.ok(artifact);
    const url =
        '/api/organization/artifact?key=' + encodeURIComponent(artifact.key),
      pending = page.waitForEvent('download');
    await page.locator('a[href="' + url + '"]').click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    const bytes = await readFile(await download.path());
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256, artifact.sha256);
    assert.equal(bytes.length, artifact.bytes);
    output.downloads.push({
      kind,
      bytes: bytes.length,
      sha256,
      status: 'PASS',
    });
  }
  await page.screenshot({
    path: 'docs/qa/current-production-pr8-retry.png',
    fullPage: true,
  });
  output.status = 'PASS';
} catch (e) {
  output.status = 'FAIL';
  output.failure = e.message;
  process.exitCode = 1;
} finally {
  await writeFile(
    'docs/qa/current-production-pr8-retry.json',
    JSON.stringify(output, null, 2) + '\n',
  );
  await browser.close();
  console.log(
    JSON.stringify({
      status: output.status,
      runId: output.runId,
      failure: output.failure,
      ai: output.ai,
      aiFailure: output.aiFailure,
    }),
  );
}
