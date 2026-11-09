import { expect, test } from '@playwright/test';

test('participant dashboard shows only its team, selected track, and tracked PR progress', async ({
  page,
}) => {
  const paths: string[] = [];
  await page.route('**/api/organization/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(path);
    if (path === '/api/organization/status') {
      return route.fulfill({
        json: {
          authenticated: true,
          role: 'participant',
          organization: 'Fixture',
          identity: {
            name: 'Member One',
            role: 'participant',
            teamId: 'untrusted-other-team',
          },
        },
      });
    }
    if (path === '/api/organization/participant') {
      return route.fulfill({
        json: {
          team: {
            id: 'session-team',
            name: 'Session Team',
            status: 'ACTIVE',
          },
          track: { repositoryId: 12, fullName: 'fixture/own-track' },
          submissions: [
            {
              repository_id: 12,
              pr_number: 42,
              head_sha: 'b'.repeat(40),
              status: 'VALID',
              full_name: 'fixture/own-track',
              mapping_status: 'TRACKED',
              evaluation_status: 'RUNNING',
            },
          ],
          evaluations: [
            {
              id: 'a'.repeat(64),
              repository_id: 12,
              pr_number: 42,
              head_sha: 'b'.repeat(40),
              state: 'RUNNING',
            },
          ],
        },
      });
    }
    return route.fulfill({
      status: 403,
      json: { error: 'PARTICIPANT_SCOPE_REQUIRED' },
    });
  });
  await page.goto('/review.html?organization=1');
  await expect(
    page.getByRole('heading', { name: 'Session Team', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('fixture/own-track · repository 12', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/PR #42/).first()).toBeVisible();
  await expect(page.getByText(/TRACKED/)).toBeVisible();
  await expect(page.getByText(/RUNNING/)).toBeVisible();
  await expect(
    page.getByText('Active member list unavailable.', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('#participant-workspace button')).toHaveCount(0);
  await expect(page.getByText(/other-team|other team/i)).toHaveCount(0);
  expect(paths).toEqual([
    '/api/organization/status',
    '/api/organization/participant',
  ]);
});
