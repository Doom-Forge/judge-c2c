import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import { canonical, digest, type Contract } from '../src/domain';
import { demoContract } from '../src/demo';
import { GitHub } from '../src/github';
import {
  runObjective,
  type RunnerRequest,
  type RunnerResult,
} from '../src/runner';
import { paymentRetryPolicy, RUNNER_VERSION } from '../src/runner-policy';
import type { Env } from '../src/env';

const image = 'registry.cloudflare.com/account/node@sha256:' + 'd'.repeat(64);
const policy = { ...paymentRetryPolicy, image, cache: 'ALL' as const };
const baseContract: Contract = {
  ...demoContract,
  repository: { id: 1, fullName: 'example/project', installationId: 1 },
  baseline: 'b'.repeat(40),
  execution: {
    ...demoContract.execution,
    timeoutSeconds: 60,
    memoryMiB: 256,
    runner: policy,
  },
};

let mf: Miniflare;
let DB: D1Database;
let calls: ReturnType<typeof vi.fn>;
let env: Env;
let source = 'export default 1;';

function completed(request: RunnerRequest): RunnerResult {
  return {
    requestHash: '',
    commit: request.commit,
    contractHash: request.contractHash,
    version: RUNNER_VERSION,
    image: request.policy.image,
    runtime: 'v24.0.0',
    startedAt: '2026-10-02T00:00:00.000Z',
    finishedAt: '2026-10-02T00:00:01.000Z',
    checks: [
      ...request.policy.commands.map((c) => ({
        id: c.id,
        kind: c.kind,
        status: 'PASS' as const,
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
        detail: 'Completed.',
      })),
      ...request.policy.cases.map((c) => ({
        id: c.id,
        kind: 'acceptance' as const,
        status: 'PASS' as const,
        exitCode: null,
        durationMs: 1,
        stdout: '',
        stderr: '',
        detail: 'Verified.',
      })),
      ...(request.policy.benchmarks ?? []).map((b) => ({
        id: b.id,
        kind: 'benchmark' as const,
        status: 'PASS' as const,
        exitCode: null,
        durationMs: 1,
        stdout: '',
        stderr: '',
        detail: 'Measured.',
      })),
    ],
  };
}

let sequence = 0;
async function addRun(head: string, contract: Contract = baseContract) {
  const runId = (++sequence).toString(16).padStart(64, '0');
  const repositoryId = contract.repository.id;
  const contractHash = (repositoryId === 1 ? 'c' : String(repositoryId)).repeat(
    64,
  );
  await DB.prepare(
    'INSERT OR IGNORE INTO repositories(id,full_name,installation_id,active_contract_hash) VALUES(?,?,?,?)',
  )
    .bind(repositoryId, contract.repository.fullName, 1, contractHash)
    .run();
  await DB.prepare(
    'INSERT OR IGNORE INTO contracts(hash,repository_id,document) VALUES(?,?,?)',
  )
    .bind(contractHash, repositoryId, JSON.stringify(contract))
    .run();
  await DB.prepare(
    "INSERT INTO evaluations(id,repository_id,pr_number,head_sha,baseline_sha,contract_hash,contract_snapshot,assignment_snapshot,state) VALUES(?,?,1,?,?,?,?,?,'CHECKING')",
  )
    .bind(
      runId,
      repositoryId,
      head,
      contract.baseline,
      contractHash,
      JSON.stringify(contract),
      '{}',
    )
    .run();
  await DB.prepare(
    'INSERT INTO submissions(repository_id,pr_number,head_sha,latest_run_id,github_updated_at,closed) VALUES(?,1,?,?,?,0) ON CONFLICT(repository_id,pr_number) DO UPDATE SET head_sha=excluded.head_sha,latest_run_id=excluded.latest_run_id,closed=0',
  )
    .bind(repositoryId, head, runId, new Date().toISOString())
    .run();
  return { id: runId, head_sha: head, contract_hash: contractHash };
}

async function execute(head: string, contract: Contract = baseContract) {
  const run = await addRun(head, contract);
  return runObjective(env, run, contract, []);
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-08-01',
  });
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await migrate(DB);
  const runner = {
    async evaluate(request: RunnerRequest) {
      const result = completed(request);
      result.requestHash = await digest(canonical(request));
      return result;
    },
  };
  calls = vi.fn(runner.evaluate);
  runner.evaluate = calls as typeof runner.evaluate;
  env = {
    DB,
    ENVIRONMENT: 'review',
    RUNNER_ENABLED: 'true',
    RUNNER: {
      idFromName: () => 'runner-id',
      get: () => runner,
    } as unknown as DurableObjectNamespace,
    ASSETS: {} as Fetcher,
    EVALUATOR: {} as Workflow<{ runId: string }>,
  };
  vi.spyOn(GitHub, 'installation').mockResolvedValue(new GitHub());
  vi.spyOn(GitHub.prototype, 'api').mockResolvedValue({
    truncated: false,
    tree: [{ path: 'server.mjs', type: 'blob', mode: '100644', size: 32 }],
  });
  vi.spyOn(GitHub.prototype, 'file').mockImplementation(async () => source);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await mf.dispose();
});

describe('execution cache with Miniflare D1', () => {
  it('reuses validated results while retaining their original request and timing', async () => {
    const head = 'a'.repeat(40);
    await execute(head);
    const firstCount = calls.mock.calls.length;
    const first = await DB.prepare(
      'SELECT created_at FROM execution_results ORDER BY rowid LIMIT 1',
    ).first();
    await execute(head);
    expect(calls).toHaveBeenCalledTimes(firstCount);
    const rows = await DB.prepare(
      'SELECT run_id,cache_status,origin_run_id,origin_execution_id,request_hash,result_hash,result,request,created_at FROM execution_results ORDER BY rowid',
    ).all<Record<string, unknown>>();
    const hit = rows.results.find((r) => r.cache_status === 'HIT')!;
    const value = JSON.parse(String(hit.result));
    expect(hit.origin_run_id).toBe(rows.results[0]!.run_id);
    expect(value.startedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(hit.request).toContain('"schemaVersion":1');
    expect(hit.request).not.toContain('export default');
    expect(hit.created_at).toBe(first!.created_at);
  });

  it('invalidates source, runtime policy, environment, resource and repository identity', async () => {
    await execute('d'.repeat(40));
    const initial = calls.mock.calls.length;
    source = 'export default 2;';
    await execute('d'.repeat(40));
    expect(calls.mock.calls.length).toBe(initial + 2);
    source = 'export default 1;';
    const changedPolicy: Contract = {
      ...baseContract,
      execution: { ...baseContract.execution, timeoutSeconds: 61 },
    };
    await execute('d'.repeat(40), changedPolicy);
    expect(calls.mock.calls.length).toBe(initial + 4);
    env.ENVIRONMENT = 'production';
    await execute('d'.repeat(40));
    expect(calls.mock.calls.length).toBe(initial + 6);
    const otherRepo: Contract = {
      ...baseContract,
      repository: { id: 2, fullName: 'other/project', installationId: 2 },
    };
    await execute('d'.repeat(40), otherRepo);
    expect(calls.mock.calls.length).toBe(initial + 8);
  });

  it('treats corrupted cache rows as misses and never caches incomplete or secret-bearing output', async () => {
    const head = 'e'.repeat(40);
    await execute(head);
    await DB.prepare('DROP TRIGGER immutable_execution_cache_update').run();
    await DB.prepare("UPDATE execution_cache SET result='{}'").run();
    const before = calls.mock.calls.length;
    await execute(head);
    expect(calls.mock.calls.length).toBe(before + 2);

    const noncomplete = {
      ...baseContract,
      execution: {
        ...baseContract.execution,
        runner: { ...policy, cache: 'ALL' as const },
      },
    };
    calls.mockImplementation(async (request: RunnerRequest) => {
      const result = completed(request);
      result.requestHash = await digest(canonical(request));
      result.checks[0]!.status = 'UNVERIFIED';
      return result;
    });
    await execute('f'.repeat(40), noncomplete);
    const cacheCount = await DB.prepare(
      'SELECT count(*) AS n FROM execution_cache',
    ).first<{ n: number }>();
    expect(cacheCount!.n).toBeGreaterThan(0);
    calls.mockImplementation(async (request: RunnerRequest) => {
      const result = completed(request);
      result.requestHash = await digest(canonical(request));
      result.checks[0]!.stdout = 'token=ghp_123456789012345678901234567890';
      return result;
    });
    await execute('1'.repeat(40));
    const persisted = await DB.prepare(
      'SELECT result,cache_status FROM execution_results WHERE commit_sha=? ORDER BY rowid DESC LIMIT 1',
    )
      .bind('1'.repeat(40))
      .first<{ result: string; cache_status: string }>();
    expect(persisted!.result).not.toContain('ghp_');
    expect(persisted!.cache_status).toBe('BYPASS');
  });

  it('keeps NONE default behavior and bypasses benchmark policies', async () => {
    const none: Contract = {
      ...baseContract,
      execution: {
        ...baseContract.execution,
        runner: { ...policy, cache: 'NONE' },
      },
    };
    const baselineCalls = calls.mock.calls.length;
    await execute('2'.repeat(40), none);
    await execute('2'.repeat(40), none);
    expect(calls.mock.calls.length).toBe(baselineCalls + 4);
    const benchmark: Contract = {
      ...baseContract,
      execution: {
        ...baseContract.execution,
        runner: {
          ...policy,
          benchmarks: [
            {
              id: 'bench',
              path: '/',
              method: 'GET',
              expectedStatus: 200,
              expectedBody: {},
              samples: 10,
              warmup: 1,
              maxP95Ms: 10,
            },
          ],
        },
      },
    };
    const next = calls.mock.calls.length;
    await execute('3'.repeat(40), benchmark);
    await execute('3'.repeat(40), benchmark);
    expect(calls.mock.calls.length).toBe(next + 4);
  });
});
