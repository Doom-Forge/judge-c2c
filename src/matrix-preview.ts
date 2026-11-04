import matrices from '../matrix-runner/matrices.json';
import { scoreMatrix, type MatrixCheck } from './matrix';

type PreviewEnv = { ASSETS: Fetcher };
const syntheticNotice =
  'SYNTHETIC PREVIEW · Public demo credential: preview. Generated fixtures only; no participant code or containers were executed.';

export async function previewFixtures() {
  const repositories = Object.keys(matrices).map((name, index) => ({
    id: `synthetic-repository-${index + 1}`,
    full_name: `180DC-VIT-CHENNAI/${name}`,
  }));
  const runs = [];
  for (const [index, [name, matrix]] of Object.entries(matrices).entries()) {
    const matrixDigest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify(matrix)),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    for (const [attempt, kind] of [
      'passing',
      'failing',
      'unverified',
    ].entries()) {
      const checks: MatrixCheck[] = matrix.checks.map((rule, checkIndex) => ({
        id: rule.id,
        category: rule.category as MatrixCheck['category'],
        status:
          kind === 'unverified' && rule.category === 'security'
            ? 'UNVERIFIED'
            : kind === 'failing' && checkIndex % 2 === 0
              ? 'FAIL'
              : 'PASS',
        durationMs: 10 + checkIndex * 7,
        detail: `SYNTHETIC ${kind} fixture. ${rule.description}. No container execution measured.`,
      }));
      const baseline = scoreMatrix(
        matrix.checks,
        checks.map((check) => ({
          ...check,
          status: 'PASS' as const,
          detail: 'SYNTHETIC baseline fixture; no reference solution executed.',
        })),
      );
      const report = scoreMatrix(matrix.checks, checks);
      runs.push({
        id: (index * 3 + attempt + 1).toString(16).padStart(64, '0'),
        repository_id: repositories[index]!.id,
        full_name: `180DC-VIT-CHENNAI/${name}`,
        pr_number: attempt + 1,
        head_sha: 'a'.repeat(40),
        baseline_sha: 'b'.repeat(40),
        matrix_version: matrix.version,
        matrix_digest: matrixDigest,
        image_uri: 'synthetic-fixture:no-container-executed',
        state: kind === 'unverified' ? 'FAILED' : 'COMPLETED',
        failure_code:
          kind === 'unverified' ? 'SYNTHETIC_EXECUTION_ERROR' : null,
        created_at: `2026-11-04T09:0${index * 3 + attempt}:00Z`,
        report: {
          ...report,
          baseline,
          image: 'synthetic-fixture:no-container-executed',
        },
        synthetic: true,
      });
    }
  }
  return {
    repositories,
    runs,
    mode: 'cloudflare-containers',
    synthetic: true,
    notice: syntheticNotice,
  };
}

export default {
  async fetch(request: Request, env: PreviewEnv): Promise<Response> {
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: {
          'Cache-Control': 'no-store',
          'X-Doomforge-Preview': 'synthetic-only',
        },
      });
    if (url.pathname.startsWith('/api/')) {
      if (request.headers.get('Authorization') !== 'Bearer preview')
        return json({ error: 'UNAUTHORIZED', notice: syntheticNotice }, 401);
      if (request.method !== 'GET')
        return json(
          { error: 'READ_ONLY_SYNTHETIC_PREVIEW', notice: syntheticNotice },
          405,
        );
      const fixtures = await previewFixtures();
      if (url.pathname === '/api/matrix/overview') return json(fixtures);
      const match = /^\/api\/matrix\/runs\/([a-f0-9]{64})$/.exec(url.pathname);
      const run = match && fixtures.runs.find((item) => item.id === match[1]);
      return run ? json(run) : json({ error: 'NOT_FOUND' }, 404);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('Read-only preview', { status: 405 });
    if (url.pathname === '/' || url.pathname === '/matrix.html') {
      url.pathname = '/matrix.html';
      const asset = await env.ASSETS.fetch(new Request(url, request));
      const html = (await asset.text())
        .replace(
          'CLOUDFLARE CONTAINERS',
          'SYNTHETIC PREVIEW · NO LIVE EXECUTION',
        )
        .replace(
          'Trusted checks. Frozen baselines. Every attempt accounted for.',
          syntheticNotice,
        )
        .replace(
          'id="credential"',
          'id="credential" placeholder="Public demo credential: preview"',
        );
      return new Response(request.method === 'HEAD' ? null : html, {
        status: asset.status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    if (!['/matrix.js', '/matrix.css', '/style.css'].includes(url.pathname))
      return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
