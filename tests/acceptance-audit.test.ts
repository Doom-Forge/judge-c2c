import { beforeEach, afterEach, it, expect } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import { demoContract } from '../src/demo';
import { createTeam } from '../src/competition-teams';
import {
  assignIssue,
  publishChallenge,
  syncIssue,
  reviewIssue,
  queueIssueLabels,
  expirationStatements,
} from '../src/competition-issues';
import {
  processCompetitionDelivery,
  synchronizeLabels,
  maintainCompetition,
} from '../src/competition-sync';
import { canonical } from '../src/domain';
import {
  eventSettings,
  type CompetitionServices,
} from '../src/competition-store';
import type { Env } from '../src/env';
import type { GitHub } from '../src/github';
let mf: Miniflare, env: Env, services: CompetitionServices;
let nativeLabels: string[], state: string, nativeCreated: string;
const ctx = { waitUntil(_: Promise<unknown>) {} } as ExecutionContext;
beforeEach(async () => {
  nativeLabels = [];
  state = 'open';
  nativeCreated = new Date().toISOString();
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['ORG_DB'],
    compatibilityDate: '2026-08-01',
  });
  const db = (await mf.getD1Database('ORG_DB')) as unknown as D1Database;
  await migrate(db);
  await db
    .prepare(
      "INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(1,'demo/challenge',0,'main')",
    )
    .run();
  env = { ORG_DB: db } as Env;
  services = {
    installationId: async () => 1,
    appSlug: async () => 'judge-test',
    evaluationEnv: async () => env,
    client: async () =>
      ({
        api: async (path: string, init?: RequestInit) => {
          if (path.startsWith('/users/'))
            return { id: 101, login: 'alice', type: 'User' };
          if (path.includes('/commits/')) return { sha: demoContract.baseline };
          if (path.endsWith('/issues/12/labels')) {
            if (init?.method === 'POST') {
              nativeLabels.push(...JSON.parse(String(init.body)).labels);
              return [];
            }
            return nativeLabels.map((name) => ({ name }));
          }
          if (path.includes('/issues/12/labels/')) {
            nativeLabels = nativeLabels.filter(
              (n) => n !== decodeURIComponent(path.split('/').at(-1)!),
            );
            return undefined;
          }
          if (path.includes('/labels?'))
            return (await eventSettings(env)).taxonomy;
          if (path.endsWith('/issues/12'))
            return {
              number: 12,
              title: 'Endpoint crashes',
              body: 'Steps: omit input. Expected validation; actual crash.',
              state,
              user: { id: 101, login: 'alice' },
              labels: nativeLabels.map((name) => ({ name })),
              updated_at: '2026-10-02T00:00:00Z',
              created_at: nativeCreated,
            };
          throw Error('Unexpected fixture ' + path);
        },
      }) as unknown as GitHub,
  };
});
afterEach(async () => {
  await mf.dispose();
});
async function challenge() {
  await publishChallenge(env, services, 'organizer:qa', {
    repositoryId: 1,
    issueNumber: 12,
    claimable: true,
    contract: {
      ...demoContract,
      repository: { ...demoContract.repository, fullName: 'demo/challenge' },
      issueNumbers: [12],
    },
  });
  return createTeam(env, services, 'organizer:qa', {
    name: 'Alpha',
    status: 'ACTIVE',
    members: [{ githubLogin: 'alice', displayName: 'Alice' }],
    repositoryIds: [1],
  });
}
async function labelEvent(
  id: string,
  senderId: number,
  action = 'unlabeled',
  label = 'judge:type:bug',
) {
  await env
    .ORG_DB!.prepare(
      'INSERT INTO management_inbox(id,payload_hash,event,document) VALUES(?,?,?,?)',
    )
    .bind(
      id,
      id,
      'issues',
      canonical({
        event: 'issues',
        action,
        installationId: 1,
        repositoryId: 1,
        number: 12,
        sender: { id: senderId, login: 'actor', type: 'User' },
        label,
      }),
    )
    .run();
  await processCompetitionDelivery(env, services, ctx, id);
}
it('rejects claiming an approved but GitHub-closed issue', async () => {
  const team = await challenge();
  const settings = await eventSettings(env);
  await env
    .ORG_DB!.prepare('UPDATE hackathons SET policy=?')
    .bind(canonical({ ...settings.policy, claimingEnabled: true }))
    .run();
  state = 'closed';
  await syncIssue(env, services, 1, 12);
  await expect(
    assignIssue(
      env,
      'github:101',
      { teamId: team.id, repositoryId: 1, issueNumber: 12 },
      'CLAIM',
    ),
  ).rejects.toThrow('ISSUE_NOT_AVAILABLE');
  expect(
    (await env
      .ORG_DB!.prepare('SELECT count(*) AS n FROM issue_assignments')
      .first())!.n,
  ).toBe(0);
});
it('does not grant organizer override authority to an unconfigured native actor', async () => {
  await syncIssue(env, services, 1, 12);
  await labelEvent('participant-remove', 101);
  const row = await env
    .ORG_DB!.prepare('SELECT overrides FROM github_issues')
    .first<{ overrides: string }>();
  expect(JSON.parse(row!.overrides).suppressedLabels ?? []).not.toContain(
    'judge:type:bug',
  );
  expect(
    (await env
      .ORG_DB!.prepare(
        "SELECT count(*) AS n FROM audit WHERE action='issue.label.untrusted-change'",
      )
      .first())!.n,
  ).toBe(1);
});
it('preserves configured organizer label overrides and synchronizes without loops', async () => {
  await syncIssue(env, services, 1, 12);
  const settings = await eventSettings(env);
  await env
    .ORG_DB!.prepare('UPDATE hackathons SET policy=?')
    .bind(canonical({ ...settings.policy, organizerGitHubIds: [900] }))
    .run();
  await labelEvent('organizer-remove', 900);
  const id = await queueIssueLabels(env, 1, 12);
  await synchronizeLabels(env, services, id!);
  expect(nativeLabels).not.toContain('judge:type:bug');
  expect(nativeLabels).toContain('judge:status:needs-triage');
  const before = [...nativeLabels];
  await synchronizeLabels(env, services, (await queueIssueLabels(env, 1, 12))!);
  expect(nativeLabels).toEqual(before);
});
it('applies explicit advisory dimensions without overriding an organizer decision', async () => {
  await syncIssue(env, services, 1, 12);
  await reviewIssue(env, 'organizer:qa', 1, 12, {
    reviewStatus: 'NEEDS_TRIAGE',
    priority: 'high',
    difficulty: 'hard',
    reason: 'Organizer assessed event priority and implementation scope.',
  });
  await synchronizeLabels(env, services, (await queueIssueLabels(env, 1, 12))!);
  expect(nativeLabels).toContain('judge:priority:high');
  expect(nativeLabels).toContain('judge:difficulty:hard');
  expect(nativeLabels).toContain('judge:domain:api');
  expect(nativeLabels).toContain('judge:evaluation:not-scored');
  await syncIssue(env, services, 1, 12);
  const row = await env
    .ORG_DB!.prepare('SELECT classification,official FROM github_issues')
    .first<{ classification: string; official: number }>();
  expect(JSON.parse(row!.classification)).toMatchObject({
    priority: 'high',
    difficulty: 'hard',
    provenance: 'organizer',
  });
  expect(row!.official).toBe(0);
});
it('retains source provenance and does not turn GitHub closure into successful completion', async () => {
  await challenge();
  await assignIssue(env, 'organizer:qa', {
    teamId: (await env
      .ORG_DB!.prepare('SELECT id FROM teams')
      .first<{ id: string }>())!.id,
    repositoryId: 1,
    issueNumber: 12,
  });
  state = 'closed';
  await syncIssue(env, services, 1, 12);
  expect(
    await env
      .ORG_DB!.prepare('SELECT github_state,source,official FROM github_issues')
      .first(),
  ).toEqual({ github_state: 'closed', source: 'PARTICIPANT', official: 1 });
  expect(
    (await env
      .ORG_DB!.prepare('SELECT progress FROM issue_assignments')
      .first())!.progress,
  ).not.toBe('COMPLETED');
  state = 'open';
  await syncIssue(env, services, 1, 12);
  expect(
    (await env
      .ORG_DB!.prepare('SELECT github_state FROM github_issues')
      .first())!.github_state,
  ).toBe('open');
});
it('routes repeated reports to reversible moderation without deleting or rewarding issues', async () => {
  for (let n = 20; n < 40; n++)
    await env
      .ORG_DB!.prepare(
        "INSERT INTO github_issues(repository_id,number,title,body,github_state,author_id,author_login,source,labels,classification,github_updated_at,snapshot_hash) VALUES(1,?,'Other report','','open',101,'alice','UNKNOWN','[]',?,'2026-10-02T00:00:00Z','hash')",
      )
      .bind(n, JSON.stringify({ nativeCreatedAt: new Date().toISOString() }))
      .run();
  const issue = await syncIssue(env, services, 1, 12);
  expect(issue.classification.flags).toContain('possible-spam');
  nativeCreated = '2000-01-01T00:00:00Z';
  expect(
    (await syncIssue(env, services, 1, 12)).classification.flags,
  ).not.toContain('possible-spam');
  nativeCreated = new Date().toISOString();
  await syncIssue(env, services, 1, 12);
  await synchronizeLabels(env, services, (await queueIssueLabels(env, 1, 12))!);
  expect(nativeLabels).toContain('judge:status:possible-spam');
  expect(nativeLabels).toContain('judge:evaluation:not-scored');
  expect(
    (await env
      .ORG_DB!.prepare('SELECT count(*) AS n FROM github_issues')
      .first())!.n,
  ).toBe(21);
});
it('expires reservations with one audit record and reconciles issue availability', async () => {
  const team = await challenge();
  const a = await assignIssue(env, 'organizer:qa', {
    teamId: team.id,
    repositoryId: 1,
    issueNumber: 12,
    reservation: true,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  await env
    .ORG_DB!.prepare(
      "UPDATE issue_assignments SET expires_at='2000-01-01T00:00:00Z' WHERE id=?",
    )
    .bind(a.id)
    .run();
  await maintainCompetition(env, services, ctx);
  await maintainCompetition(env, services, ctx);
  expect(
    (await env
      .ORG_DB!.prepare('SELECT status FROM issue_assignments WHERE id=?')
      .bind(a.id)
      .first())!.status,
  ).toBe('EXPIRED');
  expect(
    (await env
      .ORG_DB!.prepare(
        "SELECT count(*) AS n FROM audit WHERE action='issue.assignment.expired' AND entity=?",
      )
      .bind(a.id)
      .first())!.n,
  ).toBe(1);
  expect(nativeLabels).toContain('judge:status:available');
});
it('combines issue team, label, progress, priority and difficulty filters', async () => {
  const { competition } = await import('../src/competition');
  const team = await challenge();
  await assignIssue(env, 'organizer:qa', {
    teamId: team.id,
    repositoryId: 1,
    issueNumber: 12,
  });
  await reviewIssue(env, 'organizer:qa', 1, 12, {
    reviewStatus: 'APPROVED',
    priority: 'high',
    difficulty: 'hard',
    reason: 'Organizer reviewed challenge priority and difficulty.',
  });
  await synchronizeLabels(env, services, (await queueIssueLabels(env, 1, 12))!);
  await syncIssue(env, services, 1, 12);
  const query = `team=${team.id}&workflow=assigned&priority=high&difficulty=hard&label=judge:evaluation:approved-challenge`;
  const read = async (q: string) => {
    const response = await competition(
      new Request('https://internal/api/organization/manage/issues?' + q),
      env,
      ctx,
      services,
      'judge:qa',
    );
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      issues: { number: number; workflow_status: string }[];
    }>;
  };
  expect((await read(query)).issues).toEqual([
    expect.objectContaining({ number: 12, workflow_status: 'assigned' }),
  ]);
  expect((await read(query + '&repository=2')).issues).toEqual([]);
  expect(
    (await read(query.replace('priority=high', 'priority=low'))).issues,
  ).toEqual([]);
  await env
    .ORG_DB!.prepare("UPDATE issue_assignments SET progress='COMPLETED'")
    .run();
  expect((await read('workflow=completed')).issues).toEqual([
    expect.objectContaining({ number: 12, workflow_status: 'completed' }),
  ]);
});

it('never offers a closed official issue as available', async () => {
  const { competition } = await import('../src/competition');
  await challenge();
  state = 'closed';
  await syncIssue(env, services, 1, 12);
  const response = await competition(
    new Request(
      'https://internal/api/organization/manage/issues?workflow=available',
    ),
    env,
    ctx,
    services,
    'judge:qa',
  );
  expect(((await response.json()) as { issues: unknown[] }).issues).toEqual([]);
});

it('inline assignment expiry leaves other issues for audited maintenance', async () => {
  const team = await challenge();
  const a = await assignIssue(env, 'organizer:qa', {
    teamId: team.id,
    repositoryId: 1,
    issueNumber: 12,
  });
  await env
    .ORG_DB!.prepare(
      "UPDATE issue_assignments SET expires_at='2000-01-01T00:00:00Z' WHERE id=?",
    )
    .bind(a.id)
    .run();
  await env.ORG_DB!.batch(
    expirationStatements(env, { repositoryId: 1, issueNumber: 13 }).slice(1),
  );
  expect(
    (await env
      .ORG_DB!.prepare('SELECT status FROM issue_assignments WHERE id=?')
      .bind(a.id)
      .first())!.status,
  ).toBe('ACTIVE');
  await maintainCompetition(env, services, ctx);
  expect(
    (await env
      .ORG_DB!.prepare('SELECT status FROM issue_assignments WHERE id=?')
      .bind(a.id)
      .first())!.status,
  ).toBe('EXPIRED');
  expect(nativeLabels).toContain('judge:status:available');
});
