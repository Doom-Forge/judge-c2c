import { describe, expect, it } from 'vitest';
import { scoreMatrix, validateSnapshot } from '../src/matrix';

const matrix = ['scalability', 'security', 'usefulness'].flatMap((category) =>
  [1, 2].map((n) => ({
    id: `${category}-${n}`,
    category,
    weight: 1,
    mandatory: n === 1,
  })),
);
const checks = matrix.map((c) => ({
  id: c.id,
  category: c.category,
  status: 'PASS',
  durationMs: 12,
  detail: 'Measured check passed.',
}));
describe('matrix scoring', () => {
  it('never rounds a mixed outcome into a PASS status', () => {
    const rules = matrix.map((m) => ({
      ...m,
      weight: m.id.endsWith('-1') ? 10000 : 1,
      mandatory: false,
    }));
    expect(
      scoreMatrix(
        rules,
        checks.map((c) =>
          c.id === 'scalability-2' ? { ...c, status: 'FAIL' } : c,
        ),
      ).categories.scalability.status,
    ).toBe('PARTIAL');
  });
  it('uses equal category weights and preserves mandatory failures', () => {
    const report = scoreMatrix(
      matrix,
      checks.map((c) => (c.id === 'security-1' ? { ...c, status: 'FAIL' } : c)),
    );
    expect(report.categories.security).toEqual({ status: 'FAIL', score: 50 });
    expect(report.overallScore).toBe(83.3);
  });
  it('does not give missing checks or explicit unverified checks a score', () => {
    const report = scoreMatrix(matrix, checks.slice(1));
    expect(report.categories.scalability).toEqual({
      status: 'UNVERIFIED',
      score: null,
    });
    expect(report.overallScore).toBeNull();
  });
  it('rejects duplicate, unknown and wrong-category evidence', () => {
    expect(() => scoreMatrix(matrix, [...checks, checks[0]])).toThrow();
    expect(() =>
      scoreMatrix(matrix, [{ ...checks[0], id: 'invented' }]),
    ).toThrow();
    expect(() =>
      scoreMatrix(matrix, [{ ...checks[0], category: 'security' }]),
    ).toThrow();
  });
  it('rejects malformed status and unbounded outputs', () => {
    expect(() =>
      scoreMatrix(matrix, [{ ...checks[0], status: 'great' }]),
    ).toThrow();
    expect(() =>
      scoreMatrix(matrix, [{ ...checks[0], detail: 'x'.repeat(3000) }]),
    ).toThrow();
  });
});
describe('matrix snapshot bounds', () => {
  it('rejects traversal, duplicate paths and private keys', () => {
    for (const path of [
      '../escape',
      '.git/config',
      '.env',
      'keys/id_rsa',
      'secret.pem',
    ])
      expect(() => validateSnapshot([{ path, base64: 'eA==' }])).toThrow();
    expect(() =>
      validateSnapshot([
        { path: 'a.py', base64: 'eA==' },
        { path: 'a.py', base64: 'eA==' },
      ]),
    ).toThrow();
  });
  it('accepts binary dataset snapshots without text decoding corruption', () => {
    expect(
      validateSnapshot([
        { path: 'data/public/sample.parquet', base64: 'AAH/' },
      ]),
    ).toHaveLength(1);
  });
});
