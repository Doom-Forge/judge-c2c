import { expect, it } from 'vitest';
import { doombotNoticeBody } from '../src/doombot-notice';
it('publishes only the DoomBot notice and avatar without marks or report links', () => {
  expect(doombotNoticeBody('https://judge.test')).toBe(
    '<img src="https://judge.test/doombot-avatar.png" width="80" height="80" alt="DoomBot" />\n\n**DoomBot is evaluating your PR.**\n\n<!-- doombot-evaluating-v1 -->',
  );
});

import { afterAll, beforeAll } from 'vitest';
import { Miniflare } from './miniflare';
import { readFileSync } from 'node:fs';
import { ensureDoomBotNotice } from '../src/doombot-notice';
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
  await db.prepare('CREATE TABLE matrix_runs(publication_status TEXT)').run();
  await db.prepare("INSERT INTO matrix_runs VALUES('PUBLISHED')").run();
  for (const sql of readFileSync('migrations/0029_doombot_notice.sql', 'utf8')
    .split(';')
    .filter((s) => s.trim()))
    await db.prepare(sql).run();
});
afterAll(async () => mf.dispose());
it('deduplicates new heads and retries and ignores a participant marker', async () => {
  let posts = 0;
  const api = async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++;
      return { id: 10 };
    }
    return [
      {
        id: 9,
        body: doombotNoticeBody('https://judge.test'),
        user: { login: 'participant', type: 'User' },
      },
    ];
  };
  const github = { api } as unknown as GitHub;
  await ensureDoomBotNotice(
    db,
    github,
    run,
    'https://judge.test',
    'fixture[bot]',
  );
  await ensureDoomBotNotice(
    db,
    github,
    run,
    'https://judge.test',
    'fixture[bot]',
  );
  expect(posts).toBe(1);
});
it('recovers an ambiguous POST through the authenticated bot marker', async () => {
  const target = { ...run, pr_number: 2 };
  let posted = false,
    posts = 0;
  const api = async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted = true;
      posts++;
      throw new Error('lost response');
    }
    return posted
      ? [
          {
            id: 22,
            body: doombotNoticeBody('https://judge.test'),
            user: { login: 'fixture[bot]', type: 'Bot' },
          },
        ]
      : [];
  };
  const github = { api } as unknown as GitHub;
  await ensureDoomBotNotice(
    db,
    github,
    target,
    'https://judge.test',
    'fixture[bot]',
  );
  expect(
    await db
      .prepare(
        'SELECT last_error FROM matrix_doombot_notices WHERE pr_number=2',
      )
      .first('last_error'),
  ).toBe('NOTICE_UNAVAILABLE');
  await ensureDoomBotNotice(
    db,
    github,
    target,
    'https://judge.test',
    'fixture[bot]',
  );
  expect(posts).toBe(1);
  expect(
    await db
      .prepare(
        'SELECT comment_id FROM matrix_doombot_notices WHERE pr_number=2',
      )
      .first('comment_id'),
  ).toBe(22);
});
it('respects another lease and recovers it only after expiry', async () => {
  await db
    .prepare(
      'INSERT INTO matrix_doombot_notices(repository_id,pr_number,lease_owner,lease_until) VALUES(1,3,?,?)',
    )
    .bind('other', 5000)
    .run();
  let posts = 0;
  const github = {
    api: async (_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts++;
        return { id: 33 };
      }
      return [];
    },
  } as unknown as GitHub;
  await ensureDoomBotNotice(
    db,
    github,
    { ...run, pr_number: 3 },
    'https://judge.test',
    'fixture[bot]',
    4000,
  );
  expect(posts).toBe(0);
  await ensureDoomBotNotice(
    db,
    github,
    { ...run, pr_number: 3 },
    'https://judge.test',
    'fixture[bot]',
    5001,
  );
  expect(posts).toBe(1);
});
it('has no matrix check publication and notifies before baseline execution', () => {
  const source = readFileSync('src/matrix-workflow.ts', 'utf8');
  expect(source).not.toContain('check-runs');
  expect(source).not.toContain('publish-result');
  expect(source.indexOf('await notifyMatrix(this.env, run)')).toBeLessThan(
    source.indexOf("await execute('baseline')"),
  );
});

it('retires legacy publication claims including published history', async () => {
  expect(
    await db
      .prepare('SELECT publication_status FROM matrix_runs')
      .first('publication_status'),
  ).toBe('NOTICE_ONLY');
});
it('bounds hostile comment pagination without creating a duplicate notice', async () => {
  let calls = 0;
  const github = {
    api: async (_path: string, init?: RequestInit) => {
      expect(init?.method).not.toBe('POST');
      calls++;
      return Array.from({ length: 100 }, () => ({
        id: 1,
        body: 'noise',
        user: { login: 'participant', type: 'User' },
      }));
    },
  } as unknown as GitHub;
  await ensureDoomBotNotice(
    db,
    github,
    { ...run, pr_number: 99 },
    'https://judge.test',
    'fixture[bot]',
  );
  expect(calls).toBe(10);
  expect(
    await db
      .prepare(
        'SELECT last_error FROM matrix_doombot_notices WHERE pr_number=99',
      )
      .first('last_error'),
  ).toBe('NOTICE_SCAN_LIMIT');
});
