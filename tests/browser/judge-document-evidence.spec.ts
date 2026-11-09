import { expect, test } from '@playwright/test';

test('analysis stage shows every stored version as an opaque same-origin download link', async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route('**/api/organization/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
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
          matrixSubmissions: [],
          documents: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              version: 2,
              filename: '<report>.pdf',
              bytes: 22,
              created_at: '2026-11-08 12:00:00',
              status: 'STORED',
            },
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              version: 1,
              filename: 'older.pdf',
              bytes: 18,
              created_at: '2026-11-07 12:00:00',
              status: 'STORED',
            },
          ],
        },
      });
    }
    if (url.pathname === '/api/organization/round-two/reviews') {
      return route.fulfill({
        json: {
          currentDocument: { version: 2, filename: '<report>.pdf' },
          documentStale: false,
          submissions: [],
          draft: null,
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
  const links = page.locator('#team-review-content a[download]');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toContainText('<report>.pdf · version 2');
  await expect(links.nth(1)).toContainText('older.pdf · version 1');
  await expect(links.nth(0)).toHaveAttribute(
    'href',
    '/api/organization/round-two/teams/team-a/documents/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  );
  expect(requests.some((request) => request.includes('object_key'))).toBe(
    false,
  );
  expect(requests.some((request) => request.includes('private/'))).toBe(false);
});
