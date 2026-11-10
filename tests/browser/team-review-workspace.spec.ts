import { expect, test } from '@playwright/test';

test('assigned judge navigates team review stages and returns to the queue', async ({
  page,
}) => {
  const requested: string[] = [];
  await page.route('**/api/organization/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    requested.push(path + url.search);
    if (path === '/api/organization/status')
      return route.fulfill({
        json: {
          organization: 'Fixture',
          authenticated: true,
          role: 'judge',
          identity: { id: 'judge-a', name: 'Judge A', role: 'judge' },
        },
      });
    if (path === '/api/organization/round-two/assignments')
      return route.fulfill({
        json: { assignments: [{ team_id: 'team-a', revoked_at: null }] },
      });
    if (path === '/api/organization/round-two/teams')
      return route.fulfill({
        json: { teams: [{ id: 'team-a', name: 'Alpha' }] },
      });
    if (path === '/api/organization/round-two/teams/team-a')
      return route.fulfill({
        json: {
          team: { id: 'team-a', name: 'Alpha' },
          repositories: [{ full_name: 'fixture/alpha' }],
          members: [],
          submissions: [],
          documents: [
            {
              id: 'doc-a',
              version: 1,
              filename: 'analysis.pdf',
              status: 'STORED',
            },
          ],
          matrixSubmissions: [
            {
              full_name: 'fixture/alpha',
              pr_number: 17,
              head_sha: 'abc123',
              mapping_status: 'MAPPED',
              evaluation_status: 'COMPLETED',
              report: {
                summary: 'Recorded PR evidence',
                assessments: [{ criterionId: 'tests', status: 'PASS' }],
              },
            },
          ],
        },
      });
    if (path === '/api/organization/round-two/reviews') {
      const stage = url.searchParams.get('stage');
      return route.fulfill({
        json: {
          currentDocument:
            stage === 'ANALYSIS'
              ? { id: 'doc-a', version: 1, filename: 'analysis.pdf' }
              : null,
          draft: null,
          drafts: [],
          submissions: [],
          rubric:
            stage === 'ENGINEERING'
              ? { criteria: [{ id: 'tests', label: 'Tests', weight: 100 }] }
              : null,
          rubricError: null,
          documentStale: false,
        },
      });
    }
    return route.fulfill({ status: 403, json: { error: 'UNEXPECTED_ROUTE' } });
  });
  await page.goto('/review.html?organization=1');
  await page.getByRole('button', { name: /Open review workspace/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Alpha review workspace' }),
  ).toBeVisible();
  await expect(page.getByText('analysis.pdf')).toBeVisible();
  await expect(page.getByText('No analysis review submitted.')).toBeVisible();
  await page.getByRole('button', { name: 'Pull Request (90%)' }).click();
  await expect(page.getByText('Recorded PR evidence')).toBeVisible();
  await expect(page.getByText('PASS')).toBeVisible();
  await expect(
    page.getByText('No engineering review submitted.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to assigned teams' }).click();
  await expect(
    page.getByRole('heading', { name: 'Assigned teams' }),
  ).toBeVisible();
  expect(requested).toContain(
    '/api/organization/round-two/reviews?teamId=team-a&stage=ANALYSIS',
  );
  expect(requested).toContain(
    '/api/organization/round-two/reviews?teamId=team-a&stage=ENGINEERING',
  );
});

test('a delayed review response cannot replace the currently selected team', async ({
  page,
}) => {
  let releaseTeamA = () => {};
  let signalTeamAStarted = () => {};
  const teamAStarted = new Promise<void>((resolve) => {
    signalTeamAStarted = resolve;
  });
  const teamARelease = new Promise<void>((resolve) => {
    releaseTeamA = resolve;
  });
  const submittedTeams: string[] = [];
  await page.route('**/api/organization/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/organization/status')
      return route.fulfill({
        json: {
          organization: 'Fixture',
          authenticated: true,
          role: 'judge',
          identity: { id: 'judge-a', name: 'Judge A', role: 'judge' },
        },
      });
    if (path === '/api/organization/round-two/assignments')
      return route.fulfill({
        json: {
          assignments: [
            { team_id: 'team-a', revoked_at: null },
            { team_id: 'team-b', revoked_at: null },
          ],
        },
      });
    if (path === '/api/organization/round-two/teams')
      return route.fulfill({
        json: {
          teams: [
            { id: 'team-a', name: 'Alpha' },
            { id: 'team-b', name: 'Beta' },
          ],
        },
      });
    if (path === '/api/organization/round-two/teams/team-a')
      return route.fulfill({
        json: {
          team: { id: 'team-a', name: 'Alpha' },
          repositories: [],
          members: [],
          submissions: [],
          documents: [
            {
              id: 'doc-a',
              version: 1,
              filename: 'alpha.pdf',
              status: 'STORED',
            },
          ],
          matrixSubmissions: [],
        },
      });
    if (path === '/api/organization/round-two/teams/team-b')
      return route.fulfill({
        json: {
          team: { id: 'team-b', name: 'Beta' },
          repositories: [],
          members: [],
          submissions: [],
          documents: [
            {
              id: 'doc-b',
              version: 1,
              filename: 'beta.pdf',
              status: 'STORED',
            },
          ],
          matrixSubmissions: [],
        },
      });
    if (
      path === '/api/organization/round-two/reviews' &&
      request.method() === 'POST'
    ) {
      submittedTeams.push(request.postDataJSON().teamId);
      return route.fulfill({
        status: 201,
        json: { status: 'FINAL', revision: 1 },
      });
    }
    if (path === '/api/organization/round-two/reviews') {
      const teamId = url.searchParams.get('teamId');
      if (teamId === 'team-a') {
        signalTeamAStarted();
        await teamARelease;
        return route.fulfill({
          json: {
            currentDocument: {
              id: 'doc-a',
              version: 1,
              filename: 'alpha.pdf',
            },
            draft: {
              score: 11,
              payload: {
                problemUnderstanding: 'A stale understanding',
                remediation: 'A stale remediation',
                innovationImpact: 'A stale impact',
                overall: 'A stale overall marker',
              },
              document_id: 'doc-a',
            },
            drafts: [],
            submissions: [],
            rubric: null,
            rubricError: null,
            documentStale: false,
          },
        });
      }
      return route.fulfill({
        json: {
          currentDocument: {
            id: 'doc-b',
            version: 1,
            filename: 'beta.pdf',
          },
          draft: {
            score: 72,
            payload: {
              problemUnderstanding: 'B current understanding',
              remediation: 'B current remediation',
              innovationImpact: 'B current impact',
              overall: 'B current overall marker',
            },
            document_id: 'doc-b',
          },
          drafts: [],
          submissions: [],
          rubric: null,
          rubricError: null,
          documentStale: false,
        },
      });
    }
    return route.fulfill({ status: 403, json: { error: 'UNEXPECTED_ROUTE' } });
  });

  await page.goto('/review.html?organization=1');
  await page
    .getByRole('button', { name: /Open review workspace/ })
    .nth(0)
    .click();
  await teamAStarted;
  await page.getByRole('button', { name: 'Back to assigned teams' }).click();
  await page
    .getByRole('button', { name: /Open review workspace/ })
    .nth(1)
    .click();
  await expect(
    page.getByRole('heading', { name: 'Beta review workspace' }),
  ).toBeVisible();
  await expect(page.locator('[name="score"]')).toHaveValue('72');
  releaseTeamA();
  await page.waitForResponse(
    (response) =>
      response.url().includes('/round-two/reviews?teamId=team-a') &&
      response.status() === 200,
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  await expect(
    page.getByRole('heading', { name: 'Beta review workspace' }),
  ).toBeVisible();
  await expect(page.locator('[name="score"]')).toHaveValue('72');
  await expect(page.locator('[name="problemUnderstanding"]')).toHaveValue(
    'B current understanding',
  );
  await expect(page.locator('[name="documentId"]')).toHaveValue('doc-b');
  await expect(page.getByText('A stale overall marker')).toHaveCount(0);
  await page.getByRole('button', { name: 'Submit final review' }).click();
  await expect.poll(() => submittedTeams).toEqual(['team-b']);
});
