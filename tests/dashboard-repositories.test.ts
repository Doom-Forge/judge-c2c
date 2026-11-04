import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { api } from '../src/api';
import type { Env } from '../src/env';
import { migrate } from './database';

let runtime: Miniflare;
let env: Env;
const token = 'synthetic-dashboard-admin-' + 'a'.repeat(40);
const request = (path: string, credential = token) =>
  new Request('https://dashboard.test' + path, {
    headers: { authorization: `Bearer ${credential}` },
  });

beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script: 'export default{}',
    d1Databases: ['DB', 'ORG_DB'],
    compatibilityDate: '2026-08-01',
  });
  const db = (await runtime.getD1Database('DB')) as unknown as D1Database;
  const org = (await runtime.getD1Database('ORG_DB')) as unknown as D1Database;
  await migrate(db);
  await migrate(org);
  env = {
    DB: db,
    ORG_DB: org,
    ADMIN_TOKEN: token,
    ENVIRONMENT: 'production',
    DEMO_MODE: 'false',
  } as Env;
}, 30000);

beforeEach(async () => {
  for (const db of [env.DB, env.ORG_DB!]) {
    await db.prepare('DELETE FROM contracts').run();
    await db.prepare('DELETE FROM repositories').run();
    await db.prepare('DELETE FROM github_repositories').run();
  }
});

afterAll(async () => runtime.dispose());

async function connect(id: number, accessible = 1) {
  await env
    .ORG_DB!.prepare(
      'INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(?,?,1,?,?)',
    )
    .bind(id, `fixture-org/repo-${id}`, 'main', accessible)
    .run();
}

async function configure(db: D1Database, id: number) {
  const hash = String(id).padStart(64, 'a');
  await db
    .prepare(
      'INSERT INTO repositories(id,full_name,installation_id,active_contract_hash) VALUES(?,?,1,?)',
    )
    .bind(id, `fixture-org/repo-${id}`, hash)
    .run();
  await db
    .prepare('INSERT INTO contracts(hash,repository_id,document) VALUES(?,?,?)')
    .bind(hash, id, '{}')
    .run();
}

it('shows connected repositories before judging setup and counts them without creating contracts', async () => {
  await connect(1);
  await connect(2);
  await connect(3, 0);
  const response = await api(request('/api/repositories'), env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    repositories: [
      {
        id: 1,
        full_name: 'fixture-org/repo-1',
        connected: true,
        judgingConfigured: false,
      },
      {
        id: 2,
        full_name: 'fixture-org/repo-2',
        connected: true,
        judgingConfigured: false,
      },
    ],
  });
  expect(await (await api(request('/api/overview'), env)).json()).toMatchObject(
    {
      counts: { repositories: 2, teams: 0, openSubmissions: 0 },
    },
  );
  for (const db of [env.DB, env.ORG_DB!]) {
    expect(
      await db.prepare('SELECT count(*) AS count FROM contracts').first(),
    ).toEqual({ count: 0 });
    expect(
      await db.prepare('SELECT count(*) AS count FROM repositories').first(),
    ).toEqual({ count: 0 });
  }
});

it('deduplicates connected and registered repositories and reflects setup in either database', async () => {
  await connect(1);
  await connect(2);
  await configure(env.DB, 1);
  await configure(env.ORG_DB!, 2);
  await configure(env.DB, 4);
  const response = await api(request('/api/repositories'), env);
  expect(await response.json()).toMatchObject({
    repositories: [
      { id: 1, connected: true, judgingConfigured: true },
      { id: 2, connected: true, judgingConfigured: true },
      { id: 4, connected: false, judgingConfigured: true },
    ],
  });
  expect(await (await api(request('/api/overview'), env)).json()).toMatchObject(
    {
      counts: { repositories: 3 },
    },
  );
});

it('keeps connected organization metadata behind dashboard authentication and out of synthetic views', async () => {
  await connect(1);
  for (const path of ['/api/repositories', '/api/overview']) {
    expect((await api(request(path, 'invalid'), env)).status).toBe(401);
    const response = await api(request(path), { ...env, DEMO_MODE: 'true' });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('fixture-org');
  }
});
