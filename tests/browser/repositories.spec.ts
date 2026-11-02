import { test, expect } from '@playwright/test';

test('dashboard repositories show GitHub connections with their judging setup state', async ({
  page,
}) => {
  await page.route('**/api/overview', (route) =>
    route.fulfill({
      json: {
        demo: false,
        counts: {
          repositories: 2,
          teams: 0,
          openSubmissions: 0,
          active: 0,
          completed: 0,
          failed: 0,
          attention: 0,
        },
        runs: [],
      },
    }),
  );
  await page.route('**/api/repositories', (route) =>
    route.fulfill({
      json: {
        repositories: [
          {
            id: 1,
            full_name: 'fixture-org/configured',
            connected: true,
            judgingConfigured: true,
          },
          {
            id: 2,
            full_name: 'fixture-org/needs-setup',
            connected: true,
            judgingConfigured: false,
          },
        ],
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByText('2 repositories · 0 teams')).toBeVisible();
  await page
    .getByRole('button', { name: 'Repositories', exact: false })
    .click();
  await expect(
    page.getByText('fixture-org/configured', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('fixture-org/needs-setup', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Connected to GitHub', { exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByText('Judging configured', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Judging setup required', { exact: true }),
  ).toBeVisible();
});
