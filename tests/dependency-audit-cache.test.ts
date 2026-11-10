import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import { cachedDependencyAudit } from '../src/dependency-audit-cache';
import { digest } from '../src/domain';
import { writeFile } from 'node:fs/promises';

let mf: Miniflare, db: D1Database;
const observations: unknown[] = [];
const input = {
  manifest: '{"dependencies":{"lodash":"4.17.20"}}',
  lock: '{"lockfileVersion":3,"packages":{"":{},"node_modules/lodash":{"version":"4.17.20"}}}',
};
const now = Math.floor(Date.now() / 3600000) * 3600000 + 1000;
const base = {
  repositoryId: 1,
  runId: 'a'.repeat(64),
  baseline: 'b'.repeat(40),
  head: 'c'.repeat(40),
  contractHash: 'd'.repeat(64),
  cache: 'BASELINE' as const,
};
const provider = () =>
  vi.fn(async () =>
    Response.json({
      results: [{ vulns: [{ id: 'GHSA-controlled-fixture' }] }],
    }),
  );
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default{fetch(){return new Response("controlled")}}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-08-01',
  });
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  await migrate(db);
  await db
    .prepare(
      'INSERT INTO repositories(id,full_name,installation_id,active_contract_hash) VALUES(1,?,?,?)',
    )
    .bind('controlled/fixture', 1, base.contractHash)
    .run();
  await db
    .prepare('INSERT INTO contracts(hash,repository_id,document) VALUES(?,?,?)')
    .bind(base.contractHash, 1, '{}')
    .run();
  for (const id of ['a', 'e'])
    await db
      .prepare(
        "INSERT INTO evaluations(id,repository_id,pr_number,head_sha,baseline_sha,contract_hash,state,contract_snapshot,assignment_snapshot) VALUES(?,1,1,?,?,?,'FETCHING','{}','{}')",
      )
      .bind(id.repeat(64), base.head, base.baseline, base.contractHash)
      .run();
});
afterAll(async () => {
  await writeFile(
    'docs/qa/dependency-audit-cache-controlled-evidence.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode: 'REAL_MINIFLARE_D1_CONTROLLED_ADVISORY_RESPONSE',
        synthetic: true,
        validation:
          observations.length === 5
            ? 'CONTROLLED_CASES_VALIDATED'
            : 'UNVERIFIED',
        liveOSV: 'UNVERIFIED; no external provider requests were made.',
        observations,
      },
      null,
      2,
    ) + '\n',
  );
  await mf?.dispose();
});
describe('immutable bounded advisory snapshot reuse in real D1', () => {
  it('records MISS then HIT with immutable origin and historical-query disclosure', async () => {
    const fetcher = provider();
    const first = await cachedDependencyAudit(
      db,
      base,
      input,
      input,
      fetcher,
      now,
    );
    const hit = await cachedDependencyAudit(
      db,
      { ...base, runId: 'e'.repeat(64) },
      input,
      input,
      fetcher,
      now + 1000,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.at(-1)?.claim).toContain('snapshot MISS');
    expect(hit.at(-1)?.claim).toContain('snapshot HIT');
    expect(hit.at(-1)?.claim).toContain('origin run ' + base.runId);
    expect(hit.at(-1)?.claim).toContain('not a fresh provider scan');
    expect(hit[0]).toMatchObject({ status: 'FAIL', baselineStatus: 'FAIL' });
    const stored = await db
      .prepare('SELECT * FROM dependency_audit_cache')
      .all();
    expect(stored.results).toHaveLength(1);
    await expect(
      db
        .prepare('UPDATE dependency_audit_cache SET expires_at=expires_at+1')
        .run(),
    ).rejects.toThrow(/immutable/);
    observations.push({
      case: 'MISS_TO_HIT',
      providerRequests: fetcher.mock.calls.length,
      first,
      hit,
      stored: stored.results,
    });
  });
  it('invalidates hourly snapshots while preserving prior immutable history', async () => {
    const fetcher = provider();
    const fresh = await cachedDependencyAudit(
      db,
      base,
      input,
      input,
      fetcher,
      now + 3600000,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fresh.at(-1)?.claim).toContain('snapshot MISS');
    expect(
      (await db.prepare('SELECT * FROM dependency_audit_cache').all()).results,
    ).toHaveLength(2);
    observations.push({ case: 'EXPIRY_REQUERY', fresh });
  });
  it('ignores corrupt snapshots and retains useful fresh evidence on cache write failure', async () => {
    await db
      .prepare('DROP TRIGGER immutable_dependency_audit_cache_update')
      .run();
    await db
      .prepare(
        "UPDATE dependency_audit_cache SET result='[]' WHERE queried_at=?",
      )
      .bind(now)
      .run();
    const fetcher = provider();
    const fresh = await cachedDependencyAudit(
      db,
      base,
      input,
      input,
      fetcher,
      now + 2000,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fresh.at(-1)?.status).toBe('PASS');
    expect(fresh.at(-1)?.claim).toContain('snapshot MISS');
    observations.push({ case: 'CORRUPTION_BYPASS', fresh });
  });
  it('does not cache incomplete/provider failures or bypass explicit NONE/BASELINE semantics', async () => {
    const altered = { ...input, manifest: input.manifest + ' ' };
    const before = (await db
      .prepare('SELECT count(*) AS n FROM dependency_audit_cache')
      .first<{ n: number }>())!.n;
    const failed = await cachedDependencyAudit(
      db,
      { ...base, cache: 'ALL' },
      altered,
      altered,
      async () => new Response('unavailable', { status: 503 }),
      now,
    );
    expect(failed[0]?.status).toBe('UNVERIFIED');
    const incomplete = await cachedDependencyAudit(
      db,
      { ...base, cache: 'ALL' },
      altered,
      altered,
      async () =>
        Response.json({ results: [{ vulns: [], next_page_token: 'more' }] }),
      now,
    );
    expect(incomplete[0]?.status).toBe('UNVERIFIED');
    const fetcher = provider();
    for (let i = 0; i < 2; i++)
      await cachedDependencyAudit(
        db,
        { ...base, cache: 'NONE' },
        input,
        input,
        fetcher,
        now,
      );
    expect(fetcher).toHaveBeenCalledTimes(2);
    await cachedDependencyAudit(db, base, input, altered, fetcher, now);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      (await db
        .prepare('SELECT count(*) AS n FROM dependency_audit_cache')
        .first<{ n: number }>())!.n,
    ).toBe(before);
    observations.push({
      case: 'PROVIDER_FAILURE_INCOMPLETE_AND_OPT_IN',
      failed,
      incomplete,
      cacheCount: before,
    });
  });
  it('isolates exact lock/config identities and rejects forged snapshot origin scope', async () => {
    const fetcher = provider();
    const changed = { ...input, lock: input.lock + ' ' };
    const fresh = await cachedDependencyAudit(
      db,
      { ...base, cache: 'ALL' },
      changed,
      changed,
      fetcher,
      now,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await db
      .prepare(
        "INSERT INTO evaluations(id,repository_id,pr_number,head_sha,baseline_sha,contract_hash,state,contract_snapshot,assignment_snapshot) VALUES(?,1,1,?,?,?,'FETCHING','{}','{}')",
      )
      .bind('f'.repeat(64), 'f'.repeat(40), base.baseline, base.contractHash)
      .run();
    const current = await db
      .prepare(
        'SELECT cache_key FROM dependency_audit_cache ORDER BY rowid DESC LIMIT 1',
      )
      .first<{ cache_key: string }>();
    await db
      .prepare(
        'UPDATE dependency_audit_cache SET origin_run_id=? WHERE cache_key=?',
      )
      .bind('f'.repeat(64), current!.cache_key)
      .run();
    const rejected = await cachedDependencyAudit(
      db,
      { ...base, cache: 'ALL' },
      changed,
      changed,
      fetcher,
      now + 1000,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(rejected.at(-1)?.claim).toContain('snapshot MISS');
    observations.push({ case: 'EXACT_LOCK_CHANGE', fresh });
  });
});
