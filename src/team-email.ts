import type { Env } from './env';
import { competitionDB } from './competition-store';
import { z } from 'zod';

const teamEmailPlaceholders = new Set([
  'team_name',
  'assigned_track',
  'dashboard_link',
]);

export const teamEmailTemplateSchema = z
  .string()
  .trim()
  .min(1)
  .max(5000)
  .refine((template) => {
    const tokens = template.match(/\{\{[^{}]*\}\}/g) ?? [];
    return (
      tokens.every((token) => teamEmailPlaceholders.has(token.slice(2, -2))) &&
      !template.replace(/\{\{[^{}]*\}\}/g, '').includes('{{') &&
      !template.replace(/\{\{[^{}]*\}\}/g, '').includes('}}')
    );
  });
export const teamEmailSubjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((subject) => teamEmailTemplateSchema.safeParse(subject).success);

export function renderTeamEmailTemplate(
  template: string,
  values: Record<string, string>,
) {
  return template.replace(
    /\{\{(team_name|assigned_track|dashboard_link)\}\}/g,
    (_match, key: string) => values[key] ?? '',
  );
}

interface Recipient {
  team_id: string;
  team_name: string;
  assigned_track: string;
  email: string;
  prs: string | null;
  statuses: string | null;
  pr_count: number;
  idempotency_key?: string;
  attempts?: number;
}

const recipientDetails = `SELECT t.id AS team_id,t.name AS team_name,lower(trim(t.lead_email)) AS email,
  coalesce((SELECT g.full_name FROM team_repositories tr JOIN github_repositories g ON g.id=tr.repository_id WHERE tr.team_id=t.id AND tr.active=1 ORDER BY tr.assigned_at DESC LIMIT 1),'Unassigned') AS assigned_track,
  (SELECT group_concat(detail, ', ') FROM (
    SELECT r.full_name || '#' || ms.pr_number AS detail
    FROM matrix_submissions ms JOIN github_repositories r ON r.id=ms.repository_id
    WHERE ms.team_id=t.id AND ms.closed=0 AND ms.mapping_status='MAPPED'
    ORDER BY ms.updated_at DESC,ms.repository_id,ms.pr_number LIMIT 20
  )) AS prs,
  (SELECT group_concat(detail, ', ') FROM (
    SELECT r.full_name || '#' || ms.pr_number || ': ' || coalesce(mr.state,'UNKNOWN') AS detail
    FROM matrix_submissions ms JOIN github_repositories r ON r.id=ms.repository_id
    LEFT JOIN matrix_runs mr ON mr.id=ms.latest_run_id AND mr.repository_id=ms.repository_id AND mr.pr_number=ms.pr_number AND mr.head_sha=ms.head_sha
    WHERE ms.team_id=t.id AND ms.closed=0 AND ms.mapping_status='MAPPED'
    ORDER BY ms.updated_at DESC,ms.repository_id,ms.pr_number LIMIT 20
  )) AS statuses,
  (SELECT count(*) FROM matrix_submissions ms WHERE ms.team_id=t.id AND ms.closed=0 AND ms.mapping_status='MAPPED') AS pr_count
  FROM teams t
  WHERE t.hackathon_id='initial' AND t.status='ACTIVE'
  AND t.lead_email IS NOT NULL AND trim(t.lead_email)<>''`;

export async function dispatchTeamEmail(
  env: Env,
  now = new Date(),
  clock: () => Date = () => new Date(),
) {
  if (!env.ORG_DB || !env.TEAM_EMAIL_SENDER) return;
  const db = competitionDB(env);
  const settings = await db
    .prepare(
      "SELECT status,team_email_enabled,team_email_subject,team_email_body FROM hackathons WHERE id='initial'",
    )
    .first<{
      status: string;
      team_email_enabled: number;
      team_email_subject: string;
      team_email_body: string;
    }>();
  if (settings?.status !== 'ACTIVE' || !settings.team_email_enabled) return;

  const currentHour = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
    ),
  ).toISOString();
  const retentionStart = new Date(
    now.getTime() - 24 * 60 * 60_000,
  ).toISOString();
  const retryCutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
  const retries = await db
    .prepare(
      `SELECT d.idempotency_key,d.attempts,r.*
    FROM (${recipientDetails}) r
    JOIN team_email_deliveries d ON d.team_id=r.team_id AND d.recipient=r.email
    WHERE d.updated_at>=? AND d.attempts<5 AND (
      (d.status='FAILED' AND d.updated_at<=?) OR
      (d.status='SENDING' AND d.lease_until<=?)
    )
    ORDER BY d.updated_at,d.idempotency_key LIMIT 50`,
    )
    .bind(retentionStart, retryCutoff, now.toISOString())
    .all<Recipient>();
  const fresh = await db
    .prepare(
      `SELECT ${recipientDetails.slice(recipientDetails.indexOf('t.id AS'))}
    AND NOT EXISTS (
      SELECT 1 FROM team_email_deliveries d
      WHERE d.idempotency_key=? || ':' || t.id
        AND (d.status='SENT' OR (d.status='SENDING' AND d.lease_until>?))
    )
    AND NOT EXISTS (
      SELECT 1 FROM team_email_deliveries d
      WHERE d.team_id=t.id AND d.updated_at>=?
    )
    ORDER BY t.id LIMIT 50`,
    )
    .bind(currentHour, now.toISOString(), currentHour)
    .all<Recipient>();
  const freshOmitted =
    fresh.results.length === 50
      ? await db
          .prepare(
            `SELECT count(*) AS count FROM (${recipientDetails}) r
      WHERE NOT EXISTS (
        SELECT 1 FROM team_email_deliveries d
        WHERE d.idempotency_key=? || ':' || r.team_id
          AND (d.status='SENT' OR (d.status='SENDING' AND d.lease_until>?))
      )
      AND NOT EXISTS (
        SELECT 1 FROM team_email_deliveries d
        WHERE d.team_id=r.team_id AND d.updated_at>=?
      )`,
          )
          .bind(currentHour, now.toISOString(), currentHour)
          .first<{ count: number }>()
          .then((row) => Math.max(0, (row?.count ?? 0) - 50))
      : 0;

  for (const recipient of [...retries.results, ...fresh.results]) {
    const claimedAt = clock();
    const leaseUntil = new Date(
      claimedAt.getTime() + 10 * 60_000,
    ).toISOString();
    const idempotencyKey =
      recipient.idempotency_key ?? `${currentHour}:${recipient.team_id}`;
    const claim = await db
      .prepare(
        "INSERT INTO team_email_deliveries(idempotency_key,team_id,recipient,status,attempts,lease_until,last_error,updated_at) VALUES(?,?,?,'SENDING',1,?,NULL,?) ON CONFLICT(idempotency_key) DO UPDATE SET status='SENDING',attempts=team_email_deliveries.attempts+1,lease_until=excluded.lease_until,last_error=NULL,updated_at=excluded.updated_at WHERE team_email_deliveries.attempts<5 AND (team_email_deliveries.status='FAILED' OR (team_email_deliveries.status='SENDING' AND team_email_deliveries.lease_until<=excluded.updated_at))",
      )
      .bind(
        idempotencyKey,
        recipient.team_id,
        recipient.email,
        leaseUntil,
        claimedAt.toISOString(),
      )
      .run();
    if (!claim.meta.changes) continue;

    const eligible = await db
      .prepare(
        "SELECT 1 FROM hackathons h JOIN teams t ON t.hackathon_id=h.id WHERE h.id='initial' AND h.status='ACTIVE' AND h.team_email_enabled=1 AND t.id=? AND t.status='ACTIVE' AND lower(trim(t.lead_email))=?",
      )
      .bind(recipient.team_id, recipient.email)
      .first();
    if (!eligible) {
      await db
        .prepare(
          "UPDATE team_email_deliveries SET status='FAILED',lease_until=NULL,last_error='RECIPIENT_INELIGIBLE',updated_at=? WHERE idempotency_key=? AND status='SENDING'",
        )
        .bind(clock().toISOString(), idempotencyKey)
        .run();
      continue;
    }
    const dashboardLink = `${env.ORG_PUBLIC_ORIGIN ?? ''}/`;
    const configuredBody = renderTeamEmailTemplate(settings.team_email_body, {
      team_name: recipient.team_name,
      assigned_track: recipient.assigned_track,
      dashboard_link: dashboardLink,
    });
    const body = [
      configuredBody,
      `Pull requests: ${recipient.prs ?? 'NONE'}${
        recipient.pr_count > 20
          ? `\nPull request details truncated (${
              recipient.pr_count - 20
            } omitted)`
          : ''
      }`,
      `Pull request status: ${recipient.statuses ?? 'NO_SUBMISSION'}${
        recipient.pr_count > 20
          ? `\nPull request statuses truncated (${
              recipient.pr_count - 20
            } omitted)`
          : ''
      }`,
      ...(freshOmitted
        ? [`Recipient batch truncated (${freshOmitted} omitted)`]
        : []),
    ]
      .filter(Boolean)
      .join('\n');
    const messageBody =
      body.length > 12000
        ? body.slice(0, 11980) + '\n[Message truncated]'
        : body;
    try {
      const response = await env.TEAM_EMAIL_SENDER.fetch(
        new Request('https://team-email-sender.internal/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey,
            to: recipient.email,
            subject: renderTeamEmailTemplate(settings.team_email_subject, {
              team_name: recipient.team_name,
              assigned_track: recipient.assigned_track,
              dashboard_link: dashboardLink,
            }),
            body: messageBody,
          }),
        }),
      );
      if (!response.ok) throw new Error('EMAIL_SENDER_REJECTED');
      await db
        .prepare(
          "UPDATE team_email_deliveries SET status='SENT',lease_until=NULL,last_error=NULL,updated_at=? WHERE idempotency_key=? AND status='SENDING'",
        )
        .bind(clock().toISOString(), idempotencyKey)
        .run();
    } catch {
      await db
        .prepare(
          "UPDATE team_email_deliveries SET status='FAILED',lease_until=NULL,last_error='EMAIL_SENDER_REJECTED',updated_at=? WHERE idempotency_key=? AND status='SENDING'",
        )
        .bind(clock().toISOString(), idempotencyKey)
        .run();
    }
  }
}
