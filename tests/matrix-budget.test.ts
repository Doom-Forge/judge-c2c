import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { readFileSync } from 'node:fs';
import { reserveMatrixStart, matrixBudget } from '../src/matrix-budget';
import { readBaseline, retainBaseline } from '../src/matrix-baseline';
import { scoreMatrix } from '../src/matrix';
import { acquireMatrixSlot, releaseMatrixSlot } from '../src/matrix-capacity';
let mf: Miniflare, db: D1Database;
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default{}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-08-01',
  });
  db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const file of [
    '0028_matrix_capacity.sql',
    '0031_matrix_cost_controls.sql',
  ])
    for (const sql of readFileSync('migrations/' + file, 'utf8')
      .split(';')
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
});
afterAll(async () => mf.dispose());
it('atomically caps concurrent reservations, retains failures and expires only after 31 days', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      reserveMatrixStart(db, { MATRIX_START_LIMIT: '3' }, 'owner' + i, 1000),
    ),
  );
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(3);
  expect(
    (await matrixBudget(db, { MATRIX_START_LIMIT: '3' }, 1001)).startsRemaining,
  ).toBe(0);
  await expect(
    reserveMatrixStart(
      db,
      { MATRIX_START_LIMIT: '3' },
      'new',
      1000 + 31 * 86400000,
    ),
  ).rejects.toThrow('MATRIX_BUDGET_LIMIT');
  await expect(
    reserveMatrixStart(
      db,
      { MATRIX_START_LIMIT: '3' },
      'new',
      1001 + 31 * 86400000,
    ),
  ).resolves.toBeUndefined();
});
it('fails closed for invalid or expanded start limits', async () => {
  for (const value of ['', 'NaN', '0', '81', '1.5', 'Infinity'])
    await expect(
      reserveMatrixStart(db, { MATRIX_START_LIMIT: value }, 'invalid'),
    ).rejects.toThrow('MATRIX_INVALID_BUDGET_CONFIG');
});
it('caps all repositories at four and keeps release owner safe', async () => {
  const slots = await Promise.all(
    ['a', 'b', 'c', 'd'].map((r) => acquireMatrixSlot(db, r, r, 1000)),
  );
  await expect(acquireMatrixSlot(db, 'e', 'e', 1000)).rejects.toThrow(
    'MATRIX_BUSY',
  );
  await releaseMatrixSlot(db, slots[0]!, 'wrong');
  await expect(acquireMatrixSlot(db, 'e', 'e', 1000)).rejects.toThrow(
    'MATRIX_BUSY',
  );
  await releaseMatrixSlot(db, slots[0]!, 'a');
  await expect(acquireMatrixSlot(db, 'e', 'e', 1000)).resolves.toBeTruthy();
});
it('keeps two slots per repository even when global capacity remains', async () => {
  await db.prepare('DELETE FROM matrix_capacity').run();
  await acquireMatrixSlot(db, 'same', 'one', 5000);
  await acquireMatrixSlot(db, 'same', 'two', 5000);
  await expect(acquireMatrixSlot(db, 'same', 'three', 5000)).rejects.toThrow(
    'MATRIX_BUSY',
  );
});

it('reuses only the exact repository, baseline, matrix and image identity', async () => {
  const key = {
    repository: 'org/repo',
    baselineSha: 'a',
    matrixDigest: 'b',
    imageUri: 'image',
  };
  const rules = ['scalability', 'security', 'usefulness'].map((category) => ({
    id: category,
    category,
    weight: 1,
    mandatory: true,
  }));
  const report = {
    ...scoreMatrix(
      rules,
      rules.map((r) => ({
        id: r.id,
        category: r.category,
        status: 'FAIL',
        durationMs: 1,
        detail: '',
      })),
    ),
    image: 'image',
    finishedAt: '2026-11-05T00:00:00Z',
  };
  await retainBaseline(db, key, rules, report);
  expect(await readBaseline(db, key, rules)).toEqual(report);
  for (const field of ['repository', 'baselineSha', 'matrixDigest', 'imageUri'])
    expect(
      await readBaseline(db, { ...key, [field]: 'changed' }, rules),
    ).toBeNull();
  await retainBaseline(db, { ...key, baselineSha: 'unverified' }, rules, {
    ...report,
    ...scoreMatrix(rules, []),
  });
  expect(
    await readBaseline(db, { ...key, baselineSha: 'unverified' }, rules),
  ).toBeNull();
});
