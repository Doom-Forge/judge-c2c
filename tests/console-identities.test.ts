import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import { organization } from '../src/organization';
import { canonical, digest } from '../src/domain';
import { demoContract } from '../src/demo';
import type { Env } from '../src/env';
let mf: Miniflare, env: Env, organizerCookie: string;
const origin = 'https://identity.test',
  admin = 'fixture-admin-' + 'a'.repeat(40);
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
let logins = 0;
async function call(
  path: string,
  session = organizerCookie,
  data?: unknown,
  source = origin,
) {
  return organization(
    new Request(origin + '/api/organization/' + path, {
      method: data ? 'POST' : 'GET',
      headers: {
        origin: source,
        'content-type': 'application/json',
        'cf-connecting-ip': 'identity-fixture-' + ++logins,
        ...(session ? { cookie: session } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }),
    env,
    ctx,
  );
}
async function login(credential: string) {
  const response = await call('login', '', { token: credential });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}
async function issue(name: string, role: string, teamId?: string) {
  const response = await call('identities', organizerCookie, {
    name,
    role,
    ...(teamId ? { teamId } : {}),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{
    id: string;
    credential: string;
    name: string;
    role: string;
  }>;
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
    ORG_ADMIN_TOKEN: admin,
    ORG_VAULT_KEY: '12'.repeat(32),
    ORG_NAME: 'fixture',
    ORG_PUBLIC_ORIGIN: origin,
  } as Env;
  organizerCookie = await login(admin);
  await db
    .prepare(
      "INSERT INTO teams(id,name,status) VALUES('team-a','Team A','ACTIVE'),('team-b','Team B','ACTIVE')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(1,'fixture/repo',1,'main',1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO repositories(id,full_name,installation_id,active_contract_hash) VALUES(1,'fixture/repo',1,?)",
    )
    .bind('a'.repeat(64))
    .run();
  const contract = {
    ...demoContract,
    repository: { ...demoContract.repository, id: 1, fullName: 'fixture/repo' },
  };
  const hash = await digest(canonical(contract));
  await db
    .prepare('INSERT INTO contracts(hash,repository_id,document) VALUES(?,1,?)')
    .bind(hash, canonical(contract))
    .run();
  for (const [team, pr, id] of [
    ['team-a', 10, 'a'.repeat(64)],
    ['team-b', 20, 'b'.repeat(64)],
  ] as const) {
    await db
      .prepare(
        'INSERT INTO evaluations(id,repository_id,pr_number,head_sha,baseline_sha,contract_hash,contract_snapshot,assignment_snapshot,state,evidence,context,report) VALUES(?,1,?,?,?,?,?,?,?, ?,?,?)',
      )
      .bind(
        id,
        pr,
        'c'.repeat(40),
        contract.baseline,
        hash,
        canonical(contract),
        canonical({ team_id: team, team_name: team }),
        'COMPLETED',
        canonical([
          {
            id: 'fixture-check',
            kind: 'source',
            status: 'PASS',
            claim: 'RESTRICTED_EVIDENCE_DETAILS',
          },
        ]),
        canonical({ private: 'RESTRICTED_CONTEXT_DETAILS' }),
        canonical({ private: 'RESTRICTED_REVIEW_DETAILS' }),
      )
      .run();
    await db
      .prepare(
        'INSERT INTO submissions(repository_id,pr_number,head_sha,latest_run_id,github_updated_at,team_id,status,author_login) VALUES(1,?,?,?, ?,?,?,?)',
      )
      .bind(
        pr,
        'c'.repeat(40),
        id,
        '2026-10-04T00:00:00Z',
        team,
        'VALID',
        team + '-author',
      )
      .run();
  }
}, 30000);
afterAll(async () => mf.dispose());
it('issues named hash-only credentials, denies nonorganizers, and revokes active sessions and future logins', async () => {
  const judge = await issue('Named judge', 'judge');
  const judgeCookie = await login(judge.credential);
  const status = (await (await call('status', judgeCookie)).json()) as {
    identity: { id: string; name: string; role: string };
  };
  expect(status.identity).toEqual({
    id: judge.id,
    name: 'Named judge',
    role: 'judge',
    teamId: null,
  });
  for (const [path, data] of [
    ['identities', undefined],
    ['identities', { name: 'Escalation', role: 'organizer' }],
    ['identities/' + judge.id + '/revoke', {}],
    ['manage/settings', {}],
    ['runner-check', {}],
  ] as const)
    expect((await call(path, judgeCookie, data)).status).toBe(403);
  expect((await call('identities', '')).status).toBe(401);
  expect(
    (
      await call(
        'identities',
        organizerCookie,
        { name: 'Cross-origin person', role: 'judge' },
        'https://evil.test',
      )
    ).status,
  ).toBe(403);
  const list = await (await call('identities')).text();
  expect(list).toContain('Named judge');
  expect(list).not.toContain(judge.credential);
  expect(list).not.toContain('credential_hash');
  const stored = await env
    .ORG_DB!.prepare(
      'SELECT credential_hash FROM console_identities WHERE id=?',
    )
    .bind(judge.id)
    .first<{ credential_hash: string }>();
  expect(stored!.credential_hash).toBe(await digest(judge.credential));
  expect(stored!.credential_hash).not.toBe(judge.credential);
  await expect(
    env
      .ORG_DB!.prepare(
        "UPDATE console_identities SET role='organizer' WHERE id=?",
      )
      .bind(judge.id)
      .run(),
  ).rejects.toThrow('CONSOLE_IDENTITY_IMMUTABLE');
  expect(
    (await call('identities/' + judge.id + '/revoke', organizerCookie, {}))
      .status,
  ).toBe(200);
  expect((await call('manage/teams', judgeCookie)).status).toBe(401);
  expect((await call('login', '', { token: judge.credential })).status).toBe(
    401,
  );
  expect(
    (await env
      .ORG_DB!.prepare(
        'SELECT count(*) AS n FROM console_identity_sessions WHERE identity_id=?',
      )
      .bind(judge.id)
      .first<{ n: number }>())!.n,
  ).toBe(0);
  await expect(
    env
      .ORG_DB!.prepare(
        'UPDATE console_identities SET revoked_at=NULL WHERE id=?',
      )
      .bind(judge.id)
      .run(),
  ).rejects.toThrow('CONSOLE_IDENTITY_REVOKED');
});
it('isolates participant lists and criterion outcomes, denies cross-team and sensitive APIs, and withdraws archived-team access', async () => {
  expect(
    (
      await call('identities', organizerCookie, {
        name: 'Unknown participant',
        role: 'participant',
        teamId: 'unknown',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('identities', organizerCookie, {
        name: 'Invalid judge scope',
        role: 'judge',
        teamId: 'team-a',
      })
    ).status,
  ).toBe(400);
  const participant = await issue('Named participant', 'participant', 'team-a');
  const participantCookie = await login(participant.credential);
  const status = (await (
    await call('status', participantCookie)
  ).json()) as Record<string, unknown>;
  expect(status.role).toBe('participant');
  expect(status).not.toHaveProperty('app');
  expect(status).not.toHaveProperty('runner');
  const response = await call('participant?teamId=team-b', participantCookie);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const list = (await response.json()) as {
    team: { id: string };
    submissions: { pr_number: number }[];
    evaluations: { id: string }[];
  };
  expect(list.team.id).toBe('team-a');
  expect(list.submissions.map((s) => s.pr_number)).toEqual([10]);
  expect(list.evaluations.map((e) => e.id)).toEqual(['a'.repeat(64)]);
  const own = await call(
    'participant/evaluations/' + 'a'.repeat(64),
    participantCookie,
  );
  expect(own.status).toBe(200);
  const text = await own.text();
  expect(text).toContain('UNVERIFIED');
  expect(text).not.toContain('RESTRICTED_');
  expect(text).not.toContain('contract_snapshot');
  expect(
    (await call('participant/evaluations/' + 'b'.repeat(64), participantCookie))
      .status,
  ).toBe(404);
  for (const path of [
    'identities',
    'manage/teams',
    'manage/settings',
    'manage/submissions',
    'manage/audit',
    'repositories',
    'security-reports',
    'evaluations/' + 'a'.repeat(64),
    'artifact?key=fixture-private-object',
    'system/metrics',
    'system/evaluation-metrics',
    '../auth/github/manifest',
  ])
    expect((await call(path, participantCookie)).status).toBe(403);
  for (const path of [
    'participant',
    'participant/evaluations/' + 'a'.repeat(64),
    'identities',
    'manage/teams',
  ])
    expect((await call(path, participantCookie, {})).status).toBe(403);
  await env
    .ORG_DB!.prepare("UPDATE teams SET status='DISQUALIFIED' WHERE id='team-a'")
    .run();
  expect((await call('participant', participantCookie)).status).toBe(401);
  expect(
    (await call('login', '', { token: participant.credential })).status,
  ).toBe(401);
});
it('grants named security reviewers confidential access only and attributes organizer actions to stable named identity', async () => {
  const security = await issue('Named security reviewer', 'security');
  const securityCookie = await login(security.credential);
  expect((await call('security-reports', securityCookie)).status).toBe(200);
  for (const path of [
    'identities',
    'manage/teams',
    'repositories',
    'evaluations/' + 'a'.repeat(64),
    'participant',
  ])
    expect((await call(path, securityCookie)).status).toBe(403);
  const organizer = await issue('Named organizer', 'organizer');
  const namedCookie = await login(organizer.credential);
  const created = await call('identities', namedCookie, {
    name: 'Delegated judge',
    role: 'judge',
  });
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const audit = await env
    .ORG_DB!.prepare(
      "SELECT actor,changes FROM audit WHERE action='identity.created' AND entity=?",
    )
    .bind(id)
    .first<{ actor: string; changes: string }>();
  expect(audit!.actor).toBe('organizer:' + organizer.id);
  expect(audit!.changes).not.toContain('credential');
  expect((await call('logout', namedCookie, {})).status).toBe(200);
  expect((await call('identities', namedCookie)).status).toBe(401);
});
