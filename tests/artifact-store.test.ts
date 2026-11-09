import { api } from '../src/api';
import { organization } from '../src/organization';
import { digest } from '../src/domain';
import { assessExpectedArtifacts } from '../src/expected-artifacts';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  storeArtifact,
  readArtifact,
  expireArtifacts,
  captureRunArtifacts,
  MAX_ARTIFACT_BYTES,
} from '../src/artifact-store';
import type { Env } from '../src/env';
const id = 'a'.repeat(64);
function fixture() {
  // SQLite adapter verifies actual SQL/constraints without requiring a local port.
  const sql = new DatabaseSync(':memory:');
  sql.exec(
    'CREATE TABLE evaluations(id TEXT PRIMARY KEY,evidence TEXT,context TEXT,report TEXT,baseline_sha TEXT); CREATE TABLE execution_results(run_id TEXT,commit_sha TEXT,result TEXT,created_at TEXT); CREATE TABLE artifacts(key TEXT PRIMARY KEY,run_id TEXT REFERENCES evaluations(id),sha256 TEXT,bytes INTEGER,content_type TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);',
  );
  sql.exec(readFileSync('migrations/0012_artifact_store.sql', 'utf8'));
  sql.exec('CREATE TABLE github_repositories(id INTEGER PRIMARY KEY)');
  sql.exec('CREATE TABLE teams(id TEXT PRIMARY KEY,status TEXT NOT NULL)');
  sql.exec(
    'CREATE TABLE team_members(id TEXT PRIMARY KEY,team_id TEXT,active INTEGER);',
  );
  // Minimal parity for the participant identity eligibility query. This file
  // intentionally uses a small in-memory schema instead of the D1 migrations.
  sql.exec(
    'CREATE TABLE team_roster_members(id TEXT PRIMARY KEY,team_id TEXT,linked_team_member_id TEXT,active INTEGER NOT NULL DEFAULT 1);',
  );
  sql.exec(readFileSync('migrations/0018_confidential_security.sql', 'utf8'));
  sql.exec(readFileSync('migrations/0021_console_identities.sql', 'utf8'));
  sql.exec(
    'ALTER TABLE console_identities ADD COLUMN team_member_id TEXT; ALTER TABLE console_identities ADD COLUMN team_roster_member_id TEXT;',
  );
  sql
    .prepare('INSERT INTO evaluations(id,baseline_sha) VALUES(?,?)')
    .run(id, 'base');
  const DB = {
    prepare(query: string) {
      let values: any[] = [];
      const stmt = {
        bind(...v: any[]) {
          values = v;
          return stmt;
        },
        async run() {
          const r = sql.prepare(query).run(...values);
          return { meta: { changes: Number(r.changes) } };
        },
        async first() {
          return sql.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...values) };
        },
      };
      return stmt;
    },
  };
  const objects = new Map<string, string>();
  const kv = {
    put: vi.fn(async (key: string, value: string) => {
      objects.set(key, value);
    }),
    get: vi.fn(async (key: string) =>
      objects.has(key)
        ? new TextEncoder().encode(objects.get(key)!).buffer
        : null,
    ),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
  return { env: { DB, ARTIFACT_KV: kv } as unknown as Env, sql, objects, kv };
}
afterEach(() => vi.restoreAllMocks());
describe('protected artifacts with real SQLite policy', () => {
  it('stores inspectable check reports and incomplete diff data without inventing missing outputs', async () => {
    const f = fixture();
    const check = (id: string, kind: string, stdout = '') => ({
      id,
      kind,
      status: 'PASS',
      exitCode: 0,
      durationMs: 10,
      stdout,
      stderr: '',
      detail: 'Synthetic observed check',
    });
    const checks = [
      check('tests', 'test', 'TAP version 13\nok 1'),
      check('coverage-empty', 'coverage'),
      check('scan', 'security', 'No configured scan findings'),
      {
        ...check(
          'latency',
          'benchmark',
          JSON.stringify({
            protocol: 'http-latency-v1',
            samplesMs: Array(10).fill(1),
            p95Ms: 1,
          }),
        ),
        exitCode: null,
      },
      {
        ...check('unrun-coverage', 'coverage', 'stale output'),
        status: 'UNVERIFIED',
        exitCode: null,
      },
    ];
    f.sql.prepare('UPDATE evaluations SET context=? WHERE id=?').run(
      JSON.stringify({
        files: [
          {
            filename: 'server.mjs',
            status: 'modified',
            patch: '@@\n+example',
            patchTruncated: true,
          },
        ],
      }),
      id,
    );
    f.sql
      .prepare('INSERT INTO execution_results VALUES(?,?,?,?)')
      .run(
        id,
        'head',
        JSON.stringify({ commit: 'head', requestHash: 'fixture', checks }),
        'now',
      );
    const captured = await captureRunArtifacts(f.env, id);
    expect(captured.status).toBe('CAPTURED');
    for (const kind of [
      'tests-submission-0-0',
      'security-submission-0-2',
      'benchmark-submission-0-3',
    ]) {
      const artifact = captured.artifacts.find((a) => a.kind === kind)!;
      expect(artifact.status).toBe('STORED');
      const response = await readArtifact(f.env, artifact.key);
      expect(response.status).toBe(200);
      const report = JSON.parse(await response.text());
      expect(report.runId).toBe(id);
      expect(report.side).toBe('submission');
      expect(report.check.status).toBe('PASS');
      expect(response.headers.get('x-artifact-sha256')).toBe(artifact.sha256);
    }
    expect(captured.artifacts.some((a) => a.kind.startsWith('coverage-'))).toBe(
      false,
    );
    expect(
      captured.artifacts.some((a) => a.kind === 'check-submission-0-4'),
    ).toBe(true);
    const diff = captured.artifacts.find((a) => a.kind === 'diff')!;
    expect(
      JSON.parse(await (await readArtifact(f.env, diff.key)).text()),
    ).toMatchObject({
      complete: false,
      files: [{ filename: 'server.mjs', patchTruncated: true }],
    });
    const availability = assessExpectedArtifacts(
      {
        expectedArtifacts: [
          { id: 'tests', kind: 'tests', required: true },
          { id: 'coverage', kind: 'coverage', required: true },
        ],
      },
      captured.artifacts,
    );
    expect(availability.map((a) => a.status)).toEqual(['PASS', 'UNVERIFIED']);
  });
  it('retains actual coverage output and keeps incomplete/unrun benchmarks diagnostic', async () => {
    const f = fixture();
    const base = {
      status: 'PASS',
      exitCode: 0,
      durationMs: 1,
      stdout: '',
      stderr: '',
      detail: 'Fixture',
    };
    const checks = [
      {
        ...base,
        id: 'coverage',
        kind: 'coverage',
        stdout: 'File | % Stmts\nserver.mjs | 75',
      },
      {
        ...base,
        id: 'incomplete',
        kind: 'benchmark',
        status: 'FAIL',
        exitCode: null,
        stdout: JSON.stringify({
          protocol: 'http-latency-v1',
          samplesMs: [1],
          p95Ms: null,
        }),
      },
    ];
    f.sql
      .prepare('INSERT INTO execution_results VALUES(?,?,?,?)')
      .run(id, 'head', JSON.stringify({ checks }), 'now');
    const result = await captureRunArtifacts(f.env, id);
    const row = result.artifacts.find(
      (a) => a.kind === 'coverage-submission-0-0',
    )!;
    const report = JSON.parse(
      await (await readArtifact(f.env, row.key)).text(),
    );
    expect(report.check.stdout).toContain('75');
    expect(report.scope).toContain(
      'no coverage percentage or adequacy is inferred',
    );
    expect(result.artifacts.some((a) => a.kind.startsWith('benchmark-'))).toBe(
      false,
    );
    expect(
      result.artifacts.some((a) => a.kind === 'check-submission-0-1'),
    ).toBe(true);
  });
  it('stores redacted immutable bytes and downloads only integrity-checked attachments', async () => {
    const f = fixture();
    const row = await storeArtifact(
      f.env,
      id,
      'stdout',
      'safe output',
      'text/plain',
    );
    const response = await readArtifact(f.env, row.key);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('safe output');
    expect(response.headers.get('x-artifact-sha256')).toBe(row.sha256);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    const same = await storeArtifact(f.env, id, 'stdout', 'safe output');
    expect(same.expires_at).toBe(row.expires_at);
    expect(f.kv.put).toHaveBeenCalledTimes(1);
    expect(() =>
      f.sql.prepare('UPDATE artifacts SET expires_at=0').run(),
    ).toThrow(/immutable/);
    f.objects.set(row.key, 'corrupted');
    expect((await readArtifact(f.env, row.key)).status).toBe(502);
  });
  it('reports eventual visibility and storage failures honestly, retrying bounded attempts', async () => {
    const f = fixture();
    f.kv.put.mockRejectedValueOnce(Error('provider secret must not leak'));
    await expect(storeArtifact(f.env, id, 'report', 'data')).rejects.toThrow(
      'ARTIFACT_UPLOAD_FAILED',
    );
    const row = await storeArtifact(f.env, id, 'report', 'data');
    expect(row.attempts).toBe(2);
    f.objects.clear();
    expect((await readArtifact(f.env, row.key)).status).toBe(503);
    expect((await readArtifact(f.env, 'unknown')).status).toBe(404);
    expect(
      JSON.stringify(f.sql.prepare('SELECT * FROM artifact_attempts').all()),
    ).not.toContain('provider secret');
  });
  it('recovers a crashed upload lease without extending retention', async () => {
    const f = fixture();
    f.kv.put.mockRejectedValueOnce(Error('outage'));
    await expect(storeArtifact(f.env, id, 'report', 'data')).rejects.toThrow();
    const original = f.sql.prepare('SELECT * FROM artifacts').get()!;
    f.sql
      .prepare(
        "UPDATE artifacts SET status='PENDING',upload_token='dead-worker',upload_lease_until=?,error_code='UPLOAD_IN_PROGRESS'",
      )
      .run(Date.now() - 1);
    const recovered = await storeArtifact(f.env, id, 'report', 'data');
    expect(recovered.status).toBe('STORED');
    expect(recovered.expires_at).toBe(original.expires_at);
  });
  it('tombstones expiry and retries failed cleanup without resurrecting objects', async () => {
    const f = fixture();
    const row = await storeArtifact(f.env, id, 'report', 'data');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(row.expires_at! + 1);
    f.kv.delete.mockRejectedValueOnce(Error('outage'));
    await expireArtifacts(f.env);
    expect((await readArtifact(f.env, row.key)).status).toBe(410);
    await expect(storeArtifact(f.env, id, 'report', 'data')).rejects.toThrow(
      'ARTIFACT_EXPIRED',
    );
    await expireArtifacts(f.env);
    expect(f.objects.size).toBe(0);
    expect(f.kv.delete).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });
  it('enforces a lifetime quota including failed objects and per-object bounds', async () => {
    const f = fixture();
    await expect(
      storeArtifact(f.env, id, 'large', 'x'.repeat(MAX_ARTIFACT_BYTES + 1)),
    ).rejects.toThrow('ARTIFACT_LIMIT');
    f.sql
      .prepare(
        "INSERT INTO artifacts(key,run_id,sha256,bytes,content_type,kind,storage,status) VALUES('failed',?,'hash',?,'text/plain','failed','KV','FAILED')",
      )
      .run(id, 20 * 1024 * 1024);
    await expect(storeArtifact(f.env, id, 'report', 'data')).rejects.toThrow(
      'ARTIFACT_RUN_BUDGET',
    );
  });
  it('preserves other captures when execution output is malformed', async () => {
    const f = fixture();
    f.sql
      .prepare('UPDATE evaluations SET evidence=? WHERE id=?')
      .run('[{"status":"PASS"}]', id);
    f.sql
      .prepare('INSERT INTO execution_results VALUES(?,?,?,?)')
      .run(id, 'base', 'not-json', 'now');
    const result = await captureRunArtifacts(f.env, id);
    expect(result.status).toBe('PARTIAL');
    expect(result.failures[0]?.code).toBe('ARTIFACT_EXECUTION_MALFORMED');
    expect(
      result.artifacts.some(
        (a) => a.kind === 'evidence' && a.status === 'STORED',
      ),
    ).toBe(true);
  });
  it('retries cleanup after a crash immediately following the durable tombstone', async () => {
    const f = fixture();
    const row = await storeArtifact(f.env, id, 'report', 'data');
    vi.spyOn(Date, 'now').mockReturnValue(row.expires_at! + 1);
    f.sql
      .prepare(
        "UPDATE artifacts SET status='DELETED',error_code='ARTIFACT_DELETE_PENDING'",
      )
      .run();
    expect((await readArtifact(f.env, row.key)).status).toBe(410);
    await expireArtifacts(f.env);
    expect(f.objects.size).toBe(0);
  });
  it('cleans bytes from a late upload after expiry even if its immediate delete fails', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.kv.put.mockImplementationOnce(async (key, value) => {
      entered();
      await gate;
      f.objects.set(key, value);
    });
    const upload = storeArtifact(f.env, id, 'report', 'data');
    const outcome = expect(upload).rejects.toThrow('ARTIFACT_UPLOAD_FAILED');
    await started;
    const row = f.sql.prepare('SELECT * FROM artifacts').get()!;
    vi.spyOn(Date, 'now').mockReturnValue(Number(row.expires_at) + 1);
    await expireArtifacts(f.env);
    f.kv.delete.mockRejectedValueOnce(Error('late delete outage'));
    release();
    await outcome;
    expect((await readArtifact(f.env, String(row.key))).status).toBe(410);
    expect(f.objects.size).toBe(1);
    await expireArtifacts(f.env);
    expect(f.objects.size).toBe(0);
  });
  it('caps failed uploads at five attempts across repeated retries', async () => {
    const f = fixture();
    f.kv.put.mockRejectedValue(Error('outage'));
    for (let i = 0; i < 5; i++)
      await expect(storeArtifact(f.env, id, 'report', 'data')).rejects.toThrow(
        'ARTIFACT_UPLOAD_FAILED',
      );
    await expect(storeArtifact(f.env, id, 'report', 'data')).rejects.toThrow(
      'ARTIFACT_UPLOAD_BUSY_OR_RETRY_LIMIT',
    );
    expect(f.kv.put).toHaveBeenCalledTimes(5);
  });
  it('serializes concurrent lifetime quota reservations', async () => {
    const f = fixture();
    f.sql
      .prepare(
        "INSERT INTO artifacts(key,run_id,sha256,bytes,content_type,kind,storage,status) VALUES('prior',?,'hash',?,'text/plain','prior','KV','FAILED')",
      )
      .run(id, 20 * 1024 * 1024 - 4);
    const results = await Promise.allSettled([
      storeArtifact(f.env, id, 'one', '1234'),
      storeArtifact(f.env, id, 'two', '5678'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      Number(
        f.sql.prepare('SELECT sum(bytes) AS total FROM artifacts').get()!.total,
      ),
    ).toBe(20 * 1024 * 1024);
  });
  it('rejects anonymous artifact access and judge artifact retry before storage access', async () => {
    const f = fixture();
    const admin = 't'.repeat(64);
    expect(
      (
        await api(new Request('https://judge.test/api/artifact?key=anything'), {
          ...f.env,
          ADMIN_TOKEN: admin,
        })
      ).status,
    ).toBe(401);
    f.sql.exec(
      'CREATE TABLE organizer_sessions(hash TEXT PRIMARY KEY,expires_at INTEGER,role TEXT);',
    );
    const token = 'b'.repeat(64);
    f.sql
      .prepare('INSERT INTO organizer_sessions VALUES(?,?,?)')
      .run(await digest(token), Date.now() + 60000, 'judge');
    const env = {
      ...f.env,
      ORG_DB: f.env.DB,
      ORG_ADMIN_TOKEN: admin,
      ORG_VAULT_KEY: 'c'.repeat(64),
      ORG_PUBLIC_ORIGIN: 'https://judge.test',
      ORG_NAME: 'TestOrg',
    } as Env;
    const response = await organization(
      new Request(
        `https://judge.test/api/organization/evaluations/${id}/artifacts/retry`,
        {
          method: 'POST',
          headers: {
            origin: 'https://judge.test',
            cookie: `judge_organizer=${token}`,
          },
          body: '{}',
        },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'ORGANIZER_REQUIRED' });
    expect(f.kv.put).not.toHaveBeenCalled();
  });
  it('does not expose an object that exists only in another database scope', async () => {
    const a = fixture(),
      b = fixture();
    const row = await storeArtifact(a.env, id, 'report', 'data');
    b.objects.set(row.key, 'data');
    expect((await readArtifact(b.env, row.key)).status).toBe(404);
  });
  it('fences a stale callback after lease takeover and keeps the newer valid object', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    f.kv.put.mockImplementationOnce(async (key, value) => {
      entered();
      await gate;
      f.objects.set(key, value);
    });
    const upload = storeArtifact(f.env, id, 'report', 'data');
    const rejected = expect(upload).rejects.toThrow('ARTIFACT_UPLOAD_FAILED');
    await started;
    const row = f.sql.prepare('SELECT * FROM artifacts').get()!;
    vi.spyOn(Date, 'now').mockReturnValue(Number(row.upload_lease_until) + 1);
    const newer = await storeArtifact(f.env, id, 'report', 'data');
    expect(newer.status).toBe('STORED');
    release();
    await rejected;
    expect((await readArtifact(f.env, newer.key)).status).toBe(200);
    expect(f.kv.delete).not.toHaveBeenCalled();
  });
  it('an older cleanup callback cannot erase newer pending deletion work', async () => {
    const f = fixture();
    const row = await storeArtifact(f.env, id, 'report', 'data');
    vi.spyOn(Date, 'now').mockReturnValue(row.expires_at! + 1);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    f.kv.delete.mockImplementationOnce(async (key) => {
      f.objects.delete(key);
      entered();
      await gate;
    });
    const sweep = expireArtifacts(f.env);
    await started;
    f.objects.set(row.key, 'data');
    f.sql
      .prepare(
        "UPDATE artifacts SET delete_token='newer-upload',error_code='ARTIFACT_DELETE_PENDING',cleanup_after=? WHERE key=?",
      )
      .run(Date.now(), row.key);
    release();
    await sweep;
    expect(
      f.sql.prepare('SELECT error_code FROM artifacts').get()!.error_code,
    ).toBe('ARTIFACT_DELETE_PENDING');
    await expireArtifacts(f.env);
    expect(f.objects.size).toBe(0);
  });
  it('periodically revisits tombstones if an uploader crashes after a late write', async () => {
    const f = fixture();
    const row = await storeArtifact(f.env, id, 'report', 'data');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(row.expires_at! + 1);
    await expireArtifacts(f.env);
    f.objects.set(row.key, 'late bytes');
    expect((await readArtifact(f.env, row.key)).status).toBe(410);
    clock.mockReturnValue(row.expires_at! + 86400002);
    await expireArtifacts(f.env);
    expect(f.objects.size).toBe(0);
  });
});

it('preserves authoritative evidence and earlier stored bytes through partial provider failure and recovery', async () => {
  const f = fixture();
  const evidence = JSON.stringify([
    {
      id: 'trusted-check',
      kind: 'execution',
      status: 'FAIL',
      baselineStatus: 'PASS',
      claim: 'Synthetic regression evidence',
    },
  ]);
  f.sql
    .prepare('UPDATE evaluations SET evidence=?,report=? WHERE id=?')
    .run(evidence, '{"summary":"fixture report"}', id);
  const earlier = await storeArtifact(
    f.env,
    id,
    'prior-review',
    'Earlier immutable review',
  );
  f.kv.put
    .mockImplementationOnce(async (key, value) => {
      f.objects.set(key, value);
    })
    .mockRejectedValueOnce(Error('private provider credential details'));
  const partial = await captureRunArtifacts(f.env, id);
  expect(partial.status).toBe('PARTIAL');
  expect(partial.failures).toContainEqual({
    kind: 'report',
    code: 'ARTIFACT_UPLOAD_FAILED',
  });
  expect(partial.artifacts.find((a) => a.kind === 'report')!.status).toBe(
    'FAILED',
  );
  expect(partial.artifacts.find((a) => a.kind === 'evidence')!.status).toBe(
    'STORED',
  );
  expect(
    f.sql.prepare('SELECT evidence FROM evaluations WHERE id=?').get(id)!
      .evidence,
  ).toBe(evidence);
  const retained = await readArtifact(f.env, earlier.key);
  expect(retained.status).toBe(200);
  expect(await retained.text()).toBe('Earlier immutable review');
  expect(JSON.stringify(partial)).not.toContain('private provider');
  const recovered = await captureRunArtifacts(f.env, id);
  expect(recovered.status).toBe('CAPTURED');
  expect(recovered.artifacts.find((a) => a.kind === 'report')).toMatchObject({
    status: 'STORED',
    attempts: 2,
  });
  expect(
    f.sql.prepare('SELECT evidence FROM evaluations WHERE id=?').get(id)!
      .evidence,
  ).toBe(evidence);
});
