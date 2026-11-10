import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import {
  acquireReviewer,
  releaseReviewer,
  renewReviewer,
} from '../src/reviewer-capacity';
let mf: Miniflare, db: D1Database;
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-08-01',
  });
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  await migrate(db);
});
afterAll(() => mf.dispose());
it('serializes competing provider reviews and releases capacity', async () => {
  const slots = await Promise.all([
    acquireReviewer(db, 'callmissed', 1000),
    acquireReviewer(db, 'callmissed', 1000),
  ]);
  expect(slots.filter(Boolean)).toHaveLength(1);
  await releaseReviewer(db, slots.find(Boolean)!);
  const next = await acquireReviewer(db, 'callmissed', 1001);
  expect(next).not.toBeNull();
  await releaseReviewer(db, next!);
});
it('expires crashed ownership and fences stale cleanup', async () => {
  const crashed = await acquireReviewer(db, 'callmissed', 1000);
  expect(crashed).not.toBeNull();
  expect(await acquireReviewer(db, 'callmissed', 180999)).toBeNull();
  const recovered = await acquireReviewer(db, 'callmissed', 181000);
  expect(recovered).not.toBeNull();
  expect(await renewReviewer(db, crashed!, 181001)).toBe(false);
  expect(await renewReviewer(db, recovered!, 181001)).toBe(true);
  await releaseReviewer(db, crashed!);
  expect(await acquireReviewer(db, 'callmissed', 181001)).toBeNull();
  await releaseReviewer(db, recovered!);
});

it('fences an 80-request provider burst across two real Worker isolates sharing D1, including crash recovery', async () => {
  const { buildSync } = await import('esbuild');
  const script = buildSync({
    stdin: {
      contents: `import { acquireReviewer, releaseReviewer, renewReviewer } from './src/reviewer-capacity.ts';
export default {async fetch(request,env){const input=await request.json();const path=new URL(request.url).pathname;const result=path==='/acquire'?await acquireReviewer(env.DB,'burst-fixture',input.now):path==='/renew'?await renewReviewer(env.DB,input.slot,input.now):await releaseReviewer(env.DB,input.slot);return Response.json(result);}};`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
  }).outputFiles[0]!.text;
  const shared = crypto.randomUUID();
  const runtime = new Miniflare({
    workers: ['worker-a', 'worker-b'].map((name) => ({
      name,
      modules: true,
      script,
      d1Databases: { DB: shared },
      compatibilityDate: '2026-08-01',
    })),
  });
  try {
    await migrate(
      (await runtime.getD1Database('DB', 'worker-a')) as unknown as D1Database,
    );
    const workers = await Promise.all(
      ['worker-a', 'worker-b'].map((name) => runtime.getWorker(name)),
    );
    const invoke = async (worker: number, path: string, body: unknown) =>
      (
        await workers[worker]!.fetch('https://fixture.test' + path, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).json();
    const contenders = (await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        invoke(index % 2, '/acquire', { now: 1000 }),
      ),
    )) as ({ owner: string; provider: string } | null)[];
    expect(contenders.filter(Boolean)).toHaveLength(1);
    const crashed = contenders.find(Boolean)!;
    expect(await invoke(1, '/acquire', { now: 180999 })).toBeNull();
    const recovered = (await invoke(0, '/acquire', { now: 181000 })) as {
      owner: string;
      provider: string;
    };
    expect(recovered.owner).not.toBe(crashed.owner);
    expect(await invoke(1, '/renew', { slot: crashed, now: 181001 })).toBe(
      false,
    );
    await invoke(1, '/release', { slot: crashed });
    expect(await invoke(0, '/acquire', { now: 181001 })).toBeNull();
    expect(await invoke(1, '/renew', { slot: recovered, now: 181001 })).toBe(
      true,
    );
    await invoke(1, '/release', { slot: recovered });
    expect(await invoke(0, '/acquire', { now: 181002 })).not.toBeNull();
  } finally {
    await runtime.dispose();
  }
}, 30000);

it('keeps provider leases independent across provider identities', async () => {
  const occupied = await acquireReviewer(db, 'callmissed', 1000);
  expect(occupied).not.toBeNull();
  const other = await acquireReviewer(db, 'cloudflare', 1000);
  expect(other).not.toBeNull();
  expect(await acquireReviewer(db, 'callmissed', 1001)).toBeNull();
  await releaseReviewer(db, other!);
  await releaseReviewer(db, occupied!);
});
