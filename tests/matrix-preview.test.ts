import { expect, it } from 'vitest';
import preview, { previewFixtures } from '../src/matrix-preview';
const env = {
  ASSETS: {
    fetch: async () =>
      new Response(
        '<span>CLOUDFLARE CONTAINERS</span><p>Trusted checks. Frozen baselines. Every attempt accounted for.</p><input id="credential">',
      ),
  },
} as unknown as { ASSETS: Fetcher };
it('serves deterministic scored fixtures with explicit synthetic provenance', async () => {
  const one = await previewFixtures();
  expect(one).toEqual(await previewFixtures());
  expect(one.runs).toHaveLength(6);
  expect(one.runs.map((run) => run.report.overallScore)).toEqual([
    100,
    50,
    null,
    100,
    50,
    null,
  ]);
  expect(
    one.runs.every((run) => run.synthetic && run.matrix_digest.length === 64),
  ).toBe(true);
});
it('rejects unauthenticated reads and every mutation without execution bindings', async () => {
  expect(
    (
      await preview.fetch(
        new Request('https://preview/api/matrix/overview'),
        env,
      )
    ).status,
  ).toBe(401);
  const response = await preview.fetch(
    new Request('https://preview/api/matrix/runs/x/retry', {
      method: 'POST',
      headers: { Authorization: 'Bearer preview' },
    }),
    env,
  );
  expect(response.status).toBe(405);
  expect(await response.json()).toMatchObject({
    error: 'READ_ONLY_SYNTHETIC_PREVIEW',
  });
});
it('labels the dashboard visibly and offers the public demo credential', async () => {
  const response = await preview.fetch(new Request('https://preview/'), env);
  const html = await response.text();
  expect(html).toContain('SYNTHETIC PREVIEW · NO LIVE EXECUTION');
  expect(html).toContain('no participant code or containers were executed');
  expect(html).toContain('Public demo credential: preview');
});
