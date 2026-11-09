import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import type { Env } from '../src/env';
import { dispatchTeamEmail } from '../src/team-email';
import worker from '../src/index';
import { competition } from '../src/competition';

let mf: Miniflare;
let env: Env;
let db: D1Database;
const sent: { key: string; to: string; subject: string; body: string }[] = [];
let failRecipients = new Set<string>();

beforeEach(async () => {
  sent.length = 0;
  failRecipients = new Set();
  mf = new Miniflare({
    modules: true,
    script: 'export default{}',
    d1Databases: ['DB', 'ORG_DB'],
    compatibilityDate: '2026-08-01',
  });
  db = (await mf.getD1Database('ORG_DB')) as unknown as D1Database;
  await migrate(db);
  await db
    .prepare(
      "UPDATE hackathons SET name='Pilot',status='ACTIVE' WHERE id='initial'",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO teams(id,name,hackathon_id,status,lead_email) VALUES('team-a','Alpha','initial','ACTIVE','alpha-lead@example.test'),('team-b','Beta','initial','ACTIVE','beta-lead@example.test')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO team_members(id,team_id,hackathon_id,github_id,github_login,display_name,email,active) VALUES('member-a','team-a','initial',1,'alpha','Alpha',' Alpha@Example.Test ',1),('member-a2','team-a','initial',3,'alpha-two','Alpha Two','alpha-two@example.test',1),('member-b','team-b','initial',2,'beta','Beta','beta@example.test',1)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(1,'shared/solution-a',0,'main'),(2,'shared/solution-b',0,'main')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',1,'organizer:test'),('team-b',2,'organizer:test')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO matrix_runs(id,repository_id,full_name,pr_number,head_sha,baseline_sha,matrix_version,matrix_digest,image_uri,state) VALUES('run-a',1,'shared/solution-a',17,?,?,?,?,?,'COMPLETED'),('old-a',1,'shared/solution-a',17,?,?,?,?,?,'SUPERSEDED'),('run-b',2,'shared/solution-b',28,?,?,?,?,?,'RUNNING')",
    )
    .bind(
      'b'.repeat(40),
      'a'.repeat(40),
      'pilot-v1',
      'c'.repeat(64),
      'fixture',
      'b'.repeat(40),
      'a'.repeat(40),
      'pilot-v1',
      'c'.repeat(64),
      'fixture',
      'd'.repeat(40),
      'a'.repeat(40),
      'pilot-v1',
      'c'.repeat(64),
      'fixture',
    )
    .run();
  await db
    .prepare(
      "INSERT INTO matrix_submissions(repository_id,pr_number,head_sha,updated_at,closed,latest_run_id,team_id,mapping_status) VALUES(1,17,?,'2026-11-08T10:00:00Z',0,'run-a','team-a','MAPPED'),(2,28,?,'2026-11-08T10:00:00Z',0,'run-b','team-b','MAPPED'),(1,99,?,'2026-11-08T10:00:00Z',0,'run-a','team-b','MAPPED')",
    )
    .bind('b'.repeat(40), 'd'.repeat(40), 'e'.repeat(40))
    .run();
  env = {
    DB: (await mf.getD1Database('DB')) as unknown as D1Database,
    ORG_DB: db,
    TEAM_EMAIL_SENDER: {
      fetch: async (request: RequestInfo | URL) => {
        const payload = (await new Request(request).json()) as {
          idempotencyKey: string;
          to: string;
          subject: string;
          body: string;
        };
        if (failRecipients.has(payload.to)) {
          return new Response('provider-secret-detail', {
            status: 503,
          });
        }
        sent.push({
          key: payload.idempotencyKey,
          to: payload.to,
          subject: payload.subject,
          body: payload.body,
        });
        return Response.json({ accepted: true });
      },
    },
    ORG_PUBLIC_ORIGIN: 'https://judge.test',
  } as unknown as Env;
});

afterEach(async () => mf.dispose());

describe('hourly matrix team email', () => {
  it('reports sender configuration and refuses opt-in before a sender is bound', async () => {
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;
    const get = await competition(
      new Request('https://judge.test/api/organization/manage/team-email'),
      { ...env, TEAM_EMAIL_SENDER: undefined },
      ctx,
      {} as never,
      'organizer:test',
    );
    expect(await get.json()).toMatchObject({
      enabled: false,
      senderConfigured: false,
    });
    const post = await competition(
      new Request('https://judge.test/api/organization/manage/team-email', {
        method: 'POST',
        body: JSON.stringify({ enabled: true }),
      }),
      { ...env, TEAM_EMAIL_SENDER: undefined },
      ctx,
      {} as never,
      'organizer:test',
    );
    expect(post.status).toBe(409);
  });

  it('routes the exact matrix-mode manager endpoint through cookie authorization', async () => {
    const organizerToken = 'organizer-token-' + 'a'.repeat(40);
    const judgeToken = 'judge-token-' + 'b'.repeat(40);
    const integrationEnv = {
      ...env,
      MATRIX_MODE: 'true',
      ORG_ADMIN_TOKEN: organizerToken,
      ORG_JUDGE_TOKEN: judgeToken,
      ORG_VAULT_KEY: '12'.repeat(32),
      ORG_NAME: 'Pilot',
    } as Env;
    const sessionEnv = { ...integrationEnv, MATRIX_MODE: undefined };
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;
    const login = async (token: string) => {
      const response = await worker.fetch(
        new Request('https://judge.test/api/organization/login', {
          method: 'POST',
          headers: { origin: 'https://judge.test' },
          body: JSON.stringify({ token }),
        }),
        sessionEnv,
        ctx,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return response.headers.get('set-cookie')!.split(';')[0]!;
    };
    const organizerCookie = await login(organizerToken);
    const created = await worker.fetch(
      new Request('https://judge.test/api/organization/identities', {
        method: 'POST',
        headers: {
          cookie: organizerCookie,
          origin: 'https://judge.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Participant',
          role: 'participant',
          teamId: 'team-a',
        }),
      }),
      sessionEnv,
      ctx,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const participantCredential = (
      (await created.json()) as {
        credential: string;
      }
    ).credential;
    const [judgeCookie, participantCookie] = await Promise.all([
      login(judgeToken),
      login(participantCredential),
    ]);
    const manager = 'https://judge.test/api/organization/manage/team-email';
    const get = await worker.fetch(
      new Request(manager, { headers: { cookie: organizerCookie } }),
      integrationEnv,
      ctx,
    );
    expect(get.status).toBe(200);
    expect(await get.clone().json()).toMatchObject({
      senderConfigured: true,
      subject: expect.any(String),
      body: expect.any(String),
      lastDelivery: null,
      recentDeliveries: [],
    });
    const post = await worker.fetch(
      new Request(manager, {
        method: 'POST',
        headers: {
          cookie: organizerCookie,
          origin: 'https://judge.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          enabled: true,
          subject: 'Doomforge update for {{team_name}}',
          body: 'Track: {{assigned_track}}. Dashboard: {{dashboard_link}}',
        }),
      }),
      integrationEnv,
      ctx,
    );
    expect(post.status).toBe(200);
    expect(await post.clone().json()).toMatchObject({
      enabled: true,
      subject: 'Doomforge update for {{team_name}}',
      body: 'Track: {{assigned_track}}. Dashboard: {{dashboard_link}}',
    });
    const invalidTemplate = await worker.fetch(
      new Request(manager, {
        method: 'POST',
        headers: {
          cookie: organizerCookie,
          origin: 'https://judge.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body: 'Score: {{team_score}}' }),
      }),
      integrationEnv,
      ctx,
    );
    expect(invalidTemplate.status).toBe(400);
    for (const cookie of [judgeCookie, participantCookie]) {
      const rejected = await worker.fetch(
        new Request(manager, {
          method: 'POST',
          headers: {
            cookie,
            origin: 'https://judge.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ enabled: false }),
        }),
        integrationEnv,
        ctx,
      );
      expect(rejected.status).toBe(403);
    }
    expect(
      (
        await worker.fetch(
          new Request('https://judge.test/api/not-matrix-or-manager'),
          integrationEnv,
          ctx,
        )
      ).status,
    ).toBe(404);
  });

  it('defaults disabled and does not send for an inactive event', async () => {
    expect(
      await db
        .prepare("SELECT team_email_enabled FROM hackathons WHERE id='initial'")
        .first('team_email_enabled'),
    ).toBe(0);
    await dispatchTeamEmail(
      { ...env, TEAM_EMAIL_SENDER: undefined },
      new Date('2026-11-08T14:22:00Z'),
    );
    expect(sent).toHaveLength(0);
    await db
      .prepare(
        "UPDATE hackathons SET team_email_enabled=1,status='PAUSED' WHERE id='initial'",
      )
      .run();
    await dispatchTeamEmail(
      env,
      new Date('2026-11-08T14:22:00Z'),
      () => new Date('2026-11-08T14:22:00Z'),
    );
    expect(sent).toHaveLength(0);
  });

  it('does not send without a sender, including from the matrix scheduler', async () => {
    await db
      .prepare("UPDATE hackathons SET team_email_enabled=1 WHERE id='initial'")
      .run();
    await dispatchTeamEmail(
      { ...env, TEAM_EMAIL_SENDER: undefined },
      new Date('2026-11-08T14:22:00Z'),
    );
    expect(sent).toHaveLength(0);
    let scheduled = false;
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        scheduled = true;
        pending.push(promise);
      },
    } as ExecutionContext;
    await worker.scheduled!(
      {} as ScheduledController,
      {
        ...env,
        MATRIX_MODE: 'true',
        ORG_PUBLIC_ORIGIN: undefined,
      },
      ctx,
    );
    await Promise.allSettled(pending);
    expect(scheduled).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('sends only current team-scoped Matrix PRs without marks and suppresses persisted SENT deliveries', async () => {
    await db
      .prepare(
        "UPDATE hackathons SET team_email_enabled=1,team_email_subject=?,team_email_body=? WHERE id='initial'",
      )
      .bind(
        'Round 2 update: {{team_name}}',
        'Team {{team_name}} uses {{assigned_track}}. See {{dashboard_link}}',
      )
      .run();
    const now = new Date('2026-11-08T14:22:00Z');
    await dispatchTeamEmail(env, now);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.to).toBe('alpha-lead@example.test');
    expect(sent[0]!.key).toBe('2026-11-08T14:00:00.000Z:team-a');
    expect(sent[0]!.subject).toBe('Round 2 update: Alpha');
    expect(sent[0]!.body).toContain('Team Alpha uses shared/solution-a.');
    expect(sent[0]!.body).toContain('https://judge.test/');
    expect(sent.some((row) => row.to === 'alpha-two@example.test')).toBe(false);
    expect(sent[0]!.body).toContain('shared/solution-a#17');
    expect(sent[0]!.body).toContain('COMPLETED');
    expect(sent[0]!.body).not.toContain('shared/solution-a#99');
    expect(sent[0]!.body.toLowerCase()).not.toMatch(/score|mark/);
    await dispatchTeamEmail(env, new Date('2026-11-08T14:48:00Z'));
    expect(sent).toHaveLength(2);
  });

  it('bounds recipients, PR details, and message length while marking truncated details', async () => {
    await db
      .prepare("UPDATE hackathons SET team_email_enabled=1 WHERE id='initial'")
      .run();
    for (let i = 0; i < 300; i++) {
      await db
        .prepare(
          "INSERT INTO matrix_submissions(repository_id,pr_number,head_sha,updated_at,closed,latest_run_id,team_id,mapping_status) VALUES(1,?,?,?,0,'run-a','team-a','MAPPED')",
        )
        .bind(1000 + i, 'f'.repeat(40), '2026-11-08T10:00:00Z')
        .run();
    }
    for (let i = 0; i < 101; i++) {
      await db
        .prepare(
          "INSERT INTO teams(id,name,hackathon_id,status,lead_email) VALUES(?,?,'initial','ACTIVE',?)",
        )
        .bind(
          `team-batch-${i.toString().padStart(3, '0')}`,
          `Batch team ${i}`,
          `batch-lead-${i}@example.test`,
        )
        .run();
    }
    await dispatchTeamEmail(env, new Date('2026-11-08T14:22:00Z'));
    const firstBatchSize = sent.length;
    expect(firstBatchSize).toBeGreaterThan(0);
    expect(firstBatchSize).toBeLessThan(103);
    const alpha = sent.find((row) => row.to === 'alpha-lead@example.test')!;
    expect(alpha.body.length).toBeLessThanOrEqual(12000);
    expect(alpha.body).toContain('Pull request details truncated');
    expect(alpha.body).toContain('Recipient batch truncated');
    for (let attempt = 0; attempt < 5 && sent.length < 103; attempt++) {
      await dispatchTeamEmail(env, new Date('2026-11-08T14:22:00Z'));
    }
    expect(sent).toHaveLength(103);
  });

  it('excludes closed and unmapped Matrix PRs while retaining mapped open PRs', async () => {
    await db
      .prepare("UPDATE hackathons SET team_email_enabled=1 WHERE id='initial'")
      .run();
    await db
      .prepare(
        'UPDATE matrix_submissions SET closed=1 WHERE repository_id=2 AND pr_number=28',
      )
      .run();
    await db
      .prepare(
        "UPDATE matrix_submissions SET team_id='team-a',mapping_status='MEMBER_NOT_REGISTERED' WHERE repository_id=1 AND pr_number=99",
      )
      .run();

    await dispatchTeamEmail(env, new Date('2026-11-08T14:22:00Z'));

    expect(
      sent.find((row) => row.to === 'alpha-lead@example.test')?.body,
    ).toContain('shared/solution-a#17');
    expect(
      sent.find((row) => row.to === 'alpha-lead@example.test')?.body,
    ).not.toContain('#99');
    expect(
      sent.find((row) => row.to === 'beta-lead@example.test')?.body,
    ).toContain('Pull requests: NONE');
    expect(
      sent.find((row) => row.to === 'beta-lead@example.test')?.body,
    ).not.toContain('#28');
  });

  it('continues after one provider failure and permits a later retry', async () => {
    await db
      .prepare("UPDATE hackathons SET team_email_enabled=1 WHERE id='initial'")
      .run();
    failRecipients.add('alpha-lead@example.test');
    await dispatchTeamEmail(
      env,
      new Date('2026-11-08T14:22:00Z'),
      () => new Date('2026-11-08T14:22:00Z'),
    );
    expect(sent.map((row) => row.to)).toEqual(['beta-lead@example.test']);
    expect(
      await db
        .prepare(
          "SELECT status,last_error,attempts FROM team_email_deliveries WHERE team_id='team-a'",
        )
        .first(),
    ).toMatchObject({
      status: 'FAILED',
      last_error: 'EMAIL_SENDER_REJECTED',
      attempts: 1,
    });
    failRecipients.clear();
    await dispatchTeamEmail(
      env,
      new Date('2026-11-08T14:30:00Z'),
      () => new Date('2026-11-08T14:30:00Z'),
    );
    expect(sent.map((row) => row.to)).toEqual([
      'beta-lead@example.test',
      'alpha-lead@example.test',
    ]);
  });

  it('recovers a prior-hour failure with its original key and a bounded attempt count', async () => {
    await db
      .prepare("UPDATE hackathons SET team_email_enabled=1 WHERE id='initial'")
      .run();
    const originalKey = '2026-11-08T13:00:00.000Z:team-a';
    await db
      .prepare(
		"INSERT INTO team_email_deliveries(idempotency_key,team_id,recipient,status,attempts,updated_at) VALUES(?, 'team-a','alpha-lead@example.test','FAILED',1,'2026-11-08T13:50:00.000Z')",
      )
      .bind(originalKey)
      .run();
    await dispatchTeamEmail(
      env,
      new Date('2026-11-08T14:22:00Z'),
      () => new Date('2026-11-08T14:22:00Z'),
    );
    expect(sent.find((row) => row.to === 'alpha-lead@example.test')?.key).toBe(
      originalKey,
    );
    await db
      .prepare(
        "UPDATE team_email_deliveries SET status='FAILED',attempts=5 WHERE idempotency_key=?",
      )
      .bind(originalKey)
      .run();
    await dispatchTeamEmail(env, new Date('2026-11-08T14:30:00Z'));
    expect(sent.filter((row) => row.key === originalKey)).toHaveLength(1);
  });

  it('skips later recipients after the organizer disables email in flight', async () => {
    await db
      .prepare("UPDATE hackathons SET team_email_enabled=1 WHERE id='initial'")
      .run();
    const original = env.TEAM_EMAIL_SENDER!;
    env.TEAM_EMAIL_SENDER = {
      fetch: async (request) => {
        await db
          .prepare(
            "UPDATE hackathons SET team_email_enabled=0 WHERE id='initial'",
          )
          .run();
        return original.fetch(request);
      },
    } as Fetcher;
    await dispatchTeamEmail(env, new Date('2026-11-08T14:22:00Z'));
    expect(sent.map((row) => row.to)).toEqual(['alpha-lead@example.test']);
  });

  it('reclaims an expired SENDING lease but skips a live lease', async () => {
    await db
      .prepare("UPDATE hackathons SET team_email_enabled=1 WHERE id='initial'")
      .run();
    await db
      .prepare(
        "INSERT INTO team_email_deliveries(idempotency_key,team_id,recipient,status,attempts,lease_until) VALUES('2026-11-08T14:00:00.000Z:team-a','team-a','alpha-lead@example.test','SENDING',1,'2026-11-08T14:10:00.000Z'),('2026-11-08T14:00:00.000Z:team-b','team-b','beta-lead@example.test','SENDING',1,'2026-11-08T14:30:00.000Z')",
      )
      .run();
    await dispatchTeamEmail(
      env,
      new Date('2026-11-08T14:22:00Z'),
      () => new Date('2026-11-08T14:22:00Z'),
    );
    expect(sent.map((row) => row.to)).toEqual(['alpha-lead@example.test']);
  });

  it('claims each recipient with a fresh lease after a slow earlier send', async () => {
    await db
      .prepare("UPDATE hackathons SET team_email_enabled=1 WHERE id='initial'")
      .run();
    let clock = new Date('2026-11-08T14:22:00Z');
    const original = env.TEAM_EMAIL_SENDER!;
    let laterClaim: { lease_until: string; updated_at: string } | null = null;
    let releaseLaterSend!: () => void;
    const laterSendBarrier = new Promise<void>((resolve) => {
      releaseLaterSend = resolve;
    });
    let claimedLater!: () => void;
    const laterClaimed = new Promise<void>((resolve) => {
      claimedLater = resolve;
    });
    env.TEAM_EMAIL_SENDER = {
      fetch: async (request) => {
        if (clock.toISOString() === '2026-11-08T14:22:00.000Z') {
          clock = new Date('2026-11-08T14:40:00Z');
        } else {
          laterClaim = await db
            .prepare(
              "SELECT lease_until,updated_at FROM team_email_deliveries WHERE team_id='team-b'",
            )
            .first<{ lease_until: string; updated_at: string }>();
          claimedLater();
          await laterSendBarrier;
        }
        return original.fetch(request);
      },
    } as Fetcher;

    const dispatch = dispatchTeamEmail(env, clock, () => clock);
    await laterClaimed;

    expect(laterClaim).toEqual({
      lease_until: '2026-11-08T14:50:00.000Z',
      updated_at: '2026-11-08T14:40:00.000Z',
    });
    clock = new Date('2026-11-08T14:49:00Z');
    await dispatchTeamEmail(env, clock, () => clock);
    releaseLaterSend();
    await dispatch;
    expect(
      sent.filter((row) => row.to === 'beta-lead@example.test'),
    ).toHaveLength(1);
  });

  it('uses persistent, exclusive delivery claims under simultaneous dispatch', async () => {
    await db
      .prepare("UPDATE hackathons SET team_email_enabled=1 WHERE id='initial'")
      .run();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const original = env.TEAM_EMAIL_SENDER!;
    env.TEAM_EMAIL_SENDER = {
      fetch: async (request) => {
        entered++;
        if (entered === 1) await barrier;
        return original.fetch(request);
      },
    } as Fetcher;
    const first = dispatchTeamEmail(env, new Date('2026-11-08T14:22:00Z'));
    while (entered === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(
      await db
        .prepare(
          "SELECT status,attempts FROM team_email_deliveries WHERE team_id='team-a'",
        )
        .first(),
    ).toMatchObject({ status: 'SENDING', attempts: 1 });
    const second = dispatchTeamEmail(env, new Date('2026-11-08T14:22:00Z'));
    release();
    await Promise.all([first, second]);
    expect(sent).toHaveLength(2);
  });
});
