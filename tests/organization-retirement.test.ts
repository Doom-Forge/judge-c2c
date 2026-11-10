import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  it,
  expect,
  vi,
} from 'vitest';
import { Miniflare } from './miniflare';
import { generateKeyPairSync } from 'node:crypto';
import { migrate } from './database';
import {
  organization,
  organizationEnv,
  seal,
  maintainOrganization,
} from '../src/organization';
import { GitHub } from '../src/github';
import { demoContract } from '../src/demo';
import { canonical, digest } from '../src/domain';
import { dispatch, getRun, isCurrent } from '../src/store';
import { publish } from '../src/github-checks';
import { EvaluationWorkflow } from '../src/workflow';
import type { WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../src/env';
let mf: Miniflare, env: Env, cookie: string;
const origin = 'https://old.example.org';
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
function req(path: string, method = 'GET', body?: unknown, session = cookie) {
  return new Request(origin + path, {
    method,
    headers: { origin, cookie: session, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
function payload() {
  const now = Date.now();
  return {
    confirmation: 'Old-Org',
    attestation: true,
    replacement: {
      organization: 'New-Org',
      workspace: 'new-event',
      origin: 'https://new.example.org',
      targetHash: 'a'.repeat(64),
      appId: 43,
      installationId: 85,
      verificationReference: 'a'.repeat(32),
      verifiedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 900000).toISOString(),
    },
  };
}
async function retire(body = payload()) {
  return organization(req('/api/organization/retire', 'POST', body), env, ctx);
}
async function state() {
  return (await (
    await organization(req('/api/organization/status'), env, ctx)
  ).json()) as any;
}
function network(mode = 'removed') {
  let deleted = false;
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/app')
        return Response.json({
          id: 42,
          slug: 'old-app',
          owner: { login: 'Old-Org', type: 'Organization' },
        });
      expect(path).toBe('/app/installations/84');
      if (init?.method === 'DELETE') {
        if (mode === 'failure') return new Response('', { status: 503 });
        deleted = true;
        return new Response(null, { status: 202 });
      }
      if (mode === 'absent' || (deleted && mode === 'removed'))
        return new Response('', { status: 404 });
      return Response.json({
        id: 84,
        app_id: mode === 'mismatch' ? 99 : 42,
        account: { login: 'Old-Org', type: 'Organization' },
      });
    });
}
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default{}',
    d1Databases: ['ORG_DB'],
    compatibilityDate: '2026-08-01',
  });
  const db = (await mf.getD1Database('ORG_DB')) as unknown as D1Database;
  await migrate(db);
  env = {
    ORG_DB: db,
    ORG_NAME: 'Old-Org',
    ORG_PUBLIC_ORIGIN: origin,
    ORG_VAULT_KEY: '12'.repeat(32),
    ORG_ADMIN_TOKEN: 'fixture-' + 'a'.repeat(40),
    ORG_JUDGE_TOKEN: 'fixture-' + 'b'.repeat(40),
    ORG_EVALUATOR: { create: vi.fn(async () => ({})) },
  } as unknown as Env;
}, 30000);
beforeEach(async () => {
  await env.ORG_DB!.prepare('DELETE FROM organizer_sessions').run();
  await env.ORG_DB!.prepare('DELETE FROM console_identity_sessions').run();
  // The retirement table does not exist until the implementation is added.
  await env
    .ORG_DB!.prepare('DELETE FROM organization_retirement')
    .run()
    .catch(() => {});
  await env.ORG_DB!.prepare('DELETE FROM github_connection').run();
  await env
    .ORG_DB!.prepare(
      'INSERT INTO github_connection(id,app_id,slug,encrypted,installation_id) VALUES(1,42,?,?,84)',
    )
    .bind(
      'old-app',
      await seal(env, {
        id: 42,
        slug: 'old-app',
        key,
        webhookSecret: 'fixture-webhook-secret',
      }),
    )
    .run();
  cookie = 'judge_organizer=' + 'c'.repeat(64);
  await env
    .ORG_DB!.prepare(
      "INSERT INTO organizer_sessions(hash,expires_at,role) VALUES(?,?,'organizer')",
    )
    .bind(await digest('c'.repeat(64)), Date.now() + 3600000)
    .run();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => mf.dispose());
it('requires organizer role, authentication and same origin', async () => {
  expect(
    (
      await organization(
        req('/api/organization/retire', 'POST', payload(), ''),
        env,
        ctx,
      )
    ).status,
  ).toBe(401);
  await env.ORG_DB!.prepare('DELETE FROM organizer_sessions').run();
  await env
    .ORG_DB!.prepare(
      "INSERT OR IGNORE INTO teams(id,name) VALUES('role-team','Role fixture')",
    )
    .run();
  for (const role of ['judge', 'security', 'participant']) {
    await env
      .ORG_DB!.prepare(
        'INSERT OR IGNORE INTO console_identities(id,name,role,team_id,credential_hash) VALUES(?,?,?,?,?)',
      )
      .bind(
        role,
        role,
        role,
        role === 'participant' ? 'role-team' : null,
        await digest(role),
      )
      .run();
    await env
      .ORG_DB!.prepare(
        'INSERT OR REPLACE INTO console_identity_sessions(hash,identity_id,expires_at) VALUES(?,?,?)',
      )
      .bind(await digest('c'.repeat(64)), role, Date.now() + 3600000)
      .run();
    expect((await retire()).status).toBe(403);
  }
  await env.ORG_DB!.prepare('DELETE FROM console_identity_sessions').run();
  const r = req('/api/organization/retire', 'POST', payload());
  r.headers.set('origin', 'https://hostile.example.org');
  expect((await organization(r, env, ctx)).status).toBe(403);
});
it('refuses wrong exact confirmation and identical replacement before GitHub access', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const wrong = payload();
  wrong.confirmation = 'old-org';
  expect((await retire(wrong)).status).toBe(400);
  const same = payload();
  same.replacement.organization = 'old-org';
  expect((await retire(same)).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it('fences before uninstall failure and safely retries accepted empty 202 until authoritative 404', async () => {
  const failed = network('failure');
  const response = await retire();
  expect(response.status).toBe(202);
  expect((await state()).retirement.state).toBe('RETIRING');
  failed.mockRestore();
  for (const path of [
    '/api/organization/sync',
    '/api/organization/participant/withdraw',
    '/api/organization/manage/settings',
  ])
    expect((await organization(req(path, 'POST', {}), env, ctx)).status).toBe(
      409,
    );
  expect(
    (
      await organization(
        req('/auth/github/installed?installation_id=84'),
        env,
        ctx,
      )
    ).status,
  ).toBe(409);
  const pending = network('pending');
  expect((await retire()).status).toBe(202);
  expect((await state()).retirement.error).toBe('UNINSTALL_PENDING');
  pending.mockRestore();
  const removed = network('removed');
  expect((await retire()).status).toBe(200);
  expect((await state()).retirement.state).toBe('RETIRED');
  removed.mockRestore();
  const noNetwork = vi.spyOn(globalThis, 'fetch');
  expect((await retire()).status).toBe(200);
  await maintainOrganization(env, ctx);
  expect(noNetwork).not.toHaveBeenCalled();
  await expect(
    GitHub.installation(await organizationEnv(env), demoContract),
  ).rejects.toThrow('ORGANIZATION_RETIRED');
});
it('inspects app and installation identity before deletion; already absent is safe', async () => {
  const mismatch = network('mismatch');
  expect((await retire()).status).toBe(202);
  expect((await state()).retirement.error).toBe('INSTALLATION_MISMATCH');
  expect(mismatch.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(
    false,
  );
  mismatch.mockRestore();
  network('absent');
  expect((await retire()).status).toBe(200);
});
it('retains completed, failed and superseded evidence and fences queued work and publication while allowing archive reads', async () => {
  const db = env.ORG_DB!,
    contract = {
      ...demoContract,
      repository: {
        ...demoContract.repository,
        id: 1,
        fullName: 'Old-Org/repo',
        installationId: 84,
      },
    };
  const hash = await digest(canonical(contract));
  await db
    .prepare(
      'INSERT OR IGNORE INTO repositories(id,full_name,installation_id,active_contract_hash) VALUES(1,?,84,?)',
    )
    .bind('Old-Org/repo', hash)
    .run();
  await db
    .prepare(
      'INSERT OR IGNORE INTO contracts(hash,repository_id,document) VALUES(?,1,?)',
    )
    .bind(hash, canonical(contract))
    .run();
  for (const [i, s] of [
    'COMPLETED',
    'FAILED',
    'SUPERSEDED',
    'QUEUED',
    'CHECKING',
  ].entries())
    await db
      .prepare(
        'INSERT INTO evaluations(id,repository_id,pr_number,head_sha,baseline_sha,contract_hash,contract_snapshot,assignment_snapshot,state,evidence,report) VALUES(?,1,1,?,?,?,?,?,?,?,?)',
      )
      .bind(
        String(i + 1).repeat(64),
        contract.baseline,
        contract.baseline,
        hash,
        canonical(contract),
        '{}',
        s,
        '[]',
        '{"summary":"retained"}',
      )
      .run();
  network();
  expect((await retire()).status).toBe(200);
  const rows = (
    await db
      .prepare('SELECT state,evidence,report FROM evaluations ORDER BY id')
      .all()
  ).results;
  expect(rows.map((r) => r.state)).toEqual([
    'COMPLETED',
    'FAILED',
    'SUPERSEDED',
    'SUPERSEDED',
    'SUPERSEDED',
  ]);
  expect(rows.every((r) => r.report === '{"summary":"retained"}')).toBe(true);
  const effective = await organizationEnv(env),
    run = (await getRun(effective, '4'.repeat(64)))!;
  expect(await isCurrent(effective, run)).toBe(false);
  const calls = vi.spyOn(globalThis, 'fetch');
  calls.mockClear();
  await dispatch(effective, run.id);
  await publish(effective, run);
  const step = {
    do: async (_name: string, ...args: any[]) => args.at(-1)(),
  } as unknown as WorkflowStep;
  await new EvaluationWorkflow({} as any, effective).run(
    { payload: { runId: run.id } } as WorkflowEvent<{ runId: string }>,
    step,
  );
  expect(calls).not.toHaveBeenCalled();
  const archive = await organization(
    req('/api/organization/evaluations/' + '1'.repeat(64) + '/bundle'),
    env,
    ctx,
  );
  expect(archive.status).toBe(200);
  expect(await archive.text()).toContain('retained');
  expect(calls).not.toHaveBeenCalled();
  expect(
    (
      await organization(
        req(
          '/api/organization/evaluations/' + '2'.repeat(64) + '/retry',
          'POST',
          {},
        ),
        env,
        ctx,
      )
    ).status,
  ).toBe(409);
});

it('serializes uninstall attempts while rejecting a concurrent replacement target change', async () => {
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let deletes = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/app')
      return Response.json({
        id: 42,
        owner: { login: 'Old-Org', type: 'Organization' },
      });
    if (init?.method === 'DELETE') {
      deletes++;
      reached();
      await blocker;
      return new Response(null, { status: 202 });
    }
    return Response.json({
      id: 84,
      app_id: 42,
      account: { login: 'Old-Org', type: 'Organization' },
    });
  });
  const first = retire();
  await entered;
  expect((await retire()).status).toBe(202);
  const changed = payload();
  changed.replacement.organization = 'Third-Org';
  expect((await retire(changed)).status).toBe(409);
  release();
  expect((await first).status).toBe(202);
  expect(deletes).toBe(1);
  expect(
    (await organization(req('/webhooks/organization', 'POST', {}), env, ctx))
      .status,
  ).toBe(409);
});
it('fences the intake check/write race and preserves native evaluation scope and restricted role status', async () => {
  network();
  expect((await retire()).status).toBe(200);
  const { organizationActive } = await import('../src/organization-retirement');
  expect(await organizationActive({ ...env, DB: env.ORG_DB! })).toBe(true);
  const effective = await organizationEnv(env);
  expect(await organizationActive(effective)).toBe(false);
  await expect(
    env
      .ORG_DB!.prepare(
        "INSERT INTO evaluations(id,repository_id,pr_number,head_sha,baseline_sha,contract_hash,contract_snapshot,assignment_snapshot,state) VALUES('race',1,1,'head','base','hash','{}','{}','QUEUED')",
      )
      .run(),
  ).rejects.toThrow('ORGANIZATION_RETIRED');
  await env.ORG_DB!.prepare("UPDATE organizer_sessions SET role='judge'").run();
  const status = await state();
  expect(status.retirement).toEqual({
    state: 'RETIRED',
    archiveReadOnly: true,
  });
});
it('does not audit a retired transition or claim completion after losing its retry lease', async () => {
  const db = env.ORG_DB!;
  const before = await db
    .prepare(
      "SELECT count(*) AS count FROM audit WHERE action='organization.retired'",
    )
    .first<{ count: number }>();
  let deleted = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname === '/app')
      return Response.json({
        id: 42,
        owner: { login: 'Old-Org', type: 'Organization' },
      });
    if (init?.method === 'DELETE') {
      deleted = true;
      await db
        .prepare(
          "UPDATE organization_retirement SET lease='other-attempt',lease_until=? WHERE id=1",
        )
        .bind(Date.now() + 120000)
        .run();
      return new Response(null, { status: 202 });
    }
    if (deleted) return new Response(null, { status: 404 });
    return Response.json({
      id: 84,
      app_id: 42,
      account: { login: 'Old-Org', type: 'Organization' },
    });
  });
  expect((await retire()).status).toBe(202);
  expect((await state()).retirement.state).toBe('RETIRING');
  expect(
    await db
      .prepare(
        "SELECT count(*) AS count FROM audit WHERE action='organization.retired'",
      )
      .first(),
  ).toEqual(before);
});
