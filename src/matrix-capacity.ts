export async function acquireMatrixSlot(
  db: D1Database,
  repository: string,
  owner: string,
  now = Date.now(),
) {
  for (let index = 0; index < 2; index++) {
    const slot = repository + ':' + index;
    const result = await db
      .prepare(
        'INSERT INTO matrix_capacity(slot,owner,expires_ms) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM matrix_capacity WHERE expires_ms>=?)<4 ON CONFLICT(slot) DO UPDATE SET owner=excluded.owner,expires_ms=excluded.expires_ms WHERE matrix_capacity.expires_ms<?',
      )
      .bind(slot, owner, now + 180000, now, now)
      .run();
    if (result.meta.changes) return slot;
  }
  throw new Error('MATRIX_BUSY');
}
export async function releaseMatrixSlot(
  db: D1Database,
  slot: string,
  owner: string,
) {
  await db
    .prepare('DELETE FROM matrix_capacity WHERE slot=? AND owner=?')
    .bind(slot, owner)
    .run();
}
