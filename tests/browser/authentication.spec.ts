import { test, expect } from '@playwright/test';

test('organizer can unlock, navigate, and lock the live workspace', async ({
  page,
  context,
}) => {
  const credential = 'browser-test-organizer-credential-1234567890';
  const authorization = `Bearer ${credential}`;
  await page.route('**/api/overview', (route) =>
    route.request().headers().authorization === authorization
      ? route.fulfill({
          json: {
            demo: false,
            counts: {
              repositories: 0,
              teams: 0,
              openSubmissions: 0,
              active: 0,
              completed: 0,
              failed: 0,
              attention: 0,
            },
            runs: [],
          },
        })
      : route.fulfill({ status: 401, json: { error: 'UNAUTHORIZED' } }),
  );
  await page.route('**/api/repositories', (route) =>
    route.request().headers().authorization === authorization
      ? route.fulfill({ json: { repositories: [] } })
      : route.fulfill({ status: 401, json: { error: 'UNAUTHORIZED' } }),
  );

  await page.goto('/');
  await expect(
    page.getByLabel('Organizer credential', { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Organizer credential', { exact: true })
    .fill(credential);
  await page
    .getByRole('button', { name: 'Unlock workspace', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Lock workspace', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Organizer credential', { exact: true }),
  ).toHaveValue('');
  expect(page.url()).not.toContain(credential);
  expect(JSON.stringify(await context.storageState())).not.toContain(
    credential,
  );

  await page
    .getByRole('button', { name: 'Repositories', exact: false })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Registered repositories' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Lock workspace', exact: true })
    .click();
  await expect(
    page.getByLabel('Organizer credential', { exact: true }),
  ).toBeVisible();

  await page
    .getByLabel('Organizer credential', { exact: true })
    .fill(credential);
  await page.getByLabel('Organizer credential', { exact: true }).press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Registered repositories' }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Organizer credential', { exact: true }),
  ).toBeHidden();
});
