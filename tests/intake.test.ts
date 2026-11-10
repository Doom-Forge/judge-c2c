import { migrate } from './database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from './miniflare';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { webhook } from '../src/intake';
import { api } from '../src/api';
import { canonical, digest } from '../src/domain';
import { demoContract } from '../src/demo';
import type { Env } from '../src/env';
import { reconcile } from '../src/store';

let mf: Miniflare, env: Env;
const jobs = new Map<string, unknown>();
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil(p: Promise<unknown>) {
    pending.push(p);
  },
  passThroughOnException() {},
} as ExecutionContext;
const secret = 's'.repeat(40),
  admin = 'a'.repeat(40);
async function signed(
  head = 'b'.repeat(40),
  delivery = crypto.randomUUID(),
  updated = '2026-10-01T12:00:00Z',
  overrides: Record<string, unknown> = {},
) {
  const payload = {
    action: 'opened',
    installation: { id: 1 },
    repository: { id: 1, full_name: 'hackathon/CampaignOS' },
    pull_request: {
      number: 24,
      head: { sha: head },
      base: { repo: { id: 1 } },
      updated_at: updated,
      state: 'open',
    },
    ...overrides,
  };
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig =
    'sha256=' +
    Buffer.from(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
    ).toString('hex');
  return new Request('https://test/webhooks/github', {
    method: 'POST',
    body,
    headers: {
      'x-hub-signature-256': sig,
      'x-github-delivery': delivery,
      'x-github-event': 'pull_request',
    },
  });
}
async function register() {
  const contract = await api(
    new Request('https://test/api/contracts', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + admin },
      body: canonical(demoContract),
    }),
    env,
  );
  expect(contract.status).toBe(201);
  const assignment = await api(
    new Request('https://test/api/assignments', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + admin },
      body: JSON.stringify({
        repositoryId: 1,
        prNumber: 24,
        teamId: 'northstar',
        teamName: 'Northstar',
        issueNumbers: [12],
      }),
    }),
    env,
  );
  expect(assignment.status).toBe(201);
}
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    compatibilityDate: '2026-08-01',
  });
  const DB = await mf.getD1Database('DB');
  await migrate(DB as unknown as D1Database);
  env = {
    DB: DB as unknown as D1Database,
    ENVIRONMENT: 'local',
    ADMIN_TOKEN: admin,
    GITHUB_WEBHOOK_SECRET: secret,
    EVALUATOR: {
      async create(input: { id: string }) {
        if (jobs.has(input.id)) throw new Error('exists');
        jobs.set(input.id, input);
        return {};
      },
      async get(id: string) {
        if (!jobs.has(id)) throw new Error('missing');
        return {
          async status() {
            return { status: 'queued' };
          },
        };
      },
    } as unknown as Env['EVALUATOR'],
    ASSETS: {} as Fetcher,
  };
  await register();
}, 30000);
afterAll(async () => {
  await Promise.allSettled(pending);
  await mf?.dispose();
});
describe('signed GitHub delivery to real D1', () => {
  it('fails closed for forged events, unknown installation and unmapped PRs', async () => {
    const request = await signed();
    request.headers.set('x-hub-signature-256', 'sha256=' + '0'.repeat(64));
    expect((await webhook(request, env, ctx)).status).toBe(401);
    expect(
      (
        await webhook(
          await signed(undefined, undefined, undefined, {
            installation: { id: 2 },
          }),
          env,
          ctx,
        )
      ).status,
    ).toBe(403);
    const bad = await signed(undefined, undefined, undefined, {
      pull_request: {
        number: 25,
        head: { sha: 'b'.repeat(40) },
        base: { repo: { id: 1 } },
        updated_at: '2026-10-01T12:00:00Z',
        state: 'open',
      },
    });
    expect((await webhook(bad, env, ctx)).status).toBe(422);
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM evaluations').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });
  it('deduplicates delivery replay and different deliveries for the same input', async () => {
    const delivery = crypto.randomUUID();
    const first = await webhook(await signed(undefined, delivery), env, ctx);
    expect(first.status).toBe(202);
    expect(
      (await webhook(await signed(undefined, delivery), env, ctx)).status,
    ).toBe(200);
    expect((await webhook(await signed(), env, ctx)).status).toBe(202);
    await Promise.all(pending);
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM evaluations').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    expect(jobs.size).toBe(1);
    expect(
      (await webhook(await signed('c'.repeat(40), delivery), env, ctx)).status,
    ).toBe(409);
  });
  it('retains old input snapshots and supersedes obsolete queued work', async () => {
    await webhook(
      await signed('c'.repeat(40), undefined, '2026-10-01T12:01:00Z'),
      env,
      ctx,
    );
    const rows = await env.DB.prepare(
      'SELECT * FROM evaluations ORDER BY head_sha',
    ).all<{
      state: string;
      head_sha: string;
      contract_snapshot: string;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]?.state).toBe('SUPERSEDED');
    expect(rows.results[1]?.state).toBe('QUEUED');
    await expect(
      env.DB.prepare('UPDATE evaluations SET head_sha=?')
        .bind('d'.repeat(40))
        .run(),
    ).rejects.toThrow('immutable');
    const hash = await digest(canonical(demoContract));
    await expect(
      env.DB.prepare('UPDATE contracts SET document=? WHERE hash=?')
        .bind('{}', hash)
        .run(),
    ).rejects.toThrow('immutable');
  });
  it('does not let delayed old events replace the latest head', async () => {
    await webhook(
      await signed('d'.repeat(40), undefined, '2026-10-01T11:00:00Z'),
      env,
      ctx,
    );
    expect(
      (
        await env.DB.prepare('SELECT head_sha FROM submissions').first<{
          head_sha: string;
        }>()
      )?.head_sha,
    ).toBe('c'.repeat(40));
    expect(
      (
        await env.DB.prepare('SELECT state FROM evaluations WHERE head_sha=?')
          .bind('d'.repeat(40))
          .first<{ state: string }>()
      )?.state,
    ).toBe('SUPERSEDED');
  });
  it('reconciles durable outbox work after dispatch failure', async () => {
    const real = env.EVALUATOR;
    env.EVALUATOR = {
      create: async () => {
        throw new Error('unavailable');
      },
      get: async () => {
        throw new Error('unavailable');
      },
    } as unknown as Env['EVALUATOR'];
    await webhook(
      await signed('e'.repeat(40), undefined, '2026-10-01T12:02:00Z'),
      env,
      ctx,
    );
    await Promise.allSettled(pending);
    expect(
      (await env.DB.prepare(
        'SELECT count(*) AS n FROM outbox WHERE dispatched_at IS NULL',
      ).first<{
        n: number;
      }>())!.n,
    ).toBeGreaterThan(0);
    env.EVALUATOR = real;
    await reconcile(env);
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM outbox o JOIN evaluations e ON e.id=o.run_id WHERE dispatched_at IS NULL AND e.state='QUEUED'",
      ).first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it('tracks token outages and rotates terminal publication recovery fairly', async () => {
    const { GitHub } = await import('../src/github');
    const { publish } = await import('../src/github-checks');
    const { getRun } = await import('../src/store');
    await env.DB.prepare(
      "UPDATE evaluations SET state='SUPERSEDED',publication_status='PENDING',publication_attempted_at=NULL",
    ).run();
    const ids = (
      await env.DB.prepare(
        'SELECT id FROM evaluations ORDER BY id LIMIT 3',
      ).all<{ id: string }>()
    ).results;
    expect(ids).toHaveLength(3);
    const unavailable = vi
      .spyOn(GitHub, 'installation')
      .mockRejectedValue(Error('TOKEN_UNAVAILABLE'));
    try {
      await expect(
        publish(env, (await getRun(env, ids[0]!.id))!),
      ).rejects.toThrow('TOKEN_UNAVAILABLE');
      expect((await getRun(env, ids[0]!.id))!.publication_status).toBe(
        'FAILED',
      );
      await reconcile(env);
      const first = (await env.DB.prepare(
        'SELECT count(*) AS n FROM evaluations WHERE publication_attempted_at IS NOT NULL',
      ).first<{ n: number }>())!.n;
      await reconcile(env);
      const second = (await env.DB.prepare(
        'SELECT count(*) AS n FROM evaluations WHERE publication_attempted_at IS NOT NULL',
      ).first<{ n: number }>())!.n;
      expect(first).toBeGreaterThanOrEqual(3);
      expect(second).toBeGreaterThanOrEqual(first);
    } finally {
      unavailable.mockRestore();
    }
  });
  it('retries completed runs with failed AI as new attempts while preserving historical evidence', async () => {
    const current = await env.DB.prepare(
      'SELECT latest_run_id FROM submissions WHERE repository_id=1 AND pr_number=24',
    ).first<{ latest_run_id: string }>();
    const id = current!.latest_run_id;
    await env.DB.prepare(
      "UPDATE evaluations SET state='COMPLETED',ai_status='FAILED',evidence='[]' WHERE id=?",
    )
      .bind(id)
      .run();
    const response = await api(
      new Request('https://test/api/evaluations/' + id + '/retry', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + admin },
      }),
      env,
    );
    expect(response.status).toBe(202);
    const result = (await response.json()) as { runId: string };
    expect(result.runId).not.toBe(id);
    expect(
      await env.DB.prepare(
        'SELECT state,ai_status,evidence FROM evaluations WHERE id=?',
      )
        .bind(id)
        .first(),
    ).toMatchObject({
      state: 'COMPLETED',
      ai_status: 'FAILED',
      evidence: '[]',
    });
    expect(
      await env.DB.prepare(
        'SELECT latest_run_id FROM submissions WHERE repository_id=1 AND pr_number=24',
      ).first(),
    ).toMatchObject({ latest_run_id: result.runId });
    await env.DB.prepare(
      "UPDATE evaluations SET state='COMPLETED',ai_status='FAILED' WHERE id=?",
    )
      .bind(result.runId)
      .run();
    await env.DB.prepare(
      "UPDATE hackathons SET status='PAUSED' WHERE id='initial'",
    ).run();
    expect(
      (
        await api(
          new Request(
            'https://test/api/evaluations/' + result.runId + '/retry',
            { method: 'POST', headers: { authorization: 'Bearer ' + admin } },
          ),
          env,
        )
      ).status,
    ).toBe(409);
    await env.DB.prepare(
      "UPDATE hackathons SET status='ACTIVE' WHERE id='initial'",
    ).run();
    const concurrent = await Promise.all(
      [1, 2].map(() =>
        api(
          new Request(
            'https://test/api/evaluations/' + result.runId + '/retry',
            { method: 'POST', headers: { authorization: 'Bearer ' + admin } },
          ),
          env,
        ),
      ),
    );
    expect(concurrent.map((r) => r.status).sort()).toEqual([202, 409]);
    for (const response of concurrent.filter((r) => r.status === 202)) {
      const body = (await response.json()) as { runId: string };
      expect(
        await env.DB.prepare('SELECT id FROM evaluations WHERE id=?')
          .bind(body.runId)
          .first(),
      ).toBeTruthy();
    }
  });
  it('exposes evidence only with admin authorization and disables review writes', async () => {
    expect(
      (await api(new Request('https://test/api/overview'), env)).status,
    ).toBe(401);
    const response = await api(
      new Request('https://test/api/overview', {
        headers: { authorization: 'Bearer ' + admin },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { runs: unknown[] }).runs.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await api(
          new Request('https://test/api/contracts', {
            method: 'POST',
            body: '{}',
          }),
          {
            ...env,
            DEMO_MODE: 'true',
          },
        )
      ).status,
    ).toBe(403);
  });
  it('creates a fresh auditable run when a closed PR reopens at the same commit', async () => {
    const head = 'e'.repeat(40);
    const request = await signed(head, undefined, '2026-10-01T12:03:00Z', {
      action: 'closed',
      pull_request: {
        number: 24,
        head: { sha: head },
        base: { repo: { id: 1 } },
        updated_at: '2026-10-01T12:03:00Z',
        state: 'closed',
      },
    });
    expect((await webhook(request, env, ctx)).status).toBe(200);
    expect(
      (
        await env.DB.prepare('SELECT closed FROM submissions').first<{
          closed: number;
        }>()
      )?.closed,
    ).toBe(1);
    const reopened = await webhook(
      await signed(head, undefined, '2026-10-01T12:04:00Z', {
        action: 'reopened',
      }),
      env,
      ctx,
    );
    const result = (await reopened.json()) as { runId: string };
    expect(reopened.status).toBe(202);
    expect(
      (
        await env.DB.prepare('SELECT state FROM evaluations WHERE id=?')
          .bind(result.runId)
          .first<{ state: string }>()
      )?.state,
    ).toBe('QUEUED');
    const repeated = await webhook(
      await signed(head, undefined, '2026-10-01T12:04:00Z', {
        action: 'reopened',
      }),
      env,
      ctx,
    );
    expect(((await repeated.json()) as { runId: string }).runId).toBe(
      result.runId,
    );
  });
  it('pins each PR to its contract when another challenge becomes active', async () => {
    await register();
    const original = await digest(canonical(demoContract));
    const second = {
      ...demoContract,
      issueNumbers: [13],
      baseline: 'c'.repeat(40),
    };
    const registered = await api(
      new Request('https://test/api/contracts', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + admin },
        body: canonical(second),
      }),
      env,
    );
    expect(registered.status).toBe(201);
    const hash = ((await registered.json()) as { hash: string }).hash;
    expect(
      (
        await api(
          new Request('https://test/api/assignments', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + admin },
            body: canonical({
              repositoryId: 1,
              prNumber: 25,
              teamId: 'second',
              teamName: 'Second',
              issueNumbers: [13],
              contractHash: hash,
            }),
          }),
          env,
        )
      ).status,
    ).toBe(201);
    const result = await webhook(
      await signed('d'.repeat(40), undefined, '2026-10-01T12:05:00Z'),
      env,
      ctx,
    );
    expect(result.status).toBe(202);
    const runId = ((await result.json()) as { runId: string }).runId;
    const run = await env.DB.prepare(
      'SELECT contract_hash,baseline_sha FROM evaluations WHERE id=?',
    )
      .bind(runId)
      .first<{ contract_hash: string; baseline_sha: string }>();
    expect(run?.contract_hash).toBe(original);
    expect(run?.baseline_sha).toBe(demoContract.baseline);
  });
});

it('does not acknowledge a signed event during database outage and safely retries its delivery', async () => {
  const handler = (await import('../src/index')).default;
  const delivery = crypto.randomUUID();
  const beforeJobs = jobs.size;
  const failing = {
    ...env,
    DB: {
      prepare: () => {
        throw Error('private database credential detail');
      },
    } as unknown as D1Database,
  };
  const request = () =>
    signed('e'.repeat(40), delivery, '2026-10-02T12:01:00Z');
  const failed = await handler.fetch(await request(), failing, ctx);
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain('credential');
  expect(jobs.size).toBe(beforeJobs);
  expect(
    await env.DB.prepare('SELECT id FROM deliveries WHERE id=?')
      .bind(delivery)
      .first(),
  ).toBeNull();
  const recovered = await handler.fetch(await request(), env, ctx);
  expect(recovered.status).toBe(202);
  const retried = await handler.fetch(await request(), env, ctx);
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ status: 'duplicate' });
  expect(
    (await env.DB.prepare('SELECT count(*) AS n FROM deliveries WHERE id=?')
      .bind(delivery)
      .first())!.n,
  ).toBe(1);
});

it('retains twelve submissions and authoritative latest heads during a signed 48-event burst with dispatch outage and recovery', async () => {
  const real = env.EVALUATOR;
  const deferred = vi.spyOn(console, 'error').mockImplementation(() => {});
  env.EVALUATOR = {
    create: async () => {
      throw Error('fixture dispatch outage');
    },
    get: async () => {
      throw Error('fixture dispatch outage');
    },
  } as unknown as Env['EVALUATOR'];
  const originalHash = await digest(canonical(demoContract));
  const deliveries: string[] = [];
  const requests: Promise<Request>[] = [];
  try {
    for (let team = 0; team < 12; team++) {
      const prNumber = 100 + team;
      const assigned = await api(
        new Request('https://test/api/assignments', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + admin },
          body: canonical({
            repositoryId: 1,
            prNumber,
            teamId: 'burst-' + team,
            teamName: 'Burst team ' + team,
            issueNumbers: [12],
            contractHash: originalHash,
          }),
        }),
        env,
      );
      expect(assigned.status).toBe(201);
      // Reverse arrival timestamps model delayed delivery, not GitHub truth changing.
      for (let revision = 3; revision >= 0; revision--) {
        const head = (team * 4 + revision + 100).toString(16).padStart(40, '0');
        const updated = `2026-10-03T12:00:0${revision}Z`;
        const delivery = crypto.randomUUID();
        deliveries.push(delivery);
        requests.push(
          signed(head, delivery, updated, {
            action: 'synchronize',
            pull_request: {
              number: prNumber,
              head: { sha: head },
              base: { repo: { id: 1 } },
              updated_at: updated,
              state: 'open',
            },
          }),
        );
      }
    }
    const responses = await Promise.all(
      (await Promise.all(requests)).map((request) =>
        webhook(request, env, ctx),
      ),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);
    await Promise.allSettled(pending);
    const submissions = (
      await env.DB.prepare(
        'SELECT s.pr_number,s.head_sha,s.latest_run_id,e.state FROM submissions s JOIN evaluations e ON e.id=s.latest_run_id WHERE s.pr_number BETWEEN 100 AND 111 ORDER BY s.pr_number',
      ).all<{
        pr_number: number;
        head_sha: string;
        latest_run_id: string;
        state: string;
      }>()
    ).results;
    expect(submissions).toHaveLength(12);
    for (const submission of submissions) {
      expect(submission.head_sha).toBe(
        ((submission.pr_number - 100) * 4 + 103).toString(16).padStart(40, '0'),
      );
      expect(submission.state).toBe('QUEUED');
    }
    const history = (
      await env.DB.prepare(
        'SELECT state,count(*) AS n FROM evaluations WHERE pr_number BETWEEN 100 AND 111 GROUP BY state',
      ).all<{ state: string; n: number }>()
    ).results;
    expect(history).toEqual(
      expect.arrayContaining([
        { state: 'QUEUED', n: 12 },
        { state: 'SUPERSEDED', n: 36 },
      ]),
    );
    expect(
      (await env.DB.prepare(
        'SELECT count(*) AS n FROM deliveries WHERE id IN (SELECT value FROM json_each(?))',
      )
        .bind(JSON.stringify(deliveries))
        .first<{ n: number }>())!.n,
    ).toBe(48);
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM outbox o JOIN evaluations e ON e.id=o.run_id WHERE e.pr_number BETWEEN 100 AND 111 AND e.state='QUEUED' AND o.dispatched_at IS NULL",
      ).first<{ n: number }>())!.n,
    ).toBe(12);
    env.EVALUATOR = real;
    for (let round = 0; round < 4; round++) await reconcile(env);
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM outbox o JOIN evaluations e ON e.id=o.run_id WHERE e.pr_number BETWEEN 100 AND 111 AND e.state='QUEUED' AND o.dispatched_at IS NULL",
      ).first<{ n: number }>())!.n,
    ).toBe(0);
    const dispatched = await Promise.all(
      submissions.map(async (s) => {
        const workflow = await env.EVALUATOR.get(s.latest_run_id);
        return workflow.status();
      }),
    );
    expect(dispatched.every((status) => status.status === 'queued')).toBe(true);
  } finally {
    env.EVALUATOR = real;
    deferred.mockRestore();
  }
}, 30000);

it('fairly dispatches the oldest five current queued items per recovery sweep, skips obsolete work, and exposes authoritative queue counts', async () => {
  const { competitionOverview } = await import('../src/competition-overview');
  const { acquireReviewer, releaseReviewer } =
    await import('../src/reviewer-capacity');
  const aiSlot = await acquireReviewer(env.DB, 'callmissed');
  expect(aiSlot).not.toBeNull();
  await env.DB.prepare(
    'UPDATE outbox SET dispatched_at=CURRENT_TIMESTAMP',
  ).run();
  const before = await competitionOverview(env.DB);
  const real = env.EVALUATOR;
  const dispatched: string[] = [];
  const expected = new Map<number, string>();
  const originalHash = await digest(canonical(demoContract));
  const deferred = vi.spyOn(console, 'error').mockImplementation(() => {});
  env.EVALUATOR = {
    create: async () => {
      throw Error('fixture outage');
    },
    get: async () => {
      throw Error('fixture outage');
    },
  } as unknown as Env['EVALUATOR'];
  try {
    for (let index = 0; index < 8; index++) {
      const prNumber = 200 + index;
      expect(
        (
          await api(
            new Request('https://test/api/assignments', {
              method: 'POST',
              headers: { authorization: 'Bearer ' + admin },
              body: canonical({
                repositoryId: 1,
                prNumber,
                teamId: 'priority-' + index,
                teamName: 'Priority fixture ' + index,
                issueNumbers: [12],
                contractHash: originalHash,
              }),
            }),
            env,
          )
        ).status,
      ).toBe(201);
      const sha = (index + 200).toString(16).padStart(40, '0'),
        updated = `2026-10-04T12:00:0${index}Z`;
      const response = await webhook(
        await signed(sha, undefined, updated, {
          pull_request: {
            number: prNumber,
            head: { sha },
            base: { repo: { id: 1 } },
            updated_at: updated,
            state: 'open',
          },
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(202);
      const runId = ((await response.json()) as { runId: string }).runId;
      expected.set(prNumber, runId);
      await env.DB.prepare('UPDATE outbox SET created_at=? WHERE run_id=?')
        .bind(updated, runId)
        .run();
    }
    await Promise.allSettled(pending);
    await env.DB.prepare("UPDATE evaluations SET state='SUPERSEDED' WHERE id=?")
      .bind(expected.get(207))
      .run();
    env.EVALUATOR = {
      create: async (input: { id: string }) => {
        dispatched.push(input.id);
        return {};
      },
      get: async () => {
        throw Error('fixture missing');
      },
    } as unknown as Env['EVALUATOR'];
    const metrics = await competitionOverview(env.DB);
    expect(metrics!.queuedRuns).toBe(before!.queuedRuns! + 7);
    expect(metrics!.supersededRuns).toBe(before!.supersededRuns! + 1);
    await reconcile(env);
    expect(dispatched).toHaveLength(5);
    expect(new Set(dispatched)).toEqual(
      new Set([200, 201, 202, 203, 204].map((pr) => expected.get(pr)!)),
    );
    expect(dispatched).not.toContain(expected.get(207));
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM outbox o JOIN evaluations e ON e.id=o.run_id WHERE e.pr_number BETWEEN 200 AND 207 AND e.state='QUEUED' AND o.dispatched_at IS NULL",
      ).first<{ n: number }>())!.n,
    ).toBe(2);
    await reconcile(env);
    expect(dispatched).toHaveLength(7);
    expect(new Set(dispatched).size).toBe(7);
    expect(
      (await env.DB.prepare(
        "SELECT owner FROM reviewer_slots WHERE provider='callmissed'",
      ).first<{ owner: string }>())!.owner,
    ).toBe(aiSlot!.owner);
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM outbox o JOIN evaluations e ON e.id=o.run_id WHERE e.pr_number BETWEEN 200 AND 207 AND e.state='QUEUED' AND o.dispatched_at IS NULL",
      ).first<{ n: number }>())!.n,
    ).toBe(0);
  } finally {
    await releaseReviewer(env.DB, aiSlot!);
    env.EVALUATOR = real;
    deferred.mockRestore();
  }
}, 30000);
