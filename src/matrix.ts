import { z } from 'zod';
import { pathSchema } from './domain';

export const categories = ['scalability', 'security', 'usefulness'] as const;
// These repositories are intentionally visible while challenge specifications
// are being prepared. They have no trusted matrix, baseline, or container image
// yet and must not be evaluated or scored.
export const specificationRequiredRepositories = [
  '180DC-VIT-CHENNAI/mazhai-cover',
  '180DC-VIT-CHENNAI/pricingpulse',
  '180DC-VIT-CHENNAI/veera-footwear',
  '180DC-VIT-CHENNAI/queueforge',
] as const;
export const matrixRepositoryStatus = (
  fullName: string,
  configured: boolean,
) => {
  if (
    specificationRequiredRepositories.includes(
      fullName as (typeof specificationRequiredRepositories)[number],
    )
  )
    return 'SPECIFICATION_REQUIRED';
  if (
    configured &&
    [
      '180DC-VIT-CHENNAI/noyyal-treasury',
      '180DC-VIT-CHENNAI/rasoi-offer-roulette',
    ].includes(fullName)
  )
    return 'READY';
  return 'NOT_CONFIGURED';
};
const checkSchema = z
  .object({
    id: z.string().min(1).max(100),
    category: z.enum(categories),
    status: z.enum(['PASS', 'FAIL', 'UNVERIFIED']),
    durationMs: z.number().nonnegative().finite().max(600000),
    detail: z.string().max(2000),
  })
  .strict();
export type MatrixCheck = z.infer<typeof checkSchema>;
export type MatrixRule = {
  id: string;
  category: string;
  weight: number;
  mandatory: boolean;
  description?: string;
};
export function scoreMatrix(matrix: MatrixRule[], raw: unknown) {
  const checks = z.array(checkSchema).max(100).parse(raw);
  if (new Set(checks.map((c) => c.id)).size !== checks.length)
    throw new Error('MATRIX_DUPLICATE_CHECK');
  if (
    checks.some(
      (c) => !matrix.some((m) => m.id === c.id && m.category === c.category),
    )
  )
    throw new Error('MATRIX_UNKNOWN_CHECK');
  if (
    new Set(matrix.map((m) => m.id)).size !== matrix.length ||
    matrix.some(
      (m) =>
        !categories.includes(m.category as (typeof categories)[number]) ||
        !Number.isFinite(m.weight) ||
        m.weight <= 0,
    )
  )
    throw new Error('MATRIX_INVALID_RULES');
  const round = (n: number) => Math.round(n * 10) / 10;
  const results = Object.fromEntries(
    categories.map((category) => {
      const rules = matrix.filter((m) => m.category === category);
      const outcomes = rules.map((m) => checks.find((c) => c.id === m.id));
      if (
        !rules.length ||
        outcomes.some((c) => !c || c.status === 'UNVERIFIED')
      )
        return [category, { status: 'UNVERIFIED', score: null }];
      const score = round(
        (100 *
          rules.reduce(
            (n, m, i) => n + (outcomes[i]?.status === 'PASS' ? m.weight : 0),
            0,
          )) /
          rules.reduce((n, m) => n + m.weight, 0),
      );
      const mandatoryFailed = rules.some(
        (m, i) => m.mandatory && outcomes[i]?.status === 'FAIL',
      );
      return [
        category,
        {
          status: mandatoryFailed
            ? 'FAIL'
            : outcomes.every((c) => c?.status === 'PASS')
              ? 'PASS'
              : outcomes.every((c) => c?.status === 'FAIL')
                ? 'FAIL'
                : 'PARTIAL',
          score,
        },
      ];
    }),
  ) as Record<
    (typeof categories)[number],
    { status: string; score: number | null }
  >;
  return {
    categories: results,
    overallScore: categories.some((c) => results[c].score === null)
      ? null
      : round(categories.reduce((n, c) => n + results[c].score!, 0) / 3),
    checks,
  };
}
export const snapshotFileSchema = z
  .object({
    path: pathSchema.refine(
      (p) =>
        !/(^|\/)(?:\.env[^/]*|id_rsa|id_ed25519)$|\.(?:pem|key)$|^\.git\//i.test(
          p,
        ),
    ),
    base64: z
      .string()
      .max(56000000)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  })
  .strict();
export function validateSnapshot(raw: unknown) {
  const files = z.array(snapshotFileSchema).max(250).parse(raw);
  if (new Set(files.map((f) => f.path)).size !== files.length)
    throw new Error('MATRIX_DUPLICATE_PATH');
  if (files.reduce((n, f) => n + f.base64.length, 0) > 64000000)
    throw new Error('MATRIX_SNAPSHOT_LIMIT');
  return files;
}
