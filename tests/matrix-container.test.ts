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
    setAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
  };
  const runner = new NoyyalMatrixRunner(
    { container, storage } as unknown as DurableObjectState,
    {
      MATRIX_IMAGE_URI: image,
      ADMIN_TOKEN: 'never-send-this',
      DB: {
        prepare: () => ({
          bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
        }),
      },
    } as unknown as Env,
  );
  return { runner, container };
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
    instance: 'standard-1',
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
