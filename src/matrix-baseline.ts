import { canonical } from './domain';
import { scoreMatrix, type MatrixRule } from './matrix';
export type BaselineIdentity = {
  repository: string;
  baselineSha: string;
  matrixDigest: string;
  imageUri: string;
};
export type BaselineReport = ReturnType<typeof scoreMatrix> & {
  image?: string;
  finishedAt?: string;
};
export function baselineCacheable(
  report: BaselineReport,
  rules: MatrixRule[],
  image: string,
) {
  try {
    const verified = scoreMatrix(rules, report.checks);
    return (
      report.image === image &&
      typeof report.finishedAt === 'string' &&
      verified.overallScore !== null &&
      verified.checks.length === rules.length &&
      canonical(verified) ===
        canonical({
          categories: report.categories,
          overallScore: report.overallScore,
          checks: report.checks,
        })
    );
  } catch {
    return false;
  }
}
const values = (key: BaselineIdentity) => [
  key.repository,
  key.baselineSha,
  key.matrixDigest,
  key.imageUri,
];
export async function readBaseline(
  db: D1Database,
  key: BaselineIdentity,
  rules: MatrixRule[],
) {
  const raw = await db
    .prepare(
      'SELECT report FROM matrix_baseline_cache WHERE repository=? AND baseline_sha=? AND matrix_digest=? AND image_uri=?',
    )
    .bind(...values(key))
    .first<string>('report');
  if (!raw) return null;
  try {
    const report = JSON.parse(raw) as BaselineReport;
    return baselineCacheable(report, rules, key.imageUri) ? report : null;
  } catch {
    return null;
  }
}
// Only the workflow calls this after a trusted immutable baseline execution.
export async function retainBaseline(
  db: D1Database,
  key: BaselineIdentity,
  rules: MatrixRule[],
  report: BaselineReport,
) {
  if (!baselineCacheable(report, rules, key.imageUri)) return;
  await db
    .prepare(
      'INSERT OR IGNORE INTO matrix_baseline_cache(repository,baseline_sha,matrix_digest,image_uri,report) VALUES(?,?,?,?,?)',
    )
    .bind(...values(key), canonical(report))
    .run();
}
