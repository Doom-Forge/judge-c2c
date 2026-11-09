import { expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import {
  JanusMatrixRunner,
  MazhaiCoverMatrixRunner,
  NoyyalMatrixRunner,
  PricingPulseMatrixRunner,
  RasoiMatrixRunner,
  VeeraFootwearMatrixRunner,
} from '../src/matrix-workflow';

const image = 'registry.cloudflare.com/fixture/judge@sha256:' + '1'.repeat(64);
const report = {
  diagnosticOnly: true,
  status: 'READY',
  checks: ['unprivileged uid', 'seccomp'],
  reason: null,
  codeSha256: '2'.repeat(64),
};
const source = { code: 'print("CONTAINER_DIAGNOSTIC_OK")\n', sourceSha: 'a'.repeat(40) };

function fixture(Runner: new (state: DurableObjectState, env: Env) => { diagnose(input: unknown): Promise<Record<string, unknown>> }) {
  const values = new Map<string, unknown>();
  const container = {
    images: { base: image },
    start: vi.fn(),
    setInactivityTimeout: vi.fn(),
    inspect: vi.fn(async () => ({ image })),
    destroy: vi.fn(async () => {}),
    exec: vi.fn(async () => ({
      stdin: new WritableStream({ write() {} }),
      stdout: new Response(JSON.stringify(report)).body,
      stderr: new Response('').body,
      exitCode: Promise.resolve(0),
      kill: vi.fn(),
    })),
  };
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    setAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
  };
  const db = { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }) };
  const runner = new Runner({ container, storage } as unknown as DurableObjectState, {
    MATRIX_DIAGNOSTIC_IMAGE_URI: image, DB: db,
  } as unknown as Env);
  return { runner, container, storage };
}

it('runs an infrastructure-only sandbox check for every competition container class', async () => {
  const classes = [
    [NoyyalMatrixRunner, 'noyyal-treasury'],
    [RasoiMatrixRunner, 'rasoi-offer-roulette'],
    [MazhaiCoverMatrixRunner, 'mazhai-cover'],
    [PricingPulseMatrixRunner, 'pricingpulse'],
    [VeeraFootwearMatrixRunner, 'veera-footwear'],
    [JanusMatrixRunner, 'janus'],
  ] as const;
  for (const [Runner, repository] of classes) {
    const { runner, container } = fixture(Runner);
    const result = await runner.diagnose({ image, code: source.code, sourceSha: source.sourceSha });
    expect(result).toMatchObject({ diagnosticOnly: true, status: 'READY', repository, sourceSha: source.sourceSha });
    expect(result).not.toHaveProperty('score');
    expect(container.start).toHaveBeenCalledWith({
      image, instance: 'basic', enableInternet: false, env: {}, entrypoint: ['sleep', 'infinity'],
    });
    expect(container.exec).toHaveBeenCalledWith(
      ['python', '/opt/judge/controller.py', '--diagnostic'],
      expect.objectContaining({ cwd: '/opt/judge', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } }),
    );
    expect(container.destroy).toHaveBeenCalledTimes(1);
  }
});

it('rejects a different pinned image before starting the container', async () => {
  const { runner, container } = fixture(MazhaiCoverMatrixRunner);
  await expect(runner.diagnose({ image: image.replace('1111', '2222'), code: source.code, sourceSha: source.sourceSha })).rejects.toThrow('MATRIX_IMAGE_MISMATCH');
  expect(container.start).not.toHaveBeenCalled();
});
