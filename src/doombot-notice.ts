import { digest } from './domain';
import type { GitHub } from './github';

const marker = '<!-- doombot-evaluating-v1 -->';
export const doombotNoticeBody = (origin: string) =>
  `<img src="${origin.replace(/\/$/, '')}/doombot-avatar.png" width="80" height="80" alt="DoomBot" />\n\n**DoomBot is evaluating your PR.**\n\n${marker}`;
type Notice = { comment_id: number | null; body_hash: string | null };
type Comment = {
  id: number;
  body: string;
  user: { login: string; type: string };
};
// A lease plus authenticated bot marker reconciliation recovers ambiguous POSTs.
export async function ensureDoomBotNotice(
  db: D1Database,
  github: Pick<GitHub, 'api'>,
  run: { repository_id: number; full_name: string; pr_number: number },
  origin: string,
  botLogin: string,
  now = Date.now(),
) {
  const body = doombotNoticeBody(origin),
    hash = await digest(body);
  const args = [run.repository_id, run.pr_number];
  await db
    .prepare(
      'INSERT OR IGNORE INTO matrix_doombot_notices(repository_id,pr_number) VALUES(?,?)',
    )
    .bind(...args)
    .run();
  const owner = crypto.randomUUID();
  const claim = await db
    .prepare(
      'UPDATE matrix_doombot_notices SET lease_owner=?,lease_until=? WHERE repository_id=? AND pr_number=? AND lease_until<=?',
    )
    .bind(owner, now + 300000, ...args, now)
    .run();
  if (!claim.meta.changes) return;
  try {
    const row = await db
      .prepare(
        'SELECT comment_id,body_hash FROM matrix_doombot_notices WHERE repository_id=? AND pr_number=?',
      )
      .bind(...args)
      .first<Notice>();
    if (row?.comment_id && row.body_hash === hash) return;
    let comment: Comment | undefined;
    // Inspect every page: a participant cannot claim the bot's stable marker.
    for (let page = 1; page <= 10; page++) {
      const comments = await github.api<Comment[]>(
        `/repos/${run.full_name}/issues/${run.pr_number}/comments?per_page=100&page=${page}`,
      );
      comment = comments.find(
        (c) =>
          c.user.type === 'Bot' &&
          c.user.login === botLogin &&
          c.body.includes(marker),
      );
      if (comment || comments.length < 100) break;
      if (page === 10) throw new Error('NOTICE_SCAN_LIMIT');
    }
    if (comment && comment.body !== body)
      await github.api(
        `/repos/${run.full_name}/issues/comments/${comment.id}`,
        { method: 'PATCH', body: JSON.stringify({ body }) },
      );
    if (!comment)
      comment = await github.api<Comment>(
        `/repos/${run.full_name}/issues/${run.pr_number}/comments`,
        { method: 'POST', body: JSON.stringify({ body }) },
      );
    await db
      .prepare(
        'UPDATE matrix_doombot_notices SET comment_id=?,body_hash=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE repository_id=? AND pr_number=? AND lease_owner=?',
      )
      .bind(comment.id, hash, ...args, owner)
      .run();
  } catch (error) {
    const code =
      error instanceof Error && error.message === 'NOTICE_SCAN_LIMIT'
        ? 'NOTICE_SCAN_LIMIT'
        : 'NOTICE_UNAVAILABLE';
    await db
      .prepare(
        'UPDATE matrix_doombot_notices SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE repository_id=? AND pr_number=? AND lease_owner=?',
      )
      .bind(code, ...args, owner)
      .run();
  } finally {
    await db
      .prepare(
        'UPDATE matrix_doombot_notices SET lease_owner=NULL,lease_until=0 WHERE repository_id=? AND pr_number=? AND lease_owner=?',
      )
      .bind(...args, owner)
      .run();
  }
}
