import { migrate } from './database';
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { Miniflare } from './miniflare';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import {
  organization,
  seal,
  unseal,
  organizationEnv,
} from '../src/organization';
import { GitHub } from '../src/github';
import { EvaluationWorkflow } from '../src/workflow';
import type { WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../src/env';
let mf: Miniflare, env: Env, cookie: string;
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil(p: Promise<unknown>) {
    pending.push(p);
  },
  passThroughOnException() {},
} as ExecutionContext;
const origin = 'https://organization.test',
  token = 'organizer-test-token-' + 'a'.repeat(40);
function request(
  path: string,
  method = 'GET',
  data?: unknown,
  session = cookie,
  source = origin,
) {
  return new Request(origin + path, {
    method,
    headers: {
      origin: source,
      ...(session ? { cookie: session } : {}),
      'content-type': 'application/json',
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}
async function body(response: Response) {
  return (await response.json()) as {
    action: string;
    manifest: Record<string, unknown>;
    repositories: { full_name: string; accessible: number }[];
    authenticated: boolean;
    app?: unknown;
    error?: string;
    status?: string;
  };
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default{fetch(){return new Response("ok")}}',
    d1Databases: ['ORG_DB'],
    compatibilityDate: '2026-08-01',
  });
  const db = await mf.getD1Database('ORG_DB');
  await migrate(db as unknown as D1Database);
  env = {
    ORG_DB: db,
    ORG_ADMIN_TOKEN: token,
    ORG_VAULT_KEY: '12'.repeat(32),
    ORG_NAME: 'Daksh-Codebase',
    ORG_PUBLIC_ORIGIN: origin,
    ORG_EVALUATOR: {
      async create() {
        return {};
      },
    },
  } as unknown as Env;
}, 30000);
afterAll(async () => {
  await Promise.all(pending);
  await mf.dispose();
});
afterEach(() => vi.restoreAllMocks());
describe('protected organization setup', () => {
  it('protects private organization state and restricts origins and login attempts', async () => {
    const status = await body(
      await organization(
        request('/api/organization/status', 'GET', undefined, ''),
        env,
        ctx,
      ),
    );
    expect(status.authenticated).toBe(false);
    expect(status.app).toBeUndefined();
    expect(
      (
        await organization(
          request('/api/organization/repositories', 'GET', undefined, ''),
          env,
          ctx,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await organization(
          request(
            '/api/organization/login',
            'POST',
            { token },
            '',
            'https://attacker.test',
          ),
          env,
          ctx,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await organization(
          request('/api/organization/login', 'POST', { token: 'invalid' }, ''),
          env,
          ctx,
        )
      ).status,
    ).toBe(401);
    const login = await organization(
      request('/api/organization/login', 'POST', { token }, ''),
      env,
      ctx,
    );
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax');
    expect(login.headers.get('set-cookie')).toContain('Secure');
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const alternate = new Request(
      'https://other-preview.test/api/organization/status',
      { headers: { cookie } },
    );
    expect((await organization(alternate, env, ctx)).status).toBe(403);
  });
  it('allows the explicitly approved PR7 origin and rejects other preview origins', async () => {
    const approved =
      'https://feat-frontend-polish-judge-c2c.dakshx.workers.dev';
    const reviewEnv = { ...env, ORG_REVIEW_ORIGINS: approved };
    const status = await organization(
      new Request(approved + '/api/organization/status'),
      reviewEnv,
      ctx,
    );
    expect(status.status).toBe(200);
    expect((await body(status)).authenticated).toBe(false);
    // A trusted deployment origin does not authorize cross-origin mutations.
    for (const source of [
      undefined,
      'null',
      origin,
      approved + '.attacker.test',
    ]) {
      const response = await organization(
        new Request(approved + '/api/organization/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(source ? { origin: source } : {}),
          },
          body: JSON.stringify({ token }),
        }),
        reviewEnv,
        ctx,
      );
      expect(response.status).toBe(403);
      expect((await body(response)).error).toBe('SAME_ORIGIN_REQUIRED');
    }
    for (const rejected of [
      'https://unapproved-judge-c2c.dakshx.workers.dev',
      approved + '.attacker.test',
      approved.replace('https:', 'http:'),
      approved + ':8443',
    ]) {
      const response = await organization(
        new Request(rejected + '/api/organization/status'),
        reviewEnv,
        ctx,
      );
      expect(response.status).toBe(403);
      expect((await body(response)).error).toBe('ORIGIN_NOT_ALLOWED');
    }
    expect(
      (
        await organization(
          new Request(approved + '/api/organization/status'),
          env,
          ctx,
        )
      ).status,
    ).toBe(403);
  });
  it('encrypts credentials and binds decryption to the organization and vault key', async () => {
    const encrypted = await seal(env, { privateKey: 'must-not-be-visible' });
    expect(encrypted).not.toContain('must-not-be-visible');
    expect(await unseal(env, encrypted)).toEqual({
      privateKey: 'must-not-be-visible',
    });
    await expect(
      unseal({ ...env, ORG_NAME: 'Other' }, encrypted),
    ).rejects.toThrow();
    await expect(
      unseal({ ...env, ORG_VAULT_KEY: '34'.repeat(32) }, encrypted),
    ).rejects.toThrow();
  });
  it('creates least-privilege organization manifests and rejects state replay or another browser', async () => {
    const start = await body(
      await organization(
        request('/api/organization/start', 'POST', {}),
        env,
        ctx,
      ),
    );
    const manifest = start.manifest;
    expect(new URL(start.action).pathname).toBe(
      '/organizations/Daksh-Codebase/settings/apps/new',
    );
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toEqual({
      contents: 'read',
      pull_requests: 'read',
      issues: 'write',
      checks: 'write',
    });
    expect(manifest.redirect_url).toBe(origin + '/auth/github/manifest');
    const state = new URL(start.action).searchParams.get('state');
    const callback =
      '/auth/github/manifest?state=' + state + '&code=' + 'a'.repeat(40);
    const other = await organization(
      request('/api/organization/login', 'POST', { token }, ''),
      env,
      ctx,
    );
    const otherCookie = other.headers.get('set-cookie')!.split(';')[0]!;
    expect(
      (
        await organization(
          request(callback, 'GET', undefined, otherCookie),
          env,
          ctx,
        )
      ).status,
    ).toBe(403);
    const api = vi.spyOn(GitHub.prototype, 'api').mockResolvedValue({
      id: 101,
      slug: 'judge-c2c-test',
      pem,
      webhook_secret: 'webhook-secret-' + 'w'.repeat(40),
      owner: { type: 'Organization', login: 'Daksh-Codebase' },
      permissions: {
        contents: 'read',
        pull_requests: 'read',
        issues: 'write',
        checks: 'write',
        metadata: 'read',
      },
    });
    const converted = await organization(request(callback), env, ctx);
    expect(converted.status).toBe(303);
    expect(converted.headers.get('location')).toBe(origin + '/?organization=1');
    const row = await env
      .ORG_DB!.prepare('SELECT encrypted FROM github_connection WHERE id=1')
      .first<{ encrypted: string }>();
    expect(row!.encrypted).not.toContain('PRIVATE KEY');
    expect(row!.encrypted).not.toContain('webhook-secret');
    const stored = await organizationEnv(env);
    expect(stored.GITHUB_APP_PRIVATE_KEY).toContain('BEGIN PRIVATE KEY');
    expect(stored.GITHUB_APP_ID).toBe('101');
    expect(stored.DB).toBe(env.ORG_DB);
    expect(stored.ENVIRONMENT).toBe(env.ENVIRONMENT);
    const production = await organizationEnv({
      ...env,
      ENVIRONMENT: 'production',
    });
    expect(production.ENVIRONMENT).toBe('production');
    expect(production.DB).toBe(env.ORG_DB);
    expect(production.PREVIEW_TESTING).toBe('false');
    expect((await organization(request(callback), env, ctx)).status).toBe(403);
    expect(api).toHaveBeenCalledTimes(1);
    const status = await body(
      await organization(request('/api/organization/status'), env, ctx),
    );
    expect(JSON.stringify(status)).not.toContain('private');
    expect(JSON.stringify(status)).not.toContain('webhook');
  });
  it('rejects forged installation IDs and synchronizes only accessible organization repositories', async () => {
    const api = vi
      .spyOn(GitHub.prototype, 'api')
      .mockImplementation(async (path) => {
        if (path === '/app/installations/999')
          return {
            app_id: 999,
            account: { login: 'Other', type: 'Organization' },
            suspended_at: null,
          } as never;
        if (path === '/app/installations/202')
          return {
            app_id: 101,
            account: { login: 'Daksh-Codebase', type: 'Organization' },
            suspended_at: null,
          } as never;
        if (path.endsWith('/access_tokens'))
          return { token: 'short-lived-test-token' } as never;
        if (path.startsWith('/installation/repositories'))
          return {
            repositories: [
              {
                id: 301,
                full_name: 'Daksh-Codebase/payment-engine',
                private: true,
                default_branch: 'main',
              },
            ],
          } as never;
        throw new Error('UNEXPECTED_TEST_PATH');
      });
    expect(
      (
        await organization(
          request('/auth/github/installed?installation_id=999'),
          env,
          ctx,
        )
      ).status,
    ).toBe(403);
    expect(
      (await env
        .ORG_DB!.prepare('SELECT installation_id FROM github_connection')
        .first<{ installation_id: number | null }>())!.installation_id,
    ).toBeNull();
    expect(
      (
        await organization(
          request('/auth/github/installed?installation_id=202'),
          env,
          ctx,
        )
      ).status,
    ).toBe(303);
    const repositories = await body(
      await organization(request('/api/organization/repositories'), env, ctx),
    );
    expect(repositories.repositories).toEqual([
      {
        id: 301,
        full_name: 'Daksh-Codebase/payment-engine',
        private: 1,
        default_branch: 'main',
        accessible: 1,
      },
    ]);
    const mint = api.mock.calls.find(([path]) =>
      path.endsWith('/access_tokens'),
    )!;
    expect(JSON.parse(mint[1]!.body as string).permissions).not.toHaveProperty(
      'checks',
    );
    api.mockImplementation(async (path) => {
      if (path === '/app/installations/202')
        return {
          app_id: 101,
          account: { login: 'Daksh-Codebase', type: 'Organization' },
          suspended_at: null,
        } as never;
      if (path.endsWith('/access_tokens')) return { token: 'test' } as never;
      return { repositories: [] } as never;
    });
    await organization(request('/api/organization/sync', 'POST', {}), env, ctx);
    expect(
      (
        await body(
          await organization(
            request('/api/organization/repositories'),
            env,
            ctx,
          ),
        )
      ).repositories[0]!.accessible,
    ).toBe(0);
  });
  it('activates an actual assigned PR into an immutable organization evaluation and outbox', async () => {
    await env
      .ORG_DB!.prepare(
        'UPDATE github_repositories SET accessible=1 WHERE id=301',
      )
      .run();
    const base = 'a'.repeat(40),
      head = 'b'.repeat(40);
    vi.spyOn(GitHub.prototype, 'api').mockImplementation(async (path) => {
      if (path.endsWith('/access_tokens')) return { token: 'test' } as never;
      if (path.includes('/pulls/') && path.includes('/commits?'))
        return [
          { sha: head, commit: { message: 'Add implementation' } },
        ] as never;
      if (path.includes('/pulls/'))
        return {
          number: 11,
          state: 'open',
          head: { sha: head },
          base: { sha: base, repo: { id: 301 } },
          updated_at: '2026-10-02T00:00:00Z',
        } as never;
      if (path.includes('/issues/')) return { number: 3 } as never;
      if (path.includes('/check-runs?')) return { check_runs: [] } as never;
      if (path.endsWith('/check-runs') || path.endsWith('/check-runs/9001'))
        return { id: 9001 } as never;
      if (path.includes('/commits/')) return { sha: base } as never;
      if (path.includes('/compare/'))
        return { merge_base_commit: { sha: base }, files: [] } as never;
      if (path.includes('/check-runs?')) return { check_runs: [] } as never;
      if (path.endsWith('/check-runs') || path.endsWith('/check-runs/9001'))
        return { id: 9001 } as never;
      throw new Error('UNEXPECTED_TEST_PATH');
    });
    const response = await organization(
      request('/api/organization/challenges', 'POST', {
        repositoryId: 301,
        prNumber: 11,
        issueNumber: 3,
        teamName: 'Team Mercury',
        expectedBehavior:
          'Verify receipts against the assigned acceptance criteria.',
        baseline: base,
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(202);
    await Promise.all(pending);
    const run = await env
      .ORG_DB!.prepare('SELECT * FROM evaluations WHERE repository_id=301')
      .first<{
        id: string;
        state: string;
        baseline_sha: string;
        head_sha: string;
        contract_snapshot: string;
        assignment_snapshot: string;
      }>();
    expect(run!.state).toBe('QUEUED');
    expect(run!.baseline_sha).toBe(base);
    expect(run!.head_sha).toBe(head);
    expect(
      JSON.parse(run!.contract_snapshot).requirements[0].criteria[0]
        .description,
    ).toBe('Verify receipts against the assigned acceptance criteria.');
    expect(JSON.parse(run!.assignment_snapshot).team_name).toBe('Team Mercury');
    expect(
      (await env
        .ORG_DB!.prepare('SELECT dispatched_at FROM outbox WHERE run_id=?')
        .bind(run!.id)
        .first())!.dispatched_at,
    ).not.toBeNull();
    await expect(
      env
        .ORG_DB!.prepare('UPDATE evaluations SET baseline_sha=? WHERE id=?')
        .bind(head, run!.id)
        .run(),
    ).rejects.toThrow('immutable');
    const orgenv = await organizationEnv(env);
    const step = {
      do: async (_name: string, options: unknown, callback?: () => unknown) =>
        typeof options === 'function' ? options() : callback!(),
    } as unknown as WorkflowStep;
    await new EvaluationWorkflow(ctx, orgenv).run(
      { payload: { runId: run!.id } } as WorkflowEvent<{ runId: string }>,
      step,
    );
    const completed = await env
      .ORG_DB!.prepare(
        'SELECT state,publication_status,report FROM evaluations WHERE id=?',
      )
      .bind(run!.id)
      .first<{ state: string; publication_status: string; report: string }>();
    expect(completed).toMatchObject({
      state: 'COMPLETED',
      publication_status: 'PUBLISHED',
    });
    expect(JSON.parse(completed!.report).assessments[0].status).toBe(
      'UNVERIFIED',
    );
    const calls = vi.mocked(GitHub.prototype.api).mock.calls;
    const checks = calls
      .filter(
        ([path, init]) =>
          /\/check-runs(?:\/9001)?$/.test(path) &&
          ['POST', 'PATCH'].includes(init?.method ?? ''),
      )
      .map(([, init]) => JSON.parse(String(init!.body)));
    expect(checks.map((c) => c.status)).toEqual([
      'queued',
      'in_progress',
      'completed',
    ]);
    expect(checks.slice(0, 2).every((c) => !('conclusion' in c))).toBe(true);
    const check = checks.at(-1);
    expect(check.details_url).toBe(
      env.ORG_PUBLIC_ORIGIN + '/?organization=1&evaluation=' + run!.id,
    );
    expect(check.conclusion).toBe('action_required');
    const bundle = await organization(
      request('/api/organization/evaluations/' + run!.id + '/bundle'),
      env,
      ctx,
    );
    expect(bundle.status).toBe(200);
    const text = await bundle.text();
    expect(JSON.parse(text).evaluation.head_sha).toBe(head);
    const { digest } = await import('../src/domain');
    expect(bundle.headers.get('x-evidence-sha256')).toBe(await digest(text));
    expect(bundle.headers.get('content-disposition')).toContain('attachment');
    expect(
      (
        await organization(
          request(
            '/api/organization/evaluations/' + run!.id + '/bundle',
            'GET',
            undefined,
            '',
          ),
          env,
          ctx,
        )
      ).status,
    ).toBe(401);
  });

  it('deduplicates installation suspension and reconciles a delayed suspend after restoration', async () => {
    const orgenv = await organizationEnv(env);
    const row = await env
      .ORG_DB!.prepare(
        'SELECT installation_id FROM github_connection WHERE id=1',
      )
      .first<{ installation_id: number }>();
    let suspended = true;
    vi.spyOn(GitHub.prototype, 'api').mockImplementation(async (path) => {
      if (path.endsWith('/access_tokens')) return { token: 'test' } as never;
      if (path.startsWith('/app/installations/'))
        return {
          id: row!.installation_id,
          app_id: Number(orgenv.GITHUB_APP_ID),
          account: { login: 'Daksh-Codebase', type: 'Organization' },
          suspended_at: suspended ? '2026-10-02T00:00:00Z' : null,
        } as never;
      if (path.startsWith('/installation/repositories'))
        return {
          repositories: [
            {
              id: 301,
              full_name: 'Daksh-Codebase/payment-engine',
              private: false,
              default_branch: 'main',
            },
          ],
        } as never;
      throw new Error('UNEXPECTED_TEST_PATH');
    });
    async function hook(action: string, delivery: string) {
      const payload = JSON.stringify({
        action,
        installation: { id: row!.installation_id },
      });
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(orgenv.GITHUB_WEBHOOK_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = Buffer.from(
        await crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode(payload),
        ),
      ).toString('hex');
      return organization(
        new Request(env.ORG_PUBLIC_ORIGIN + '/webhooks/organization', {
          method: 'POST',
          body: payload,
          headers: {
            'x-github-event': 'installation',
            'x-github-delivery': delivery,
            'x-hub-signature-256': 'sha256=' + signature,
          },
        }),
        env,
        ctx,
      );
    }
    expect((await hook('suspend', 'suspend-once')).status).toBe(200);
    expect((await body(await hook('suspend', 'suspend-once'))).status).toBe(
      'duplicate',
    );
    suspended = false;
    expect((await hook('unsuspend', 'restore-once')).status).toBe(200);
    expect((await body(await hook('suspend', 'suspend-once'))).status).toBe(
      'duplicate',
    );
    expect((await hook('suspend', 'delayed-suspend')).status).toBe(200);
    expect(
      (await env
        .ORG_DB!.prepare(
          'SELECT accessible FROM github_repositories WHERE id=301',
        )
        .first<{ accessible: number }>())!.accessible,
    ).toBe(1);
    expect((await hook('deleted', 'suspend-once')).status).toBe(409);
  });
  it('protects and throttles synthetic reviewer diagnostics', async () => {
    // Keep all three calls in the same rate-limit bucket across minute boundaries.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const first = await organization(
      request('/api/organization/reviewer-check', 'POST', {}),
      env,
      ctx,
    );
    expect(first.status).toBe(200);
    expect((await body(first)).status).toBe('NOT_CONFIGURED');
    expect(
      (
        await organization(
          request('/api/organization/reviewer-check', 'POST', {}),
          env,
          ctx,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await organization(
          request('/api/organization/reviewer-check', 'POST', {}),
          env,
          ctx,
        )
      ).status,
    ).toBe(429);
  });
  it('rejects unselected repositories, secrets in policy and signed-hook forgery; logout revokes access', async () => {
    const data = {
      repositoryId: 777,
      prNumber: 1,
      issueNumber: 2,
      teamName: 'Test team',
      expectedBehavior: 'Implement the required behavior with tests.',
    };
    await expect(
      organization(
        request('/api/organization/challenges', 'POST', data),
        env,
        ctx,
      ),
    ).rejects.toThrow('REPOSITORY_NOT_INSTALLED');
    expect(
      (
        await organization(
          request('/api/organization/challenges', 'POST', {
            ...data,
            expectedBehavior: 'Secret ghp_' + 'A'.repeat(36),
          }),
          env,
          ctx,
        )
      ).status,
    ).toBe(400);
    const forged = await organization(
      request('/webhooks/organization', 'POST', { action: 'opened' }),
      env,
      ctx,
    );
    expect(forged.status).toBe(401);
    expect(
      (
        await organization(
          request('/api/organization/logout', 'POST', {}),
          env,
          ctx,
        )
      ).status,
    ).toBe(200);
    expect(
      (await organization(request('/api/organization/repositories'), env, ctx))
        .status,
    ).toBe(401);
  });
  it('allows judges to inspect results but rejects all administration and App callbacks', async () => {
    env.ORG_JUDGE_TOKEN = 'judge-test-' + 'b'.repeat(40);
    const login = request(
      '/api/organization/login',
      'POST',
      { token: env.ORG_JUDGE_TOKEN },
      '',
    );
    login.headers.set('cf-connecting-ip', 'judge-fixture');
    const response = await organization(login, env, ctx);
    expect(response.status).toBe(200);
    const judgeCookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const status = (await (
      await organization(
        request('/api/organization/status', 'GET', undefined, judgeCookie),
        env,
        ctx,
      )
    ).json()) as { role: string };
    expect(status.role).toBe('judge');
    expect(
      (
        await organization(
          request(
            '/api/organization/repositories',
            'GET',
            undefined,
            judgeCookie,
          ),
          env,
          ctx,
        )
      ).status,
    ).toBe(200);
    for (const path of [
      '/api/organization/manage/teams',
      '/api/organization/manage/settings',
      '/api/organization/manage/assignments',
      '/api/organization/manage/challenges',
      '/api/organization/runner-check',
      '/api/organization/sync',
    ])
      expect(
        (await organization(request(path, 'POST', {}, judgeCookie), env, ctx))
          .status,
      ).toBe(403);
    expect(
      (
        await organization(
          request(
            '/auth/github/manifest?state=fake&code=fake',
            'GET',
            undefined,
            judgeCookie,
          ),
          env,
          ctx,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await organization(
          request('/api/organization/logout', 'POST', {}, judgeCookie),
          env,
          ctx,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await organization(
          request(
            '/api/organization/repositories',
            'GET',
            undefined,
            judgeCookie,
          ),
          env,
          ctx,
        )
      ).status,
    ).toBe(401);
    delete env.ORG_JUDGE_TOKEN;
  });
});
