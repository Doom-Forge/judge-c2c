import { matrixBudget } from './matrix-budget';
import { isMatrixOriginAllowed } from './matrix-cors';
import { z } from 'zod';
import { canonical, digest, sha } from './domain';
import { equalSecret, boundedBody } from './security';
import {
  matrixRepositoryStatus,
  specificationRequiredRepositories,
  validateSnapshot,
} from './matrix';
import { organizationEnv } from './organization';
import { GitHub } from './github';
import type { Contract } from './domain';
import type { Env } from './env';

export type MatrixRun = {
  id: string;
  repository_id: number;
  full_name: string;
  pr_number: number;
  head_sha: string;
  baseline_sha: string;
  matrix_version: string;
  matrix_digest: string;
  image_uri: string;
  attempt: number;
  state: string;
  report: string | null;
  failure_code: string | null;
  check_run_id: number | null;
  publication_status: string;
  created_at: string;
};
const eventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({
    id: z.number().int().positive(),
    full_name: z.string(),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    head: z.object({ sha }),
    base: z.object({ repo: z.object({ id: z.number().int().positive() }) }),
    updated_at: z.string().datetime(),
    state: z.enum(['open', 'closed']),
  }),
});
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const dbFor = (env: Env) => env.ORG_DB ?? env.DB;
export async function dispatchMatrix(env: Env, id: string) {
  if (!env.MATRIX_EVALUATOR) throw new Error('MATRIX_WORKFLOW_NOT_CONFIGURED');
  try {
    await env.MATRIX_EVALUATOR.create({ id, params: { runId: id } });
  } catch (error) {
    try {
      const existing = await env.MATRIX_EVALUATOR.get(id);
      await existing.status();
    } catch {
      throw error;
    }
  }
}
export async function acceptMatrixPR(
  raw: unknown,
  env: Env,
  delivery: string,
  payloadHash: string,
  resolvePR?: () => Promise<{
    head: { sha: string };
    state: 'open' | 'closed';
    updated_at: string;
  }>,
) {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return json({ error: 'INVALID_PAYLOAD' }, 400);
  const p = parsed.data,
    pr = p.pull_request,
    db = dbFor(env);
  if (
    ![
      'opened',
      'synchronize',
      'reopened',
      'closed',
      'ready_for_review',
    ].includes(p.action)
  )
    return json({ status: 'ignored' }, 202);
  if (
    specificationRequiredRepositories.includes(
      p.repository
        .full_name as (typeof specificationRequiredRepositories)[number],
    )
  )
    return json({ error: 'CHALLENGE_SPECIFICATION_REQUIRED' }, 403);
  const repo = await db
    .prepare(
      'SELECT m.*,g.accessible,c.installation_id FROM matrix_repositories m JOIN github_repositories g ON g.id=m.repository_id CROSS JOIN github_connection c WHERE m.repository_id=? AND m.full_name=? AND c.id=1',
    )
    .bind(p.repository.id, p.repository.full_name)
    .first<{
      repository_id: number;
      full_name: string;
      baseline_sha: string;
      matrix_version: string;
      matrix_digest: string;
      image_uri: string;
      accessible: number;
      installation_id: number;
    }>();
  if (
    !repo ||
    !repo.accessible ||
    repo.installation_id !== p.installation.id ||
    pr.base.repo.id !== repo.repository_id
  )
    return json({ error: 'REPOSITORY_NOT_SELECTED' }, 403);
  const previous = await db
    .prepare('SELECT payload_hash FROM matrix_deliveries WHERE id=?')
    .bind(delivery)
    .first<{ payload_hash: string }>();
  if (previous && previous.payload_hash !== payloadHash)
    return json({ error: 'DELIVERY_CONFLICT' }, 409);
  const current = await db
    .prepare(
      'SELECT * FROM matrix_submissions WHERE repository_id=? AND pr_number=?',
    )
    .bind(repo.repository_id, pr.number)
    .first<{
      updated_at: string;
      head_sha: string;
      latest_run_id: string;
      closed: number;
    }>();
  if (previous) {
    if (current) {
      const queued = await db
        .prepare("SELECT id FROM matrix_runs WHERE id=? AND state='QUEUED'")
        .bind(current.latest_run_id)
        .first();
      if (queued) await dispatchMatrix(env, current.latest_run_id);
    }
    return json({ status: 'duplicate' });
  }
  if (
    current &&
    current.updated_at === pr.updated_at &&
    (current.head_sha !== pr.head.sha ||
      !!current.closed !== (pr.state === 'closed'))
  ) {
    const live = await (resolvePR
      ? resolvePR()
      : (async () => {
          const github = await GitHub.installation(await organizationEnv(env), {
            repository: {
              id: repo.repository_id,
              fullName: repo.full_name,
              installationId: repo.installation_id,
            },
          } as Contract);
          return github.api<{
            head: { sha: string };
            state: 'open' | 'closed';
            updated_at: string;
          }>(`/repos/${repo.full_name}/pulls/${pr.number}`);
        })());
    pr.head.sha = sha.parse(live.head.sha);
    pr.state = live.state;
    pr.updated_at = z.string().datetime().parse(live.updated_at);
    p.action = live.state === 'closed' ? 'closed' : 'synchronize';
  }
  if (pr.state !== (p.action === 'closed' ? 'closed' : 'open'))
    return json({ error: 'INCONSISTENT_EVENT' }, 400);
  const record = db
    .prepare(
      'INSERT OR IGNORE INTO matrix_deliveries(id,payload_hash) VALUES(?,?)',
    )
    .bind(delivery, payloadHash);
  if (current && current.updated_at > pr.updated_at) {
    await record.run();
    return json({ status: 'stale' }, 202);
  }
  if (p.action === 'closed') {
    await db.batch([
      record,
      db
        .prepare(
          'INSERT INTO matrix_submissions(repository_id,pr_number,head_sha,updated_at,closed,latest_run_id) VALUES(?,?,?,?,1,?) ON CONFLICT(repository_id,pr_number) DO UPDATE SET closed=1,updated_at=excluded.updated_at WHERE matrix_submissions.updated_at<=excluded.updated_at',
        )
        .bind(
          repo.repository_id,
          pr.number,
          pr.head.sha,
          pr.updated_at,
          current?.latest_run_id ?? 'closed',
        ),
      db
        .prepare(
          "UPDATE matrix_runs SET state='SUPERSEDED',updated_at=CURRENT_TIMESTAMP WHERE repository_id=? AND pr_number=? AND state IN ('QUEUED','RUNNING') AND EXISTS(SELECT 1 FROM matrix_submissions WHERE repository_id=? AND pr_number=? AND closed=1)",
        )
        .bind(repo.repository_id, pr.number, repo.repository_id, pr.number),
    ]);
    return json({ status: 'closed' });
  }
  if (current?.head_sha === pr.head.sha && !current.closed) {
    await db.batch([
      record,
      db
        .prepare(
          'UPDATE matrix_submissions SET updated_at=? WHERE repository_id=? AND pr_number=? AND latest_run_id=? AND updated_at<=?',
        )
        .bind(
          pr.updated_at,
          repo.repository_id,
          pr.number,
          current.latest_run_id,
          pr.updated_at,
        ),
    ]);
    const run = await db
      .prepare('SELECT state FROM matrix_runs WHERE id=?')
      .bind(current.latest_run_id)
      .first<{ state: string }>();
    if (run?.state === 'QUEUED')
      await dispatchMatrix(env, current.latest_run_id);
    return json({ status: 'duplicate', id: current.latest_run_id });
  }
  const id = await digest(
    canonical({
      repo: repo.repository_id,
      pr: pr.number,
      head: pr.head.sha,
      matrix: repo.matrix_digest,
      image: repo.image_uri,
      baseline: repo.baseline_sha,
      delivery,
    }),
  );
  await db.batch([
    record,
    db
      .prepare(
        'INSERT INTO matrix_submissions(repository_id,pr_number,head_sha,updated_at,closed,latest_run_id) VALUES(?,?,?,?,0,?) ON CONFLICT(repository_id,pr_number) DO UPDATE SET head_sha=excluded.head_sha,updated_at=excluded.updated_at,closed=0,latest_run_id=excluded.latest_run_id WHERE matrix_submissions.updated_at<=excluded.updated_at',
      )
      .bind(repo.repository_id, pr.number, pr.head.sha, pr.updated_at, id),
    db
      .prepare(
        "INSERT OR IGNORE INTO matrix_runs(id,repository_id,full_name,pr_number,head_sha,baseline_sha,matrix_version,matrix_digest,image_uri,publication_status) SELECT ?,?,?,?,?,?,?,?,?,'NOTICE_ONLY' WHERE EXISTS(SELECT 1 FROM matrix_submissions WHERE repository_id=? AND pr_number=? AND latest_run_id=?)",
      )
      .bind(
        id,
        repo.repository_id,
        repo.full_name,
        pr.number,
        pr.head.sha,
        repo.baseline_sha,
        repo.matrix_version,
        repo.matrix_digest,
        repo.image_uri,
        repo.repository_id,
        pr.number,
        id,
      ),
    db
      .prepare(
        "UPDATE matrix_runs SET state='SUPERSEDED',updated_at=CURRENT_TIMESTAMP WHERE repository_id=? AND pr_number=? AND id<>(SELECT latest_run_id FROM matrix_submissions WHERE repository_id=? AND pr_number=?) AND state IN ('QUEUED','RUNNING')",
      )
      .bind(repo.repository_id, pr.number, repo.repository_id, pr.number),
  ]);
  const inserted = await db
    .prepare('SELECT id FROM matrix_runs WHERE id=?')
    .bind(id)
    .first();
  if (inserted) await dispatchMatrix(env, id);
  return json({ id, status: inserted ? 'queued' : 'stale' }, 202);
}
function decode(run: MatrixRun) {
  return { ...run, report: run.report ? JSON.parse(run.report) : null };
}
export async function matrixApi(request: Request, env: Env) {
  if (
    !(await equalSecret(
      request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
      env.ADMIN_TOKEN,
    ))
  )
    return json({ error: 'UNAUTHORIZED' }, 401);
  const path = new URL(request.url).pathname,
    db = dbFor(env);
  if (request.method === 'GET' && path === '/api/matrix/budget')
    return json(await matrixBudget(db, env));
  if (request.method === 'POST' && path === '/api/matrix/diagnostic') {
    const body = z
      .object({
        repository: z.enum(['noyyal-treasury', 'rasoi-offer-roulette']),
        files: z.unknown(),
      })
      .strict()
      .parse(
        JSON.parse(
          new TextDecoder().decode(await boundedBody(request, 2200000)),
        ),
      );
    const files = validateSnapshot(body.files);
    const repo = await db
      .prepare('SELECT image_uri FROM matrix_repositories WHERE full_name=?')
      .bind('180DC-VIT-CHENNAI/' + body.repository)
      .first<{ image_uri: string }>();
    const namespace =
      body.repository === 'noyyal-treasury'
        ? env.NOYYAL_MATRIX
        : env.RASOI_MATRIX;
    if (!namespace || !repo)
      return json({ error: 'MATRIX_NOT_CONFIGURED' }, 503);
    const stub = namespace.get(namespace.newUniqueId()) as unknown as {
      evaluate(value: unknown): Promise<unknown>;
    };
    return json({
      mode: 'diagnostic',
      result: await stub.evaluate({ ...body, files, image: repo.image_uri }),
    });
  }
  if (request.method === 'GET' && path === '/api/matrix/overview') {
    const [repositories, runs] = await Promise.all([
      db
        .prepare(
          'SELECT g.id,g.full_name,m.baseline_sha,m.matrix_version,m.matrix_digest,m.image_uri FROM github_repositories g LEFT JOIN matrix_repositories m ON m.repository_id=g.id WHERE g.accessible=1',
        )
        .all<{
          id: number;
          full_name: string;
          baseline_sha: string | null;
          matrix_version: string | null;
          matrix_digest: string | null;
          image_uri: string | null;
        }>(),
      db
        .prepare(
          'SELECT * FROM matrix_runs ORDER BY created_at DESC,rowid DESC LIMIT 100',
        )
        .all<MatrixRun>(),
    ]);
    return json({
      mode: 'cloudflare-containers',
      repositories: repositories.results.map((repository) => ({
        ...repository,
        evaluation_status: matrixRepositoryStatus(
          repository.full_name,
          !!repository.matrix_version,
        ),
      })),
      runs: runs.results.map(decode),
    });
  }
  const match = path.match(/^\/api\/matrix\/runs\/([a-f0-9]{64})(\/retry)?$/);
  if (!match) return json({ error: 'NOT_FOUND' }, 404);
  const run = await db
    .prepare('SELECT * FROM matrix_runs WHERE id=?')
    .bind(match[1])
    .first<MatrixRun>();
  if (!run) return json({ error: 'NOT_FOUND' }, 404);
  if (request.method === 'GET' && !match[2]) return json(decode(run));
  if (request.method === 'POST' && match[2]) {
    if (!isMatrixOriginAllowed(request, env))
      return json({ error: 'ORIGIN_NOT_ALLOWED' }, 403);
    if (!['FAILED', 'COMPLETED'].includes(run.state))
      return json({ error: 'RETRY_NOT_AVAILABLE' }, 409);
    const id = await digest(crypto.randomUUID());
    await db.batch([
      db
        .prepare(
          'UPDATE matrix_submissions SET latest_run_id=? WHERE repository_id=? AND pr_number=? AND latest_run_id=? AND closed=0',
        )
        .bind(id, run.repository_id, run.pr_number, run.id),
      db
        .prepare(
          "INSERT INTO matrix_runs(id,repository_id,full_name,pr_number,head_sha,baseline_sha,matrix_version,matrix_digest,image_uri,attempt,publication_status) SELECT ?,repository_id,full_name,pr_number,head_sha,baseline_sha,matrix_version,matrix_digest,image_uri,attempt+1,'NOTICE_ONLY' FROM matrix_runs WHERE id=? AND EXISTS(SELECT 1 FROM matrix_submissions WHERE repository_id=? AND pr_number=? AND latest_run_id=?)",
        )
        .bind(id, run.id, run.repository_id, run.pr_number, id),
    ]);
    if (
      !(await db
        .prepare('SELECT id FROM matrix_runs WHERE id=?')
        .bind(id)
        .first())
    )
      return json({ error: 'SUBMISSION_SUPERSEDED' }, 409);
    await dispatchMatrix(env, id);
    return json({ id }, 202);
  }
  return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
}
