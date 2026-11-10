import { expect, it } from 'vitest';
import { copilotReviewers } from '../src/default-reviewer';
it('removes only Copilot bot reviewers', () =>
  expect(
    copilotReviewers([
      { login: 'Copilot', type: 'Bot' },
      { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
      { login: 'Kevin272-dot', type: 'User' },
      { login: 'copilot-fan', type: 'User' },
    ]),
  ).toEqual(['Copilot', 'copilot-pull-request-reviewer[bot]']));
import { beforeAll, afterAll } from 'vitest';
import { Miniflare } from './miniflare';
import { readFileSync } from 'node:fs';
import { ensureDefaultReviewer } from '../src/default-reviewer';
import type { GitHub } from '../src/github';
let mf: Miniflare, db: D1Database;
const run = { repository_id: 1, full_name: 'owner/repo', pr_number: 1 };
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default{}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-08-01',
  });
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  await db
    .prepare(readFileSync('migrations/0030_default_reviewer.sql', 'utf8'))
    .run();
});
afterAll(async () => mf.dispose());
it('removes Copilot, requests Kevin once, and reconciles lost response', async () => {
  let requested = false,
    posts = 0,
    deletes = 0;
  const api = async (path: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      deletes++;
      expect(JSON.parse(String(init.body))).toEqual({ reviewers: ['Copilot'] });
      return {};
    }
    if (init?.method === 'POST') {
      posts++;
      requested = true;
      expect(JSON.parse(String(init.body))).toEqual({
        reviewers: ['Kevin272-dot'],
      });
      throw new Error('lost response');
    }
    if (path.includes('requested_reviewers'))
      return {
        users: requested
          ? [{ login: 'Kevin272-dot', type: 'User' }]
          : [{ login: 'Copilot', type: 'Bot' }],
      };
    if (path.includes('/reviews?')) return [];
    return { state: 'open', draft: false, user: { login: 'author' } };
  };
  const github = { api } as unknown as GitHub;
  await ensureDefaultReviewer(db, github, run, 'Kevin272-dot');
  expect(
    await db
      .prepare('SELECT last_error FROM matrix_default_reviewers')
      .first('last_error'),
  ).toBe('REVIEWER_UNAVAILABLE');
  await ensureDefaultReviewer(db, github, run, 'Kevin272-dot');
  await ensureDefaultReviewer(db, github, run, 'Kevin272-dot');
  expect(posts).toBe(1);
  expect(deletes).toBe(1);
  expect(
    await db
      .prepare('SELECT status FROM matrix_default_reviewers')
      .first('status'),
  ).toBe('DONE');
});
it('skips authors and completed reviews without requesting again', async () => {
  for (const [number, author] of [
    [2, 'Kevin272-dot'],
    [3, 'someone'],
  ] as const) {
    const github = {
      api: async (path: string, init?: RequestInit) => {
        expect(init?.method).not.toBe('POST');
        if (path.includes('requested_reviewers')) return { users: [] };
        if (path.includes('/reviews?'))
          return [{ user: { login: 'Kevin272-dot' } }];
        return { state: 'open', user: { login: author } };
      },
    } as unknown as GitHub;
    await ensureDefaultReviewer(
      db,
      github,
      { ...run, pr_number: number },
      'Kevin272-dot',
    );
    expect(
      await db
        .prepare(
          'SELECT status FROM matrix_default_reviewers WHERE pr_number=?',
        )
        .bind(number)
        .first('status'),
    ).toBe(number === 2 ? 'SELF' : 'DONE');
  }
});
it('keeps drafts pending and retries when ready', async () => {
  let draft = true,
    posts = 0;
  const github = {
    api: async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        return {};
      }
      if (path.includes('requested_reviewers')) return { users: [] };
      if (path.includes('/reviews?')) return [];
      return { state: 'open', draft, user: { login: 'author' } };
    },
  } as unknown as GitHub;
  await ensureDefaultReviewer(
    db,
    github,
    { ...run, pr_number: 4 },
    'Kevin272-dot',
  );
  expect(posts).toBe(0);
  expect(
    await db
      .prepare(
        'SELECT last_error FROM matrix_default_reviewers WHERE pr_number=4',
      )
      .first('last_error'),
  ).toBe('REVIEWER_DRAFT');
  draft = false;
  await ensureDefaultReviewer(
    db,
    github,
    { ...run, pr_number: 4 },
    'Kevin272-dot',
  );
  expect(posts).toBe(1);
});
it('bounds review pagination without risking a duplicate request', async () => {
  let pages = 0;
  const github = {
    api: async (path: string, init?: RequestInit) => {
      expect(init?.method).not.toBe('POST');
      if (path.includes('requested_reviewers')) return { users: [] };
      if (path.includes('/reviews?')) {
        pages++;
        return Array.from({ length: 100 }, () => ({
          user: { login: 'another' },
        }));
      }
      return { state: 'open', user: { login: 'author' } };
    },
  } as unknown as GitHub;
  await ensureDefaultReviewer(
    db,
    github,
    { ...run, pr_number: 5 },
    'Kevin272-dot',
  );
  expect(pages).toBe(10);
  expect(
    await db
      .prepare(
        'SELECT last_error FROM matrix_default_reviewers WHERE pr_number=5',
      )
      .first('last_error'),
  ).toBe('REVIEWER_SCAN_LIMIT');
});
it('honors a live lease and recovers an expired one', async () => {
  await db
    .prepare(
      'INSERT INTO matrix_default_reviewers(repository_id,pr_number,reviewer,lease_owner,lease_until) VALUES(1,6,?,?,?)',
    )
    .bind('Kevin272-dot', 'other', 5000)
    .run();
  let calls = 0;
  const github = {
    api: async () => {
      calls++;
      return { state: 'closed' };
    },
  } as unknown as GitHub;
  await ensureDefaultReviewer(
    db,
    github,
    { ...run, pr_number: 6 },
    'Kevin272-dot',
    4000,
  );
  expect(calls).toBe(0);
  await ensureDefaultReviewer(
    db,
    github,
    { ...run, pr_number: 6 },
    'Kevin272-dot',
    5001,
  );
  expect(calls).toBe(1);
});
it('scopes notification and review tokens to PR write without checks permission', () => {
  const workflow = readFileSync('src/matrix-workflow.ts', 'utf8');
  expect(workflow).toContain(
    '{ issuesWrite: false, pullRequestsWrite, checksWrite: false }',
  );
  const github = readFileSync('src/github.ts', 'utf8');
  expect(github).toContain(
    "pull_requests: options.pullRequestsWrite ? 'write' : 'read'",
  );
  expect(github).toContain("issues: options.issuesWrite ? 'write' : 'read'");
});
