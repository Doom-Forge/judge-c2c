import { expect, test } from '@playwright/test';

test('judge saves, submits, locks, and revises each stage with private draft history', async ({
  page,
}) => {
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const stageState: Record<string, { draft: any; submissions: any[] }> = {
    ANALYSIS: { draft: null, submissions: [] },
    ENGINEERING: { draft: null, submissions: [] },
  };
  await page.route('**/api/organization/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/organization/status') {
      return route.fulfill({
        json: {
          organization: 'Fixture',
          authenticated: true,
          role: 'judge',
          identity: { id: 'judge-a', name: 'Judge A', role: 'judge' },
        },
      });
    }
    if (path === '/api/organization/round-two/assignments') {
      return route.fulfill({
        json: {
          assignments: [{ team_id: 'team-a', revoked_at: null }],
        },
      });
    }
    if (path === '/api/organization/round-two/teams') {
      return route.fulfill({
        json: { teams: [{ id: 'team-a', name: 'Alpha' }] },
      });
    }
    if (path === '/api/organization/round-two/teams/team-a') {
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
              filename: 'analysis.pdf',
              status: 'STORED',
            },
          ],
          matrixSubmissions: [],
        },
      });
    }
    if (
      path === '/api/organization/round-two/reviews' &&
      request.method() === 'POST'
    ) {
      const body = request.postDataJSON();
      calls.push({ action: body.action, body });
      const state = stageState[body.stage];
      if (body.action === 'SAVE_DRAFT') {
        state.draft = {
          score: body.score ?? 84,
          payload:
            body.stage === 'ANALYSIS'
              ? body.feedback
              : {
                  criteriaScores: body.criteriaScores,
                  overall: body.overall,
                },
          document_id: body.documentId ?? null,
          updated_at: 'now',
        };
        return route.fulfill({
          json: { status: 'DRAFT_SAVED', score: state.draft.score },
        });
      }
      if (body.action === 'SUBMIT') {
        const draft = state.draft;
        expect(draft).not.toBeNull();
        state.submissions.unshift({
          id: 'review-' + body.stage,
          stage: body.stage,
          revision: 1,
          score: draft.score,
          payload: draft.payload,
          document_id: draft.document_id,
          submitted_at: 'now',
          reason: 'Initial submission',
        });
        state.draft = null;
        return route.fulfill({
          json: { status: 'FINAL', revision: 1 },
          status: 201,
        });
      }
      if (body.action === 'REVISE') {
        if (!body.reason || body.reason.length < 10) {
          return route.fulfill({
            status: 400,
            json: { error: 'REVISION_REASON_REQUIRED' },
          });
        }
        state.submissions.unshift({
          id: 'review-' + body.stage + '-2',
          stage: body.stage,
          revision: 2,
          score: body.score ?? 84,
          payload:
            body.stage === 'ANALYSIS'
              ? body.feedback
              : {
                  criteriaScores: body.criteriaScores,
                  overall: body.overall,
                },
          document_id: body.documentId ?? null,
          submitted_at: 'later',
          reason: body.reason,
        });
        return route.fulfill({
          json: { status: 'FINAL', revision: 2 },
          status: 201,
        });
      }
    }
    if (path === '/api/organization/round-two/reviews') {
      const stage = url.searchParams.get('stage')!;
      const state = stageState[stage];
      return route.fulfill({
        json: {
          currentDocument:
            stage === 'ANALYSIS'
              ? { id: 'doc-a', version: 1, filename: 'analysis.pdf' }
              : null,
          rubric:
            stage === 'ENGINEERING'
              ? {
                  id: 'rubric-1',
                  version: 1,
                  criteria: [
                    {
                      id: 'tests',
                      label: 'Tests',
                      weight: 100,
                    },
                  ],
                }
              : null,
          rubricError: null,
          documentStale: false,
          draft: state.draft,
          drafts: state.draft ? [state.draft] : [],
          submissions: state.submissions,
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
  for (const stage of ['ANALYSIS', 'ENGINEERING']) {
    if (stage === 'ENGINEERING') {
      await page.getByRole('button', { name: 'Pull Request (90%)' }).click();
    }
    const score = page.locator(
      stage === 'ANALYSIS'
        ? '[name="score"]'
        : '[name="criterion-tests-score"]',
    );
    await expect(score).toBeVisible();
    if (stage === 'ANALYSIS') {
      await page
        .locator('[name="problemUnderstanding"]')
        .fill('Problem understood');
      await page.locator('[name="remediation"]').fill('Remediation recorded');
      await page.locator('[name="innovationImpact"]').fill('Impact recorded');
      await page.locator('[name="overall"]').fill('Analysis overall');
      await page.locator('[name="documentId"]').selectOption('doc-a');
    } else {
      await page
        .locator('[name="criterion-tests-comment"]')
        .fill('Tests are covered');
      await page.locator('[name="overall"]').fill('Engineering overall');
    }
    await score.fill('');
    const callsBeforeInvalidScore = calls.length;
    const draftRequest = page
      .waitForRequest('**/api/organization/round-two/reviews', {
        timeout: 500,
      })
      .then(
        () => true,
        () => false,
      );
    await page.getByRole('button', { name: 'Save draft' }).click();
    expect(await draftRequest).toBe(false);
    const submitRequest = page
      .waitForRequest('**/api/organization/round-two/reviews', {
        timeout: 500,
      })
      .then(
        () => true,
        () => false,
      );
    await page.getByRole('button', { name: 'Submit final review' }).click();
    expect(await submitRequest).toBe(false);
    expect(calls).toHaveLength(callsBeforeInvalidScore);
    await score.fill('84');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
    const editedOverall = `${stage} edited after draft save`;
    await page.locator('[name="overall"]').fill(editedOverall);
    await page.getByRole('button', { name: 'Submit final review' }).click();
    await expect(page.getByText(/submitted revision 1/i)).toBeVisible();
    expect(stageState[stage].submissions[0].payload).toMatchObject({
      overall: editedOverall,
    });
    await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(
      0,
    );
    if (stage === 'ANALYSIS') {
      await expect(page.locator('[name="score"]')).toHaveValue('84');
      await expect(page.locator('[name="problemUnderstanding"]')).toHaveValue(
        'Problem understood',
      );
      await expect(page.locator('[name="documentId"]')).toHaveValue('doc-a');
    } else {
      await expect(page.locator('[name="criterion-tests-score"]')).toHaveValue(
        '84',
      );
      await expect(
        page.locator('[name="criterion-tests-comment"]'),
      ).toHaveValue('Tests are covered');
    }
    await expect(page.locator('[name="overall"]')).toHaveValue(
      `${stage} edited after draft save`,
    );
    await page
      .getByLabel('Revision reason')
      .fill('Corrected evidence after review');
    await page.getByRole('button', { name: 'Revise final review' }).click();
    await expect(page.getByText(/submitted revision 2/i)).toBeVisible();
    await expect(
      page.getByText('Corrected evidence after review'),
    ).toBeVisible();
  }
  expect(calls.map(({ action }) => action)).toEqual([
    'SAVE_DRAFT',
    'SAVE_DRAFT',
    'SUBMIT',
    'REVISE',
    'SAVE_DRAFT',
    'SAVE_DRAFT',
    'SUBMIT',
    'REVISE',
  ]);
  expect(calls.every(({ body }) => body.teamId === 'team-a')).toBe(true);
});
