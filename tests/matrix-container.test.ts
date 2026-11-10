import { readFileSync } from 'node:fs';
import { Miniflare } from './miniflare';
import { acquireMatrixSlot } from '../src/matrix-capacity';
import { expect, it, vi } from 'vitest';
import { NoyyalMatrixRunner } from '../src/matrix-workflow';
import matrices from '../matrix-runner/matrices.json';
import type { Env } from '../src/env';

const image = 'registry.cloudflare.com/fixture/judge@sha256:' + '1'.repeat(64);
function fixture(
  checks: unknown = matrices['noyyal-treasury'].checks
    .map((c) => ({ ...c, status: 'PASS', durationMs: 10, detail: 'Verified' }))
    .map(({ id, category, status, durationMs, detail }) => ({
      id,
      category,
      status,
      durationMs,
      detail,
    })),
  db?: D1Database,
) {
  const values = new Map();
  const container = {
    images: { base: image },
    start: vi.fn(),
    setInactivityTimeout: vi.fn(),
    inspect: vi.fn(async () => ({ image })),
    destroy: vi.fn(async () => {}),
    exec: vi.fn(async () => ({
      stdin: new WritableStream({ write() {} }),
      stdout: new Response(JSON.stringify({ checks })).body,
      stderr: new Response('').body,
      exitCode: Promise.resolve(0),
      kill: vi.fn(),
    })),
  };
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (key: string) => values.delete(key),
    setAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
  };
  const runner = new NoyyalMatrixRunner(
    { container, storage } as unknown as DurableObjectState,
    {
      MATRIX_IMAGE_URI: image,
      ADMIN_TOKEN: 'never-send-this',
      DB: db ?? {
        prepare: () => ({
          bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
        }),
      },
    } as unknown as Env,
  );
  return { runner, container, storage, values };
}
it('executes without internet or credentials and destroys single-use instances', async () => {
  const { runner, container } = fixture();
  const report = await runner.evaluate({
    repository: 'noyyal-treasury',
    image,
    files: [],
  });
  expect(report.overallScore).toBe(100);
  expect(container.start).toHaveBeenCalledWith({
    image,
    instance: 'basic',
    enableInternet: false,
    env: {},
    entrypoint: ['sleep', 'infinity'],
  });
  expect(JSON.stringify(container.exec.mock.calls)).not.toContain(
    'never-send-this',
  );
  expect(container.destroy).toHaveBeenCalledTimes(1);
  await expect(
    runner.evaluate({ repository: 'noyyal-treasury', image, files: [] }),
  ).rejects.toThrow('MATRIX_CONTAINER_ALREADY_USED');
});
it('rejects an image mismatch before starting code', async () => {
  const { runner, container } = fixture();
  await expect(
    runner.evaluate({
      repository: 'noyyal-treasury',
      image: image.replace('1111', '2222'),
      files: [],
    }),
  ).rejects.toThrow('MATRIX_IMAGE_MISMATCH');
  expect(container.start).not.toHaveBeenCalled();
});
it('rejects forged evidence and still destroys the guest', async () => {
  const { runner, container } = fixture([
    {
      id: 'invented',
      category: 'security',
      status: 'PASS',
      durationMs: 0,
      detail: 'forged',
    },
  ]);
  await expect(
    runner.evaluate({ repository: 'noyyal-treasury', image, files: [] }),
  ).rejects.toThrow('MATRIX_UNKNOWN_CHECK');
  expect(container.destroy).toHaveBeenCalledTimes(1);
});

it('retains uncertain capacity until an alarm confirms destruction', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default{}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-08-01',
  });
  try {
    const db = (await mf.getD1Database('DB')) as unknown as D1Database;
    for (const file of [
      '0028_matrix_capacity.sql',
      '0031_matrix_cost_controls.sql',
    ])
      for (const sql of readFileSync('migrations/' + file, 'utf8')
        .split(';')
        .filter((s) => s.trim()))
        await db.prepare(sql).run();
    await acquireMatrixSlot(db, 'noyyal-treasury', 'other');
    const { runner, container, storage, values } = fixture(undefined, db);
    container.destroy.mockRejectedValueOnce(new Error('DESTROY_FAILED'));
    await expect(
      runner.evaluate({ repository: 'noyyal-treasury', image, files: [] }),
    ).rejects.toThrow('DESTROY_FAILED');
    expect(values.has('activeCapacity')).toBe(true);
    expect(storage.deleteAlarm).not.toHaveBeenCalled();
    await expect(
      acquireMatrixSlot(db, 'noyyal-treasury', 'next', Date.now() + 99999999),
    ).rejects.toThrow('MATRIX_BUSY');
    container.destroy.mockRejectedValueOnce(new Error('STILL_RUNNING'));
    await runner.alarm();
    await expect(
      acquireMatrixSlot(db, 'noyyal-treasury', 'next'),
    ).rejects.toThrow('MATRIX_BUSY');
    await runner.alarm();
    expect(values.has('activeCapacity')).toBe(false);
    await expect(
      acquireMatrixSlot(db, 'noyyal-treasury', 'next'),
    ).resolves.toBeTruthy();
  } finally {
    await mf.dispose();
  }
});
it('releases pre-start capacity when arming the alarm fails', async () => {
  const { runner, container, storage, values } = fixture();
  storage.setAlarm.mockRejectedValueOnce(new Error('ALARM_FAILED'));
  await expect(
    runner.evaluate({ repository: 'noyyal-treasury', image, files: [] }),
  ).rejects.toThrow('ALARM_FAILED');
  expect(container.start).not.toHaveBeenCalled();
  expect(values.has('activeCapacity')).toBe(false);
});
