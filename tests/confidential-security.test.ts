import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import { organization } from '../src/organization';
import { digest } from '../src/domain';
import type { Env } from '../src/env';
let mf: Miniflare, env: Env;
const origin = 'https://security.test';
const tokens = {
  organizer: 'a'.repeat(64),
  judge: 'b'.repeat(64),
  security: 'c'.repeat(64),
};
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
async function call(
  path: string,
  role: keyof typeof tokens | null,
  body?: unknown,
  source = origin,
) {
  return organization(
    new Request(origin + '/api/organization/' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin: source,
        'content-type': 'application/json',
        ...(role ? { cookie: 'judge_organizer=' + tokens[role] } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    ctx,
  );
}
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default{fetch(){return new Response("ok")}}',
    d1Databases: ['ORG_DB'],
    compatibilityDate: '2026-08-01',
  });
  const db = (await mf.getD1Database('ORG_DB')) as unknown as D1Database;
  await migrate(db);
  env = {
    ORG_DB: db,
    ORG_ADMIN_TOKEN: 'admin-' + 'x'.repeat(40),
    ORG_SECURITY_TOKEN: 'security-' + 'x'.repeat(40),
    ORG_VAULT_KEY: '12'.repeat(32),
    ORG_NAME: 'test',
    ORG_PUBLIC_ORIGIN: origin,
  } as Env;
  for (const role of ['organizer', 'judge'] as const)
    await db
      .prepare(
        'INSERT INTO organizer_sessions(hash,expires_at,role) VALUES(?,?,?)',
      )
      .bind(await digest(tokens[role]), Date.now() + 100000, role)
      .run();
  await db
    .prepare('INSERT INTO security_sessions(hash,expires_at) VALUES(?,?)')
    .bind(await digest(tokens.security), Date.now() + 100000)
    .run();
  await db
    .prepare(
      "INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(1,'test/repo',1,'main',1)",
    )
    .run();
}, 30000);
afterAll(async () => mf.dispose());
it('restricts private intake, text artifacts and append-only reviews without exposing them to ordinary APIs', async () => {
  const intake = {
    repositoryId: 1,
    title: 'Private vulnerability',
    details: 'CONFIDENTIAL exploit reproduction fixture only',
    artifacts: [
      { name: 'repro.txt', content: 'CONFIDENTIAL attachment payload' },
    ],
  };
  expect((await call('security-reports', null, intake)).status).toBe(401);
  expect((await call('security-reports', 'judge', intake)).status).toBe(403);
  expect(
    (await call('security-reports', 'organizer', intake, 'https://evil.test'))
      .status,
  ).toBe(403);
  expect(
    (
      await call('security-reports', 'security', {
        ...intake,
        repositoryId: 999,
      })
    ).status,
  ).toBe(403);
  const response = await call('security-reports', 'security', intake);
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  for (const path of [
    'security-reports',
    'security-reports/' + id,
    'security-reports/' + id + '/reviews',
  ])
    expect(
      (
        await call(
          path,
          'judge',
          path.endsWith('/reviews')
            ? {
                status: 'RESOLVED',
                reason: 'This must remain inaccessible to judges',
              }
            : undefined,
        )
      ).status,
    ).toBe(403);
  expect((await call('manage/issues', 'security')).status).toBe(403);
  for (const status of ['TRIAGED', 'CONFIRMED'])
    expect(
      (
        await call('security-reports/' + id + '/reviews', 'organizer', {
          status,
          reason: 'Private review rationale preserved in history',
        })
      ).status,
    ).toBe(201);
  const detail = (await (
    await call('security-reports/' + id, 'security')
  ).json()) as { report: typeof intake; reviews: { status: string }[] };
  expect(detail.report.artifacts).toEqual(intake.artifacts);
  await expect(
    env
      .ORG_DB!.prepare(
        'UPDATE confidential_security_reports SET details=? WHERE id=?',
      )
      .bind('replacement', id)
      .run(),
  ).rejects.toThrow('CONFIDENTIAL_REPORT_IMMUTABLE');
  await expect(
    env
      .ORG_DB!.prepare(
        'DELETE FROM confidential_security_reviews WHERE report_id=?',
      )
      .bind(id)
      .run(),
  ).rejects.toThrow('CONFIDENTIAL_REVIEW_IMMUTABLE');
  expect(detail.reviews.map((r) => r.status)).toEqual(['TRIAGED', 'CONFIRMED']);
  for (const path of ['manage/issues', 'manage/audit', 'evaluations'])
    expect(await (await call(path, 'judge')).text()).not.toContain(
      'CONFIDENTIAL',
    );
  expect(
    (await env
      .ORG_DB!.prepare('SELECT count(*) AS n FROM github_issues')
      .first<{ n: number }>())!.n,
  ).toBe(0);
});
it('authenticates a separate security role and revokes its session on logout', async () => {
  const response = await call('login', null, { token: env.ORG_SECURITY_TOKEN });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const req = (path: string, method = 'GET') =>
    new Request(origin + '/api/organization/' + path, {
      method,
      headers: { origin, cookie },
    });
  const status = (await (
    await organization(req('status'), env, ctx)
  ).json()) as { role: string };
  expect(status.role).toBe('security');
  expect((await organization(req('repositories'), env, ctx)).status).toBe(403);
  expect((await organization(req('logout', 'POST'), env, ctx)).status).toBe(
    200,
  );
  expect((await organization(req('security-reports'), env, ctx)).status).toBe(
    401,
  );
});
