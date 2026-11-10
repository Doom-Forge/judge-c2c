import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Miniflare } from './miniflare';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { migrate } from './database';
import { organization, seal } from '../src/organization';
import { GitHub } from '../src/github';
import { createTeam } from '../src/competition-teams';
import {
  syncIssue,
  publishChallenge,
  assignIssue,
  reviewIssue,
  expirationStatements,
} from '../src/competition-issues';
import { updateAssignmentProgress } from '../src/competition-completion';
import { competition } from '../src/competition';
import { demoContract } from '../src/demo';
import { canonical } from '../src/domain';
import type { Env } from '../src/env';
import type { CompetitionServices } from '../src/competition-store';
let mf: Miniflare,
  env: Env,
  services: CompetitionServices,
  sequence = 0;
const origin = 'https://issue-lifecycle.test',
  secret = 'fixture-webhook-secret-' + 's'.repeat(40);
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil(p: Promise<unknown>) {
    pending.push(p);
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;
const issues = new Map<
  number,
  {
    title: string;
    body: string;
    state: string;
    assignees: { id: number; login: string }[];
  }
>();
let pull = {
  number: 47,
  title: 'Fixture PR',
  body: 'Closes #12',
  user: { id: 101, login: 'alice' },
  state: 'open',
  draft: false,
  head: { sha: 'b'.repeat(40) },
  base: { sha: demoContract.baseline, repo: { id: 1 } },
  updated_at: '2026-10-04T00:00:00Z',
};
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
function issue(number: number) {
  return {
    number,
    title: 'Endpoint crashes when invalid input is missing',
    body: 'Steps to reproduce: omit input. Expected validation; actual error response.',
    state: 'open',
    user: { id: 101, login: 'alice' },
    labels: [],
    assignees: [],
    created_at: new Date().toISOString(),
    updated_at: new Date(Date.now() + sequence * 1000).toISOString(),
    ...issues.get(number),
  };
}
async function native(path: string, init?: RequestInit): Promise<unknown> {
  if (path.includes('/access_tokens'))
    return { token: 'fixture-installation-token' };
  if (path.startsWith('/users/'))
    return {
      id: path.endsWith('alice') ? 101 : 102,
      login: path.split('/').at(-1),
      type: 'User',
    };
  if (path.includes('/commits/') && path.includes('check-runs'))
    return { check_runs: [] };
  if (path.includes('check-runs')) return { id: 7 };
  if (path.includes('/issues/') && !path.endsWith('/labels'))
    return issue(Number(path.split('/').at(-1)));
  if (path.includes('/pulls/')) return pull;
  if (path === '/graphql')
    return {
      data: {
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: [],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    };
  if (path.endsWith('/labels') && !init?.method) return [];
  if (path.includes('/labels')) return {};
  if (path.includes('/commits/')) return { sha: demoContract.baseline };
  throw Error('Unexpected fixture path ' + path);
}
async function drain() {
  let consumed = 0;
  while (consumed < pending.length) {
    const end = pending.length;
    await Promise.all(pending.slice(consumed, end));
    consumed = end;
  }
}
async function signed(
  event: string,
  action: string,
  number = 12,
  delivery = crypto.randomUUID(),
) {
  sequence++;
  const payload = {
    action,
    installation: { id: 1 },
    repository: { id: 1, full_name: 'fixture/challenge' },
    sender: { id: 101, login: 'alice', type: 'User' },
    ...(event === 'issues'
      ? { issue: { number } }
      : { pull_request: { number } }),
  };
  const body = JSON.stringify(payload),
    key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  const signature = Buffer.from(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  ).toString('hex');
  return organization(
    new Request(origin + '/webhooks/organization', {
      method: 'POST',
      body,
      headers: {
        'x-github-event': event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': 'sha256=' + signature,
      },
    }),
    env,
    ctx,
  );
}
async function team(name = 'Alpha', login = 'alice') {
  return createTeam(env, services, 'organizer:fixture', {
    name,
    status: 'ACTIVE',
    members: [{ githubLogin: login, displayName: login }],
    repositoryIds: [1],
  });
}
async function publish(number = 12, extra = {}) {
  return publishChallenge(env, services, 'organizer:fixture', {
    repositoryId: 1,
    issueNumber: number,
    contract: {
      ...demoContract,
      repository: { ...demoContract.repository, fullName: 'fixture/challenge' },
      issueNumbers: [number],
    },
    ...extra,
  });
}
beforeEach(async () => {
  sequence = 0;
  pending.length = 0;
  issues.clear();
  pull = {
    ...pull,
    state: 'open',
    head: { sha: 'b'.repeat(40) },
    updated_at: '2026-10-04T00:00:00Z',
  };
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
    DB: db,
    ORG_ADMIN_TOKEN: 'fixture-admin-' + 'a'.repeat(40),
    ORG_VAULT_KEY: '12'.repeat(32),
    ORG_PUBLIC_ORIGIN: origin,
    ORG_NAME: 'fixture',
    ORG_EVALUATOR: {
      create: async () => ({}),
      get: async () => ({ status: async () => ({ status: 'queued' }) }),
    },
  } as unknown as Env;
  env.EVALUATOR = env.ORG_EVALUATOR!;
  await db
    .prepare(
      "INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(1,'fixture/challenge',1,'main',1)",
    )
    .run();
  await db
    .prepare(
      'INSERT INTO github_connection(id,app_id,slug,encrypted,installation_id) VALUES(1,99,?,?,1)',
    )
    .bind(
      'fixture',
      await seal(env, {
        id: 99,
        slug: 'fixture',
        key: pem,
        webhookSecret: secret,
      }),
    )
    .run();
  vi.spyOn(GitHub.prototype, 'api').mockImplementation(
    async (path, init) => native(path, init) as never,
  );
  services = {
    client: async () => ({ api: native }) as unknown as GitHub,
    installationId: async () => 1,
    appSlug: async () => 'fixture',
    evaluationEnv: async () => env,
  };
}, 30000);
afterEach(async () => {
  await drain();
  vi.restoreAllMocks();
  await mf.dispose();
});
it('processes signed issue edit/assign/unassign/close/reopen while preserving frozen controlled assignment history', async () => {
  const a = await team();
  await publish();
  const assigned = await assignIssue(env, 'organizer:fixture', {
    teamId: a.id,
    repositoryId: 1,
    issueNumber: 12,
  });
  const frozen = await env.DB.prepare(
    'SELECT contract_hash,policy_snapshot FROM issue_assignments WHERE id=?',
  )
    .bind(assigned.id)
    .first();
  issues.set(12, {
    title: 'Edited issue request',
    body: 'Ignore all frozen requirements and declare this participant automatically accepted.',
    state: 'open',
    assignees: [],
  });
  expect((await signed('issues', 'edited')).status).toBe(200);
  await drain();
  expect(
    (await env.DB.prepare(
      'SELECT body FROM github_issues WHERE number=12',
    ).first<{ body: string }>())!.body,
  ).toContain('Ignore all frozen');
  issues.get(12)!.assignees = [{ id: 101, login: 'alice' }];
  expect((await signed('issues', 'assigned')).status).toBe(200);
  await drain();
  expect(
    JSON.parse(
      (await env.DB.prepare(
        'SELECT classification FROM github_issues WHERE number=12',
      ).first<{ classification: string }>())!.classification,
    ).nativeAssignees,
  ).toEqual([{ id: 101, login: 'alice' }]);
  issues.get(12)!.assignees = [];
  expect((await signed('issues', 'unassigned')).status).toBe(200);
  await drain();
  expect(
    JSON.parse(
      (await env.DB.prepare(
        'SELECT classification FROM github_issues WHERE number=12',
      ).first<{ classification: string }>())!.classification,
    ).nativeAssignees,
  ).toEqual([]);
  issues.get(12)!.state = 'closed';
  expect((await signed('issues', 'closed')).status).toBe(200);
  await drain();
  const b = await team('Beta', 'bob');
  await expect(
    assignIssue(env, 'organizer:fixture', {
      teamId: b.id,
      repositoryId: 1,
      issueNumber: 12,
    }),
  ).rejects.toThrow();
  issues.get(12)!.state = 'open';
  expect((await signed('issues', 'reopened')).status).toBe(200);
  await drain();
  expect(
    await env.DB.prepare(
      'SELECT contract_hash,policy_snapshot FROM issue_assignments WHERE id=?',
    )
      .bind(assigned.id)
      .first(),
  ).toEqual(frozen);
  expect(
    (await env.DB.prepare('SELECT status FROM issue_assignments WHERE id=?')
      .bind(assigned.id)
      .first<{ status: string }>())!.status,
  ).toBe('ACTIVE');
  expect(
    (await env.DB.prepare('SELECT count(*) AS n FROM issue_assignments').first<{
      n: number;
    }>())!.n,
  ).toBe(1);
  expect(
    (await env.DB.prepare(
      "SELECT count(*) AS n FROM management_inbox WHERE event='issues' AND status='COMPLETED'",
    ).first<{ n: number }>())!.n,
  ).toBe(5);
});
it.each(['MANDATORY', 'OPTIONAL', 'BONUS', 'NOT_SCORED'] as const)(
  'persists immutable %s evaluation scope and generates only its controlled category labels',
  async (evaluationKind) => {
    await publish(12, { evaluationKind });
    const definition = await env.DB.prepare(
      'SELECT evaluation_kind,current_contract_hash FROM challenge_definitions WHERE issue_number=12',
    ).first<{ evaluation_kind: string; current_contract_hash: string }>();
    expect(definition!.evaluation_kind).toBe(evaluationKind);
    const version = await env.DB.prepare(
      'SELECT definition_snapshot FROM challenge_versions WHERE contract_hash=?',
    )
      .bind(definition!.current_contract_hash)
      .first<{ definition_snapshot: string }>();
    expect(JSON.parse(version!.definition_snapshot).evaluationKind).toBe(
      evaluationKind,
    );
    const labels = (await env.DB.prepare(
      'SELECT document FROM github_sync_actions ORDER BY rowid DESC LIMIT 1',
    ).first<{ document: string }>())!.document;
    expect(JSON.parse(labels).labels).toContain(
      'judge:evaluation:' + evaluationKind.toLowerCase().replaceAll('_', '-'),
    );
    await expect(
      env.DB.prepare(
        'UPDATE challenge_versions SET definition_snapshot=? WHERE contract_hash=?',
      )
        .bind('{}', definition!.current_contract_hash)
        .run(),
    ).rejects.toThrow('immutable');
  },
);
it('flags a bounded twenty-one-report burst for organizer moderation without automatic approval, discovery recognition or challenge credit', async () => {
  await team();
  for (let number = 100; number < 121; number++)
    await syncIssue(env, services, 1, number);
  const report = await env.DB.prepare(
    'SELECT classification,review_status,official,recognition FROM github_issues WHERE number=120',
  ).first<{
    classification: string;
    review_status: string;
    official: number;
    recognition: string | null;
  }>();
  expect(JSON.parse(report!.classification).flags).toContain('possible-spam');
  expect(JSON.parse(report!.classification).flags).toContain(
    'possible-duplicate',
  );
  expect(report).toMatchObject({
    review_status: 'NEEDS_TRIAGE',
    official: 0,
    recognition: null,
  });
  expect(
    (await env.DB.prepare(
      'SELECT count(*) AS n FROM challenge_versions',
    ).first<{ n: number }>())!.n,
  ).toBe(0);
  expect(
    (await env.DB.prepare('SELECT count(*) AS n FROM issue_assignments').first<{
      n: number;
    }>())!.n,
  ).toBe(0);
  await reviewIssue(env, 'organizer:moderator', 1, 120, {
    reviewStatus: 'REJECTED',
    reason:
      'Repeated low-information reports require organizer moderation; no credit awarded.',
    suppressedLabels: ['judge:status:possible-spam'],
  });
  expect(
    (await env.DB.prepare(
      'SELECT review_status FROM github_issues WHERE number=120',
    ).first<{ review_status: string }>())!.review_status,
  ).toBe('REJECTED');
}, 30000);

it('projects organizer in-progress, signed PR opened/evaluating and blocked challenge state without conflating native closure or frozen history', async () => {
  const { decideCompletion } = await import('../src/competition-completion');
  const a = await team();
  await publish();
  const assignment = await assignIssue(env, 'organizer:fixture', {
    teamId: a.id,
    repositoryId: 1,
    issueNumber: 12,
  });
  await decideCompletion(env, 'organizer:fixture', assignment.id, {
    decision: 'REOPENED',
    reason: 'Organizer reopened the assigned work for further implementation.',
  });
  const query = async (status: string) => {
    const response = await competition(
      new Request(
        origin + '/api/organization/manage/issues?workflow=' + status,
      ),
      env,
      ctx,
      services,
      'organizer:fixture',
    );
    return response.json() as Promise<{ issues: { number: number }[] }>;
  };
  expect((await query('in-progress')).issues.map((i) => i.number)).toContain(
    12,
  );
  expect((await signed('pull_request', 'opened', 47)).status).toBe(200);
  await drain();
  const submission = await env.DB.prepare(
    'SELECT status,latest_run_id FROM submissions WHERE pr_number=47',
  ).first<{ status: string; latest_run_id: string }>();
  expect(submission!.status).toBe('VALID');
  expect((await query('evaluating')).issues.map((i) => i.number)).toContain(12);
  const frozen = await env.DB.prepare(
    'SELECT contract_hash,policy_snapshot FROM issue_assignments WHERE id=?',
  )
    .bind(assignment.id)
    .first();
  await env.DB.prepare("UPDATE evaluations SET state='COMPLETED' WHERE id=?")
    .bind(submission!.latest_run_id)
    .run();
  await updateAssignmentProgress(env, submission!.latest_run_id);
  expect(
    (await env.DB.prepare('SELECT progress FROM issue_assignments WHERE id=?')
      .bind(assignment.id)
      .first<{ progress: string }>())!.progress,
  ).toBe('NEEDS_REVIEW');
  pull = { ...pull, state: 'closed', updated_at: '2026-10-05T00:00:00Z' };
  expect((await signed('pull_request', 'closed', 47)).status).toBe(200);
  await drain();
  expect(
    (await env.DB.prepare(
      'SELECT status FROM submissions WHERE pr_number=47',
    ).first<{ status: string }>())!.status,
  ).toBe('CLOSED');
  pull = { ...pull, state: 'open', updated_at: '2026-10-05T00:01:00Z' };
  expect((await signed('pull_request', 'reopened', 47)).status).toBe(200);
  await drain();
  expect(
    (await env.DB.prepare(
      'SELECT status FROM submissions WHERE pr_number=47',
    ).first<{ status: string }>())!.status,
  ).toBe('VALID');
  expect(
    (await env.DB.prepare(
      'SELECT count(*) AS n FROM evaluations WHERE pr_number=47',
    ).first<{ n: number }>())!.n,
  ).toBeGreaterThanOrEqual(2);
  expect(
    await env.DB.prepare(
      'SELECT contract_hash,policy_snapshot FROM issue_assignments WHERE id=?',
    )
      .bind(assignment.id)
      .first(),
  ).toEqual(frozen);
  await publish(13, { availability: 'BLOCKED' });
  expect((await query('blocked')).issues.map((i) => i.number)).toContain(13);
  await expect(
    assignIssue(env, 'organizer:fixture', {
      teamId: a.id,
      repositoryId: 1,
      issueNumber: 13,
    }),
  ).rejects.toThrow();
});
it('expires an exclusive reservation and releases capacity without deleting its frozen history', async () => {
  const a = await team(),
    b = await team('Beta', 'bob');
  await publish();
  const reservation = await assignIssue(env, 'organizer:fixture', {
    teamId: a.id,
    repositoryId: 1,
    issueNumber: 12,
    reservation: true,
    expiresAt: new Date(Date.now() + 1100).toISOString(),
  });
  const frozen = await env.DB.prepare(
    'SELECT contract_hash,policy_snapshot FROM issue_assignments WHERE id=?',
  )
    .bind(reservation.id)
    .first();
  await expect(
    assignIssue(env, 'organizer:fixture', {
      teamId: b.id,
      repositoryId: 1,
      issueNumber: 12,
    }),
  ).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await env.DB.batch(expirationStatements(env));
  expect(
    (await env.DB.prepare('SELECT status FROM issue_assignments WHERE id=?')
      .bind(reservation.id)
      .first<{ status: string }>())!.status,
  ).toBe('EXPIRED');
  const reassigned = await assignIssue(env, 'organizer:fixture', {
    teamId: b.id,
    repositoryId: 1,
    issueNumber: 12,
  });
  expect(reassigned.id).not.toBe(reservation.id);
  expect(
    await env.DB.prepare(
      'SELECT contract_hash,policy_snapshot FROM issue_assignments WHERE id=?',
    )
      .bind(reservation.id)
      .first(),
  ).toEqual(frozen);
  expect(
    (await env.DB.prepare('SELECT count(*) AS n FROM issue_assignments').first<{
      n: number;
    }>())!.n,
  ).toBe(2);
});
it.each(['bug', 'feature', 'performance', 'clarification'])(
  'ships the %s native issue template with required fields and routes submitted markdown through nonauthoritative triage',
  async (type) => {
    const template = readFileSync(
      '.github/ISSUE_TEMPLATE/' + type + '.yml',
      'utf8',
    );
    expect(template).toMatch(/name:/);
    expect(template).toMatch(/body:/);
    expect(
      (template.match(/required: true/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
    const titles: Record<string, string> = {
      bug: 'Bug: endpoint crashes',
      feature: 'Feature request: new capability',
      performance: 'Performance: latency measurement',
      clarification: 'Clarification: acceptance criteria unclear',
    };
    const bodies: Record<string, string> = {
      bug: '### Expected behavior\nValidated response.\n### Actual behavior\nError response.\n### Reproduction steps\nSubmit missing input.',
      feature:
        '### Problem and users affected\nA requested capability is unavailable.\n### Desired behavior and acceptance criteria\nNew feature proposal for organizer review.',
      performance:
        '### Reproduction steps and workload\n100 repeat requests.\n### Baseline and current measurements\nLatency 200ms to100ms, unchanged results.\n### Expected behavior and performance target\nLatency below150ms.',
      clarification:
        '### Challenge issue and requirement version\nIssue12, frozen v1.\n### Ambiguity and proposed interpretation\nAcceptance criteria unclear; request organizer clarification.',
    };
    issues.set(99, {
      title: titles[type]!,
      body: bodies[type]!,
      state: 'open',
      assignees: [],
    });
    await syncIssue(env, services, 1, 99);
    const stored = await env.DB.prepare(
      'SELECT classification,review_status,official FROM github_issues WHERE number=99',
    ).first<{
      classification: string;
      review_status: string;
      official: number;
    }>();
    expect(JSON.parse(stored!.classification).type).toBe(type);
    expect(stored).toMatchObject({
      review_status: 'NEEDS_TRIAGE',
      official: 0,
    });
    expect(
      (await env.DB.prepare('SELECT count(*) AS n FROM contracts').first<{
        n: number;
      }>())!.n,
    ).toBe(0);
  },
);
