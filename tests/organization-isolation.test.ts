import { expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import {
  organization,
  organizationEnv,
  seal,
  unseal,
} from '../src/organization';
import { eventSettings } from '../src/competition-store';
import type { Env } from '../src/env';

it('isolates two organization resources, sessions, submissions and encrypted App credentials while exposing the single-event boundary', async () => {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default{}',
    d1Databases: ['ORG_A', 'ORG_B'],
    compatibilityDate: '2026-08-01',
  });
  try {
    const envs: Env[] = [];
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    for (const [i, binding] of ['ORG_A', 'ORG_B'].entries()) {
      const db = (await runtime.getD1Database(
        binding,
      )) as unknown as D1Database;
      await migrate(db);
      const name = i === 0 ? 'Organization-A' : 'Organization-B';
      const env = {
        ORG_DB: db,
        ORG_NAME: name,
        ORG_PUBLIC_ORIGIN: 'https://isolation.test',
        ORG_VAULT_KEY: '12'.repeat(32),
        ORG_ADMIN_TOKEN: `fixture-org-${i}-` + 'x'.repeat(40),
        ORG_EVALUATOR: { create: async () => ({}) },
      } as unknown as Env;
      envs.push(env);
      await db
        .prepare(
          'INSERT INTO github_connection(id,app_id,slug,encrypted,installation_id) VALUES(1,?,?,?,?)',
        )
        .bind(
          100 + i,
          `app-${i}`,
          await seal(env, {
            id: 100 + i,
            slug: `app-${i}`,
            key: `private-fixture-${i}`,
            webhookSecret: `webhook-fixture-${i}`,
          }),
          200 + i,
        )
        .run();
      await db
        .prepare(
          'INSERT INTO repositories(id,full_name,installation_id,active_contract_hash) VALUES(1,?,?,?)',
        )
        .bind(`${name}/repo`, 200 + i, 'a'.repeat(64))
        .run();
      await db
        .prepare(
          'INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(1,?,1,?)',
        )
        .bind(`${name}/repo`, 'main')
        .run();
      await db
        .prepare('INSERT INTO teams(id,name) VALUES(?,?)')
        .bind('same-team-id', `${name} team`)
        .run();
      await db
        .prepare(
          "INSERT INTO submissions(repository_id,pr_number,head_sha,github_updated_at,team_id,status) VALUES(1,1,?,?,?,'VALID')",
        )
        .bind(String(i + 1).repeat(40), '2026-10-04T00:00:00Z', 'same-team-id')
        .run();
      await db
        .prepare(
          "INSERT INTO hackathons(id,name,status,policy,taxonomy) VALUES('archived-event',?,'ARCHIVED','{}','[]')",
        )
        .bind(`${name} prior event`)
        .run();
      await db
        .prepare("UPDATE hackathons SET name=? WHERE id='initial'")
        .bind(`${name} current event`)
        .run();
    }
    const makeRequest = (
      path: string,
      session = '',
      method = 'GET',
      body?: unknown,
    ) =>
      new Request('https://isolation.test' + path, {
        method,
        headers: {
          origin: 'https://isolation.test',
          'content-type': 'application/json',
          ...(session ? { cookie: session } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const sessions: string[] = [];
    for (const env of envs) {
      const login = await organization(
        makeRequest('/api/organization/login', '', 'POST', {
          token: env.ORG_ADMIN_TOKEN,
        }),
        env,
        ctx,
      );
      expect(login.status).toBe(200);
      sessions.push(login.headers.get('set-cookie')!.split(';')[0]!);
    }
    expect(
      (
        await organization(
          makeRequest('/api/organization/manage/teams', sessions[0]),
          envs[1]!,
          ctx,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await organization(
          makeRequest('/api/organization/manage/teams', sessions[1]),
          envs[0]!,
          ctx,
        )
      ).status,
    ).toBe(401);
    for (const [i, env] of envs.entries()) {
      const own = i === 0 ? 'Organization-A' : 'Organization-B',
        other = i === 0 ? 'Organization-B' : 'Organization-A';
      for (const path of [
        '/api/organization/manage/teams',
        '/api/organization/manage/submissions',
        '/api/organization/status',
      ]) {
        const response = await organization(
          makeRequest(path, sessions[i]),
          env,
          ctx,
        );
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain(own);
        expect(text).not.toContain(other);
        expect(text).not.toContain('private-fixture');
        expect(text).not.toContain('webhook-fixture');
      }
      const effective = await organizationEnv(env);
      expect(effective.DB).toBe(env.ORG_DB);
      expect(effective.GITHUB_APP_ID).toBe(String(100 + i));
      expect(effective.GITHUB_APP_PRIVATE_KEY).toBe(`private-fixture-${i}`);
      expect((await eventSettings(env)).name).toBe(`${own} current event`);
      expect(
        await env
          .ORG_DB!.prepare(
            "SELECT name FROM hackathons WHERE id='archived-event'",
          )
          .first(),
      ).toEqual({ name: `${own} prior event` });
    }
    const encrypted = (await envs[0]!
      .ORG_DB!.prepare('SELECT encrypted FROM github_connection WHERE id=1')
      .first<{ encrypted: string }>())!.encrypted;
    // Same vault key still cannot cross organizations: authenticated additional data binds ORG_NAME.
    await expect(unseal(envs[1]!, encrypted)).rejects.toThrow();
    await envs[1]!
      .ORG_DB!.prepare('UPDATE github_connection SET encrypted=? WHERE id=1')
      .bind(encrypted)
      .run();
    await expect(organizationEnv(envs[1]!)).rejects.toThrow();
    expect((await organizationEnv(envs[0]!)).GITHUB_APP_ID).toBe('100');
  } finally {
    await runtime.dispose();
  }
}, 30000);

it('keeps HTTP sessions and mutations isolated across two independently configured Worker isolates', async () => {
  const { buildSync } = await import('esbuild');
  const script = buildSync({
    stdin: {
      // Miniflare's host proxy restricts Origin headers. Forward the fixture value
      // under a test-only header, then restore it before the real router checks it.
      contents: `import { organization } from './src/organization.ts';
export default { fetch(request,env,ctx) { const headers=new Headers(request.headers);headers.set('origin',headers.get('x-fixture-origin'));headers.delete('x-fixture-origin');return organization(new Request(request,{headers}),env,ctx); } };`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    external: ['cloudflare:workers', 'node:*'],
  }).outputFiles[0]!.text;
  const names = ['organization-a', 'organization-b'];
  const origins = names.map((name) => `https://${name}.test`);
  const tokens = names.map((name) => `fixture-${name}-` + 'x'.repeat(40));
  const runtime = new Miniflare({
    workers: names.map((name, index) => ({
      name,
      modules: true,
      script,
      d1Databases: { ORG_DB: crypto.randomUUID() },
      bindings: {
        ORG_NAME: name,
        ORG_PUBLIC_ORIGIN: origins[index]!,
        ORG_ADMIN_TOKEN: tokens[index]!,
        ORG_VAULT_KEY: '12'.repeat(32),
      },
      compatibilityDate: '2026-08-01',
      compatibilityFlags: ['nodejs_compat'],
    })),
  });
  try {
    const workers = await Promise.all(
      names.map((name) => runtime.getWorker(name)),
    );
    const databases = await Promise.all(
      names.map(async (name) => {
        const db = (await runtime.getD1Database(
          'ORG_DB',
          name,
        )) as unknown as D1Database;
        await migrate(db);
        await db
          .prepare(
            "INSERT INTO teams(id,name,status) VALUES('same-id',?,'ACTIVE')",
          )
          .bind(`${name} team`)
          .run();
        return db;
      }),
    );
    const request = (
      index: number,
      path: string,
      cookie = '',
      method = 'GET',
      body?: unknown,
      sourceOrigin = origins[index]!,
    ) =>
      workers[index]!.fetch(sourceOrigin + path, {
        method,
        headers: {
          'x-fixture-origin': sourceOrigin,
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const cookies: string[] = [];
    for (const index of [0, 1]) {
      const login = await request(
        index,
        '/api/organization/login',
        '',
        'POST',
        { token: tokens[index] },
      );
      expect(login.status, await login.clone().text()).toBe(200);
      expect(login.headers.get('set-cookie')).toContain('Secure');
      cookies.push(login.headers.get('set-cookie')!.split(';')[0]!);
    }
    for (const index of [0, 1]) {
      const other = 1 - index;
      const own = await request(
        index,
        '/api/organization/manage/teams',
        cookies[index],
      );
      expect(own.status).toBe(200);
      const ownText = await own.text();
      expect(ownText).toContain(`${names[index]} team`);
      expect(ownText).not.toContain(`${names[other]} team`);
      const foreignCookie = await request(
        index,
        '/api/organization/manage/teams',
        cookies[other],
      );
      expect(foreignCookie.status).toBe(401);
      const foreignToken = await request(
        index,
        '/api/organization/login',
        '',
        'POST',
        { token: tokens[other] },
      );
      expect(foreignToken.status).toBe(401);
      const foreignOrigin = await request(
        index,
        '/api/organization/manage/teams',
        cookies[index],
        'GET',
        undefined,
        origins[other],
      );
      expect(foreignOrigin.status).toBe(403);
    }
    const mutation = await request(
      0,
      '/api/organization/manage/teams/same-id',
      cookies[0],
      'PATCH',
      { name: 'organization-a changed team' },
    );
    expect(mutation.status).toBe(200);
    expect(
      await databases[0]!
        .prepare("SELECT name FROM teams WHERE id='same-id'")
        .first(),
    ).toEqual({ name: 'organization-a changed team' });
    expect(
      await databases[1]!
        .prepare("SELECT name FROM teams WHERE id='same-id'")
        .first(),
    ).toEqual({ name: 'organization-b team' });
    const foreignMutation = await request(
      1,
      '/api/organization/manage/teams/same-id',
      cookies[0],
      'PATCH',
      { name: 'cross-organization edit' },
    );
    expect(foreignMutation.status).toBe(401);
    expect(
      await databases[1]!
        .prepare("SELECT name FROM teams WHERE id='same-id'")
        .first(),
    ).toEqual({ name: 'organization-b team' });
  } finally {
    await runtime.dispose();
  }
}, 30000);
