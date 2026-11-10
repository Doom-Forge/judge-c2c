import { expect, it } from 'vitest';
import { baselineCacheable } from '../src/matrix-baseline';
import { scoreMatrix } from '../src/matrix';
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
      status: 'PASS',
      durationMs: 1,
      detail: '',
    })),
  ),
  image: 'image',
  finishedAt: new Date().toISOString(),
};
it('only accepts complete verified exact-image baseline reports', () => {
  expect(baselineCacheable(report, rules, 'image')).toBe(true);
  expect(baselineCacheable(report, rules, 'other')).toBe(false);
  expect(baselineCacheable({ ...report, checks: [] }, rules, 'image')).toBe(
    false,
  );
  expect(
    baselineCacheable(
      {
        ...report,
        checks: report.checks.map((c) => ({ ...c, status: 'UNVERIFIED' })),
      },
      rules,
      'image',
    ),
  ).toBe(false);
});
