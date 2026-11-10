import { expect, it, vi } from 'vitest';
import { DiagnosticSourceError, diagnoseMatrixContainers, readDiagnosticSources } from '../src/matrix-container-diagnostic';
import type { Env } from '../src/env';

function namespace(repository: string, status = 'READY') {
  return {
    newUniqueId: vi.fn(() => repository),
    get: vi.fn(() => ({ diagnose: vi.fn(async () => ({ diagnosticOnly: true, repository, status })) })),
  };
}

it('checks every configured class sequentially and returns no competition marks', async () => {
  const names = ['mazhai-cover', 'pricingpulse', 'veera-footwear', 'janus'];
  const bindings = names.map((name) => namespace(name));
  const env = Object.fromEntries([
    ['MAZHAI_COVER_MATRIX', bindings[0]], ['PRICINGPULSE_MATRIX', bindings[1]],
    ['VEERA_FOOTWEAR_MATRIX', bindings[2]], ['JANUS_MATRIX', bindings[3]],
  ]) as unknown as Env;
  env.MATRIX_DIAGNOSTIC_IMAGE_URI = 'registry.cloudflare.com/test/image@sha256:' + '1'.repeat(64);
  const sources = Object.fromEntries(names.map((name) => [name, { sha: 'a'.repeat(40), code: 'print("CONTAINER_DIAGNOSTIC_OK")\n' }])) as never;
  const result = await diagnoseMatrixContainers(env, sources);
  expect(result).toMatchObject({ diagnosticOnly: true, competitionMarks: false, status: 'READY' });
  expect(result.results.map((item) => item.repository)).toEqual(names);
  expect(result.results.every((item) => item.diagnosticOnly)).toBe(true);
  expect(result).not.toHaveProperty('score');
  expect(bindings.every((item) => item.get.mock.calls.length === 1)).toBe(true);
});

it('reports an incomplete status if any container cannot be checked', async () => {
  const env = {
    MAZHAI_COVER_MATRIX: namespace('mazhai-cover', 'FAILED'),
  } as unknown as Env;
  const sources = Object.fromEntries(['mazhai-cover', 'pricingpulse', 'veera-footwear', 'janus'].map((name) => [name, { sha: 'a'.repeat(40), code: 'print("CONTAINER_DIAGNOSTIC_OK")\n' }])) as never;
  const result = await diagnoseMatrixContainers(env, sources);
  expect(result.status).toBe('INCOMPLETE');
  expect(result.results).toHaveLength(4);
  expect(result.results[0]?.status).toBe('FAILED');
  expect(result.results.slice(1).every((item) => item.status === 'NOT_CONFIGURED')).toBe(true);
});

it('loads only the fixed diagnostic path at each exact public repository SHA', async () => {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('user-agent')).toBe('Doomforge-Matrix-Diagnostic');
    return new Response('print("CONTAINER_DIAGNOSTIC_OK")\n');
  });
  vi.stubGlobal('fetch', fetchMock);
  try {
    const sha = 'b'.repeat(40);
    const result = await readDiagnosticSources(Object.fromEntries(
      ['mazhai-cover', 'pricingpulse', 'veera-footwear', 'janus'].map((repo) => [repo, sha]),
    ));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/Doom-Forge/mazhai-cover/' + sha + '/src/diagnostic.py');
    expect(result.janus).toEqual({ sha, code: 'print("CONTAINER_DIAGNOSTIC_OK")\n' });
  } finally {
    vi.unstubAllGlobals();
  }
});

it('rejects malformed refs and refuses manual redirects or oversized diagnostic source', async () => {
  await expect(readDiagnosticSources({})).rejects.toThrow();
  const commits = Object.fromEntries(
    ['mazhai-cover', 'pricingpulse', 'veera-footwear', 'janus'].map((repo) => [repo, 'b'.repeat(40)]),
  );
  vi.stubGlobal('fetch', vi.fn(async () => new Response('redirect', { status: 302, headers: { location: 'https://example.invalid/' } })));
  try {
    await expect(readDiagnosticSources(commits)).rejects.toMatchObject({
      repository: 'mazhai-cover', sourceStatus: 'HTTP_302',
    } satisfies Partial<DiagnosticSourceError>);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(4097))));
    await expect(readDiagnosticSources(commits)).rejects.toMatchObject({
      repository: 'mazhai-cover', sourceStatus: 'SOURCE_LIMIT',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(readDiagnosticSources(commits)).rejects.toMatchObject({
      repository: 'mazhai-cover', sourceStatus: 'HTTP_404',
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
