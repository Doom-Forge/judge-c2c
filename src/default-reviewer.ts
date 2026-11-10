import type { GitHub } from './github';
type User = { login: string; type?: string };
export const copilotReviewers = (users: User[]) =>
  users
    .filter((u) => u.type === 'Bot' && /^copilot(?:$|[-\[])/i.test(u.login))
    .map((u) => u.login);
export async function ensureDefaultReviewer(
  db: D1Database,
  github: Pick<GitHub, 'api'>,
  run: { repository_id: number; full_name: string; pr_number: number },
  reviewer: string,
  now = Date.now(),
) {
  const args = [run.repository_id, run.pr_number, reviewer];
  await db
    .prepare(
      'INSERT OR IGNORE INTO matrix_default_reviewers(repository_id,pr_number,reviewer) VALUES(?,?,?)',
    )
    .bind(...args)
    .run();
  const owner = crypto.randomUUID();
  const claim = await db
    .prepare(
      "UPDATE matrix_default_reviewers SET lease_owner=?,lease_until=? WHERE repository_id=? AND pr_number=? AND reviewer=? AND status='PENDING' AND lease_until<=?",
    )
    .bind(owner, now + 300000, ...args, now)
    .run();
  if (!claim.meta.changes) return;
  const base = `/repos/${run.full_name}/pulls/${run.pr_number}`;
  try {
    const pr = await github.api<{ state: string; draft?: boolean; user: User }>(
      base,
    );
    if (pr.state !== 'open') return;
    const requested = await github.api<{ users: User[] }>(
      base + '/requested_reviewers?per_page=100',
    );
    if (requested.users.length >= 100) throw new Error('REVIEWER_SCAN_LIMIT');
    const copilot = copilotReviewers(requested.users);
    if (copilot.length)
      await github.api(base + '/requested_reviewers', {
        method: 'DELETE',
        body: JSON.stringify({ reviewers: copilot }),
      });
    let status = 'DONE';
    if (pr.user.login.toLowerCase() === reviewer.toLowerCase()) status = 'SELF';
    else if (
      !requested.users.some(
        (u) => u.login.toLowerCase() === reviewer.toLowerCase(),
      )
    ) {
      let reviewed = false;
      for (let page = 1; page <= 10; page++) {
        const reviews = await github.api<{ user: User | null }[]>(
          base + `/reviews?per_page=100&page=${page}`,
        );
        if (
          reviews.some(
            (r) => r.user?.login.toLowerCase() === reviewer.toLowerCase(),
          )
        ) {
          reviewed = true;
          break;
        }
        if (reviews.length < 100) break;
        if (page === 10) throw new Error('REVIEWER_SCAN_LIMIT');
      }
      if (!reviewed) {
        if (pr.draft) throw new Error('REVIEWER_DRAFT');
        await github.api(base + '/requested_reviewers', {
          method: 'POST',
          body: JSON.stringify({ reviewers: [reviewer] }),
        });
      }
    }
    await db
      .prepare(
        'UPDATE matrix_default_reviewers SET status=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE repository_id=? AND pr_number=? AND reviewer=? AND lease_owner=?',
      )
      .bind(status, ...args, owner)
      .run();
  } catch (error) {
    const code =
      error instanceof Error &&
      ['REVIEWER_SCAN_LIMIT', 'REVIEWER_DRAFT'].includes(error.message)
        ? error.message
        : 'REVIEWER_UNAVAILABLE';
    await db
      .prepare(
        'UPDATE matrix_default_reviewers SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE repository_id=? AND pr_number=? AND reviewer=? AND lease_owner=?',
      )
      .bind(code, ...args, owner)
      .run();
  } finally {
    await db
      .prepare(
        'UPDATE matrix_default_reviewers SET lease_owner=NULL,lease_until=0 WHERE repository_id=? AND pr_number=? AND reviewer=? AND lease_owner=?',
      )
      .bind(...args, owner)
      .run();
  }
}
