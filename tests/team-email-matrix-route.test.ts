import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import type { Env } from '../src/env';
import worker from '../src/index';

const origin = 'https://judge.test';
const organizerToken = 'organizer-token-' + 'a'.repeat(40);
const judgeToken = 'judge-token-' + 'b'.repeat(40);
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil(promise: Promise<unknown>) {
    pending.push(promise);
  },
} as unknown as ExecutionContext;

let mf: Miniflare;
let env: Env;
const assetPaths: string[] = [];

function request(
  path: string,
  method = 'GET',
  data?: unknown,
  cookie?: string,
) {
  return new Request(origin + path, {
    method,
    headers: {
      origin,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}

async function login(token: string) {
  const response = await worker.fetch(
    request('/api/organization/login', 'POST', { token }),
    env,
    ctx,
  );
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}

beforeEach(async () => {
  assetPaths.length = 0;
  mf = new Miniflare({
    modules: true,
    script: 'export default{fetch(){return new Response("ok")}}',
    d1Databases: ['DB', 'ORG_DB'],
    compatibilityDate: '2026-08-01',
  });
  const db = await mf.getD1Database('ORG_DB');
  await migrate(db as unknown as D1Database);
  await db
    .prepare("UPDATE hackathons SET status='ACTIVE' WHERE id='initial'")
    .run();
  env = {
    DB: (await mf.getD1Database('DB')) as unknown as D1Database,
    ORG_DB: db,
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        assetPaths.push(path);
        return new Response(path);
      },
    },
    EVALUATOR: { create: async () => undefined },
    ENVIRONMENT: 'production',
    MATRIX_MODE: 'true',
    ORG_ADMIN_TOKEN: organizerToken,
    ORG_JUDGE_TOKEN: judgeToken,
    ORG_VAULT_KEY: '12'.repeat(32),
    ORG_NAME: 'Doomforge',
    ORG_PUBLIC_ORIGIN: origin,
    TEAM_EMAIL_SENDER: {
      fetch: async () => Response.json({ accepted: true }),
    },
  } as unknown as Env;
});

afterEach(async () => {
  await Promise.all(pending.splice(0));
  await mf.dispose();
});

describe('Matrix-mode organizer email settings route', () => {
  it('lets an authenticated organizer inspect and activate team email', async () => {
    const cookie = await login(organizerToken);
    const get = await worker.fetch(
      request('/api/organization/manage/team-email', 'GET', undefined, cookie),
      env,
      ctx,
    );
    expect(get.status).toBe(200);
    for (const path of [
      '/api/organization/manage/audit',
      '/api/organization/manage/teams',
    ]) {
      expect(
        (await worker.fetch(request(path, 'GET', undefined, cookie), env, ctx))
          .status,
      ).toBe(200);
    }
    expect(await get.json()).toMatchObject({
      enabled: false,
      eventStatus: 'ACTIVE',
      senderConfigured: true,
    });

    const post = await worker.fetch(
      request(
        '/api/organization/manage/team-email',
        'POST',
        { enabled: true },
        cookie,
      ),
      env,
      ctx,
    );
    expect(post.status).toBe(200);
    expect(await dbValue(env.ORG_DB!)).toBe(1);
  });

  it('rejects judge mutations and preserves unknown organization API handling', async () => {
    const cookie = await login(judgeToken);
    for (const path of [
      '/api/organization/manage/team-email',
      '/api/organization/manage/audit',
      '/api/organization/manage/teams',
    ]) {
      expect(
        (await worker.fetch(request(path, 'GET', undefined, cookie), env, ctx))
          .status,
      ).toBe(403);
    }
    const post = await worker.fetch(
      request(
        '/api/organization/manage/team-email',
        'POST',
        { enabled: true },
        cookie,
      ),
      env,
      ctx,
    );
    expect(post.status).toBe(403);

    const organizerCookie = await login(organizerToken);
    const hidden = await worker.fetch(
      request('/api/organization/not-a-route', 'GET', undefined, organizerCookie),
      env,
      ctx,
    );
    expect(hidden.status).toBe(404);
  });

  it('routes authenticated round-two judge APIs through the organization service', async () => {
    const anonymous = await worker.fetch(
      request('/api/organization/round-two/teams'),
      env,
      ctx,
    );
    expect(anonymous.status).toBe(401);

    const cookie = await login(organizerToken);
    const assignedTeams = await worker.fetch(
      request('/api/organization/round-two/teams', 'GET', undefined, cookie),
      env,
      ctx,
    );
    expect(assignedTeams.status).toBe(200);
    expect(await assignedTeams.json()).toMatchObject({ teams: [] });
  });

  it('serves the dashboard SPA at root and deep links while preserving legacy pages', async () => {
    const root = await worker.fetch(request('/'), env, ctx);
    expect(root.status).toBe(200);
    expect(await root.text()).toBe('/index.html');

    const deepLink = await worker.fetch(request('/queue'), env, ctx);
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toBe('/index.html');

    const matrix = await worker.fetch(request('/matrix.html'), env, ctx);
    expect(await matrix.text()).toBe('/matrix.html');
    const review = await worker.fetch(request('/review.html'), env, ctx);
    expect(await review.text()).toBe('/review.html');
    expect(assetPaths).toEqual([
      '/index.html',
      '/index.html',
      '/matrix.html',
      '/review.html',
    ]);
  });
});

async function dbValue(db: D1Database) {
  return (
    await db
      .prepare("SELECT team_email_enabled FROM hackathons WHERE id='initial'")
      .first<{ team_email_enabled: number }>()
  )?.team_email_enabled;
}
