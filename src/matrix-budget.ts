import type { Env } from './env';
type Settings = Pick<Env, 'MATRIX_START_LIMIT'>;
const windowMs = 31 * 86400000;
function limit(env: Settings) {
  const raw = env.MATRIX_START_LIMIT ?? '80';
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 80)
    throw new Error('MATRIX_INVALID_BUDGET_CONFIG');
  return Number(raw);
}
export async function reserveMatrixStart(
  db: D1Database,
  env: Settings,
  owner: string,
  now = Date.now(),
) {
  const cap = limit(env);
  const result = await db
    .prepare(
      'INSERT INTO matrix_start_reservations(owner,reserved_ms,reserved_seconds) SELECT ?,?,180 WHERE (SELECT COUNT(*) FROM matrix_start_reservations WHERE reserved_ms>=?)<?',
    )
    .bind(owner, now, now - windowMs, cap)
    .run();
  if (!result.meta.changes) throw new Error('MATRIX_BUDGET_LIMIT');
}
export async function matrixBudget(
  db: D1Database,
  env: Settings,
  now = Date.now(),
) {
  const cap = limit(env);
  const count =
    (await db
      .prepare(
        'SELECT COUNT(*) AS count FROM matrix_start_reservations WHERE reserved_ms>=?',
      )
      .bind(now - windowMs)
      .first<number>('count')) ?? 0;
  return {
    windowDays: 31,
    startLimit: cap,
    startsReserved: count,
    startsRemaining: Math.max(0, cap - count),
    secondsPerStart: 180,
    reservedSeconds: count * 180,
    globalConcurrencyLimit: 4,
    repositoryConcurrencyLimit: 2,
    instanceType: 'basic',
    accounting: 'application_reservations_not_cloudflare_bill',
  };
}
