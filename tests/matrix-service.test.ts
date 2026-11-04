import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { readFileSync } from 'node:fs';
import { acceptMatrixPR, matrixApi } from '../src/matrix-service';
import type { Env } from '../src/env';
import { acquireMatrixSlot, releaseMatrixSlot } from '../src/matrix-capacity';
let mf: Miniflare, env: Env;
const jobs: string[] = [];
const payload = (sha = 'b'.repeat(40), date = '2026-11-04T10:00:00Z') => ({
  action: 'opened',
  installation: { id: 42 },
  repository: {
    id: 1442222461,
    full_name: '180DC-VIT-CHENNAI/noyyal-treasury',
  },
  pull_request: {
    number: 4,
    head: { sha },
    base: { repo: { id: 1442222461 } },
    updated_at: date,
    state: 'open',
  },
});
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default{}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-08-01',
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const file of [
    '0004_organization.sql',
    '0027_matrix_judging.sql',
    '0028_matrix_capacity.sql',
  ])
    for (const sql of readFileSync('migrations/' + file, 'utf8')
      .split(';')
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
  await db
    .prepare("INSERT INTO github_connection VALUES(1,1,'fixture','fixture',42)")
    .run();
  await db
    .prepare(
      "INSERT INTO github_repositories VALUES(1442222461,'180DC-VIT-CHENNAI/noyyal-treasury',0,'main',1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO matrix_repositories VALUES(1442222461,'180DC-VIT-CHENNAI/noyyal-treasury',?,'pilot-v1',?,'registry.cloudflare.com/fixture/image@sha256:1111111111111111111111111111111111111111111111111111111111111111')",
    )
    .bind('a'.repeat(40), 'c'.repeat(64))
    .run();
  env = {
    DB: db,
    ORG_DB: db,
    ADMIN_TOKEN: 'x'.repeat(40),
    MATRIX_EVALUATOR: {
      create: async ({ id }: { id: string }) => {
        jobs.push(id);
        return { id };
      },
    },
  } as unknown as Env;
});
afterAll(async () => mf.dispose());
it('bounds container concurrency and recovers expired leases without releasing another owner', async () => {
  const one = await acquireMatrixSlot(env.DB, 'test-repo', 'one', 1000);
  await acquireMatrixSlot(env.DB, 'test-repo', 'two', 1000);
  await expect(
    acquireMatrixSlot(env.DB, 'test-repo', 'three', 1000),
  ).rejects.toThrow('MATRIX_BUSY');
  await releaseMatrixSlot(env.DB, one, 'wrong-owner');
  await expect(
    acquireMatrixSlot(env.DB, 'test-repo', 'three', 1000),
  ).rejects.toThrow('MATRIX_BUSY');
  expect(await acquireMatrixSlot(env.DB, 'test-repo', 'three', 181001)).toBe(
    one,
  );
  await releaseMatrixSlot(env.DB, one, 'one');
  expect(
    await env.DB.prepare('SELECT owner FROM matrix_capacity WHERE slot=?')
      .bind(one)
      .first('owner'),
  ).toBe('three');
});
it('requires organizer auth for matrix overview', async () => {
  expect(
    (await matrixApi(new Request('https://test/api/matrix/overview'), env))
      .status,
  ).toBe(401);
});
it('queues once, rejects conflicting replay, and supersedes on new head', async () => {
  const first = await acceptMatrixPR(payload(), env, 'delivery-1', 'hash-1');
  expect(first.status).toBe(202);
  const { id } = (await first.json()) as { id: string };
  expect(jobs).toContain(id);
  expect(
    (await acceptMatrixPR(payload(), env, 'delivery-1', 'hash-1')).status,
  ).toBe(200);
  expect(
    (await acceptMatrixPR(payload(), env, 'delivery-1', 'different')).status,
  ).toBe(409);
  await acceptMatrixPR(
    payload('d'.repeat(40), '2026-11-04T11:00:00Z'),
    env,
    'delivery-2',
    'hash-2',
  );
  expect(
    await env.DB.prepare('SELECT state FROM matrix_runs WHERE id=?')
      .bind(id)
      .first('state'),
  ).toBe('SUPERSEDED');
  const before = jobs.length;
  await acceptMatrixPR(
    payload('b'.repeat(40), '2026-11-04T09:00:00Z'),
    env,
    'delivery-3',
    'hash-3',
  );
  expect(jobs).toHaveLength(before);
});
it('rejects unselected repositories or the wrong installation', async () => {
  expect(
    (
      await acceptMatrixPR(
        { ...payload(), installation: { id: 999 } },
        env,
        'delivery-4',
        'hash',
      )
    ).status,
  ).toBe(403);
});
it('advances same-head timestamps to reject delayed different heads', async () => {
  await acceptMatrixPR(
    payload('e'.repeat(40), '2026-11-04T12:00:00Z'),
    env,
    'order-1',
    'o1',
  );
  await acceptMatrixPR(
    payload('e'.repeat(40), '2026-11-04T14:00:00Z'),
    env,
    'order-2',
    'o2',
  );
  await acceptMatrixPR(
    payload('f'.repeat(40), '2026-11-04T13:00:00Z'),
    env,
    'order-3',
    'o3',
  );
  expect(
    await env.DB.prepare(
      'SELECT head_sha FROM matrix_submissions WHERE pr_number=4',
    ).first('head_sha'),
  ).toBe('e'.repeat(40));
});
it('retains a close-first tombstone against delayed opening events', async () => {
  const p = payload();
  p.pull_request.number = 8;
  p.action = 'closed';
  p.pull_request.state = 'closed';
  await acceptMatrixPR(p, env, 'close-first', 'closed');
  p.action = 'opened';
  p.pull_request.state = 'open';
  p.pull_request.updated_at = '2026-11-04T09:00:00Z';
  const before = jobs.length;
  await acceptMatrixPR(p, env, 'open-late', 'opened');
  expect(jobs).toHaveLength(before);
});
it('resolves conflicting timestamp ties against the actual GitHub head', async () => {
  const date = '2026-11-04T16:00:00Z';
  await acceptMatrixPR(payload('1'.repeat(40), date), env, 'tie-first', 't1');
  const live = async () => ({
    head: { sha: '2'.repeat(40) },
    state: 'open' as const,
    updated_at: date,
  });
  await acceptMatrixPR(
    payload('2'.repeat(40), date),
    env,
    'tie-newer',
    't2',
    live,
  );
  await acceptMatrixPR(
    payload('1'.repeat(40), date),
    env,
    'tie-delayed',
    't3',
    live,
  );
  expect(
    await env.DB.prepare(
      'SELECT head_sha FROM matrix_submissions WHERE pr_number=4',
    ).first('head_sha'),
  ).toBe('2'.repeat(40));
});
it('recovers a persisted queued dispatch after workflow creation fails', async () => {
  const previous = env.MATRIX_EVALUATOR;
  env.MATRIX_EVALUATOR = {
    create: async () => {
      throw new Error('temporary outage');
    },
    get: async () => ({
      status: async () => {
        throw new Error('not found');
      },
    }),
  } as unknown as Env['MATRIX_EVALUATOR'];
  const p = payload('3'.repeat(40), '2026-11-04T17:00:00Z');
  p.pull_request.number = 10;
  await expect(
    acceptMatrixPR(p, env, 'recoverable', 'recover'),
  ).rejects.toThrow('temporary outage');
  expect(
    await env.DB.prepare(
      'SELECT state FROM matrix_runs WHERE pr_number=10',
    ).first('state'),
  ).toBe('QUEUED');
  env.MATRIX_EVALUATOR = previous;
  expect((await acceptMatrixPR(p, env, 'recoverable', 'recover')).status).toBe(
    200,
  );
  const id = await env.DB.prepare(
    'SELECT latest_run_id FROM matrix_submissions WHERE pr_number=10',
  ).first<string>('latest_run_id');
  expect(jobs).toContain(id);
});
