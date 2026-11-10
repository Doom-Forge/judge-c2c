import { test, expect } from '@playwright/test';

test('container matrix preserves null scores, baseline evidence and retry history', async ({
  page,
  context,
}) => {
  const credential = 'synthetic-matrix-organizer';
  const categories = {
    scalability: { status: 'PASS', score: 100 },
    security: { status: 'UNVERIFIED', score: null },
    usefulness: { status: 'FAIL', score: 0 },
  };
  const failed = {
    id: 'attempt-1',
    repository_id: 'repo-1',
    full_name: 'pilot/example',
    pr_number: 7,
    head_sha: 'a'.repeat(40),
    baseline_sha: 'b'.repeat(40),
    state: 'FAILED',
    created_at: '2026-11-04T09:00:00Z',
    failure_code: 'CONTAINER_UNAVAILABLE',
    matrix_version: 'pilot-v1',
    report: {
      categories,
      overallScore: null,
      checks: [
        {
          id: '<script>hostile</script>',
          category: 'usefulness',
          status: 'FAIL',
          durationMs: 42,
          detail: '<img src=x onerror=alert(1)>',
        },
      ],
      baseline: {
        categories: {
          ...categories,
          usefulness: { status: 'PASS', score: 100 },
        },
        overallScore: null,
        checks: [
          {
            id: '<script>hostile</script>',
            status: 'PASS',
            durationMs: 21,
            detail: 'Reference accepted',
          },
        ],
      },
    },
  };
  const retry = {
    ...failed,
    id: 'attempt-2',
    state: 'QUEUED',
    report: null,
    failure_code: null,
  };
  let retried = false;
  let unauthorized = false;
  await page.route('**/api/matrix/**', async (route) => {
    expect(route.request().headers().authorization).toBe(
      `Bearer ${credential}`,
    );
    if (unauthorized)
      return route.fulfill({ status: 401, json: { error: 'UNAUTHORIZED' } });
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/retry')) {
      expect(route.request().method()).toBe('POST');
      retried = true;
      return route.fulfill({ json: { id: retry.id } });
    }
    if (url.pathname.endsWith('/overview'))
      return route.fulfill({
        json: {
          repositories: [{ id: 'repo-1', full_name: 'pilot/example' }],
          runs: retried ? [retry, failed] : [failed],
          mode: 'cloudflare-containers',
        },
      });
    return route.fulfill({
      json: url.pathname.endsWith('/attempt-2') ? retry : failed,
    });
  });
  await page.goto('/matrix.html');
  await expect(
    page.getByRole('heading', { name: 'Organizer workspace' }),
  ).toBeVisible();
  await page.getByLabel('Organizer credential').fill(credential);
  await page.getByRole('button', { name: 'Unlock workspace' }).click();
  await expect(
    page.getByRole('heading', { name: 'PR #7 · Container results' }),
  ).toBeVisible();
  await expect(
    page.getByText('Execution error: CONTAINER_UNAVAILABLE.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('.matrix-score.total .number')).toHaveText('—');
  await expect(
    page
      .locator('.matrix-score')
      .nth(1)
      .getByText('UNVERIFIED', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.baseline-evidence')).toContainText(
    'Baseline: PASS · 21 ms',
  );
  await expect(
    page.getByText('<img src=x onerror=alert(1)>', { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.matrix-evidence img, .matrix-evidence script'),
  ).toHaveCount(0);
  expect(JSON.stringify(await context.storageState())).not.toContain(
    credential,
  );
  await expect(page.getByLabel('Organizer credential')).toHaveValue('');
  await page.getByRole('button', { name: 'Create retry attempt' }).click();
  await expect(page.locator('#detail')).toContainText('attempt-2');
  await expect(page.locator('#detail')).toContainText('QUEUED');
  await expect(page.locator('.run-choice')).toHaveCount(2);
  await expect(page.locator('.matrix-score.total .number')).toHaveText('—');
  unauthorized = true;
  await page.getByRole('button', { name: 'Refresh results' }).click();
  await expect(
    page.getByRole('heading', { name: 'Organizer workspace' }),
  ).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();
});

test('completed container results show three scores and the overall baseline delta', async ({
  page,
}) => {
  const run = {
    id: 'complete',
    repository_id: 'repo',
    full_name: 'pilot/passing',
    pr_number: 9,
    head_sha: 'a'.repeat(40),
    baseline_sha: 'b'.repeat(40),
    state: 'COMPLETED',
    created_at: '2026-11-04T09:00:00Z',
    failure_code: null,
    report: {
      categories: {
        scalability: { status: 'PASS', score: 100 },
        security: { status: 'PASS', score: 100 },
        usefulness: { status: 'PARTIAL', score: 70 },
      },
      overallScore: 90,
      checks: [],
      baseline: { overallScore: 80 },
    },
  };
  await page.route('**/api/matrix/**', (route) =>
    route.fulfill({
      json: route.request().url().endsWith('/overview')
        ? {
            repositories: [{ id: 'repo', full_name: 'pilot/passing' }],
            runs: [run],
            mode: 'cloudflare-containers',
          }
        : run,
    }),
  );
  await page.goto('/matrix.html');
  await page.getByLabel('Organizer credential').fill('synthetic');
  await page.getByRole('button', { name: 'Unlock workspace' }).click();
  await expect(page.locator('.matrix-score .number')).toHaveText([
    '100.0',
    '100.0',
    '70.0',
    '90.0',
  ]);
  await expect(page.locator('.matrix-score.total')).toContainText(
    '+10.0 points vs baseline',
  );
  await page.getByRole('button', { name: 'Lock workspace' }).click();
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.getByLabel('Organizer credential')).toHaveValue('');
});

test('GitHub check deep link selects the requested attempt after unlocking and exposes provenance', async ({
  page,
}) => {
  const requestedId = 'c'.repeat(64);
  const firstId = 'd'.repeat(64);
  const run = {
    id: requestedId,
    repository_id: 'repo',
    full_name: 'pilot/linked',
    pr_number: 21,
    head_sha: 'a'.repeat(40),
    baseline_sha: 'b'.repeat(40),
    state: 'COMPLETED',
    created_at: '2026-11-04',
    matrix_version: 'v1',
    matrix_digest: 'sha256:matrix-proof',
    image_uri: 'registry/pilot@sha256:pinned',
    report: {
      image: 'registry/pilot@sha256:executed',
      overallScore: null,
      checks: [],
    },
  };
  await page.route('**/api/matrix/**', (route) => {
    if (route.request().url().endsWith('/overview'))
      return route.fulfill({
        json: {
          repositories: [],
          runs: [{ ...run, id: firstId, pr_number: 1 }, run],
          mode: 'cloudflare-containers',
        },
      });
    return route.fulfill({
      json: route.request().url().endsWith(requestedId)
        ? run
        : { ...run, id: firstId, pr_number: 1 },
    });
  });
  await page.goto(`/matrix.html#${requestedId}`);
  await page.getByLabel('Organizer credential').fill('synthetic');
  await page.getByRole('button', { name: 'Unlock workspace' }).click();
  await expect(
    page.getByRole('heading', { name: 'PR #21 · Container results' }),
  ).toBeVisible();
  await expect(page.locator('.matrix-meta')).toContainText(
    'sha256:matrix-proof',
  );
  await expect(page.locator('.matrix-meta')).toContainText(
    'registry/pilot@sha256:pinned',
  );
  await expect(page.locator('.matrix-meta')).toContainText(
    'registry/pilot@sha256:executed',
  );
  const accessibility = await page
    .getByRole('region', { name: 'Run details' })
    .ariaSnapshot();
  expect(accessibility).toContain('heading "Scalability / 100" [level=3]');
  expect(accessibility).toContain('button "Create retry attempt"');
  expect(accessibility).toContain('term: Matrix digest');
  expect(accessibility).toContain('definition: sha256:matrix-proof');

  await page
    .getByRole('button', { name: 'pilot/linked · PR #1', exact: false })
    .click();
  await expect(page).toHaveURL(new RegExp(`#${firstId}$`));
});
