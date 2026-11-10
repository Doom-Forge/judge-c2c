import { expect, test } from '@playwright/test';

test('assigned judge sees tracked PR provenance and recorded evaluation evidence', async ({
  page,
}) => {
  await page.route('**/api/organization/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/organization/status') {
      return route.fulfill({
        json: {
          organization: 'Fixture',
          authenticated: true,
          role: 'judge',
          identity: { id: 'judge-a', name: 'Judge A', role: 'judge' },
        },
      });
    }
    if (url.pathname === '/api/organization/round-two/assignments') {
      return route.fulfill({
        json: {
          assignments: [{ team_id: 'team-a', revoked_at: null }],
        },
      });
    }
    if (url.pathname === '/api/organization/round-two/teams') {
      return route.fulfill({
        json: { teams: [{ id: 'team-a', name: 'Alpha' }] },
      });
    }
    if (url.pathname === '/api/organization/round-two/teams/team-a') {
      return route.fulfill({
        json: {
          team: { id: 'team-a', name: 'Alpha' },
          repositories: [],
          members: [],
          submissions: [],
          documents: [],
          matrixSubmissions: [
            {
              full_name: 'fixture/alpha',
              pr_number: 17,
              head_sha: 'abc123def456',
              author_login: '<script>judge</script>',
              author_id: 42,
              mapping_status: 'NEEDS_REVIEW',
              mapping_reason: '<img src=x onerror=alert(1)>',
              updated_at: '2026-11-08 12:30:00',
              closed: 1,
              latest_run_id: 'run-17',
              evaluation_status: 'FAILED',
              failure_code: 'CHECKS_UNAVAILABLE',
              report: {
                summary: 'Recorded evaluation; no CI checks were inferred.',
                assessments: [
                  {
                    criterionId: 'tests',
                    status: 'UNVERIFIED',
                    explanation: 'Execution evidence was unavailable.',
                  },
                ],
              },
            },
            {
              full_name: 'bad/repo?x=<script>',
              pr_number: '17/onerror=alert(1)',
              head_sha: 'head-2',
              mapping_status: 'MAPPED',
              evaluation_status: null,
              report: null,
            },
          ],
        },
      });
    }
    if (url.pathname === '/api/organization/round-two/reviews') {
      return route.fulfill({
        json: {
          currentDocument: null,
          documentStale: false,
          submissions: [],
          draft: null,
          rubric: { criteria: [] },
        },
      });
    }
    return route.fulfill({
      status: 403,
      json: { error: 'UNEXPECTED_ROUTE' },
    });
  });

  await page.goto('/review.html?organization=1');
  await page.getByRole('button', { name: /Open review workspace/ }).click();
  await page.getByRole('button', { name: 'Pull Request (90%)' }).click();

  const evidence = page.locator('#team-review-content');
  await expect(evidence.getByText('abc123def456')).toBeVisible();
  await expect(evidence.getByText('<script>judge</script>')).toBeVisible();
  await expect(evidence.getByText(/GitHub user ID 42/)).toBeVisible();
  await expect(
    evidence.getByText('<img src=x onerror=alert(1)>'),
  ).toBeVisible();
  await expect(evidence.getByText('2026-11-08 12:30:00')).toBeVisible();
  await expect(evidence.getByText('Closed')).toBeVisible();
  await expect(evidence.getByText('run-17')).toBeVisible();
  await expect(evidence.getByText('CHECKS_UNAVAILABLE')).toBeVisible();
  await expect(
    evidence.getByText('Execution evidence was unavailable.'),
  ).toBeVisible();
  await expect(evidence.locator('script, img')).toHaveCount(0);
  await expect(
    evidence.locator('a[href="https://github.com/fixture/alpha/pull/17"]'),
  ).toHaveCount(1);
  await expect(evidence.locator('a[href*="bad/repo"]')).toHaveCount(0);
  await expect(
    evidence.getByText('Evaluation evidence unavailable.'),
  ).toBeVisible();
});
