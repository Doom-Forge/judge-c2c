import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { z } from 'zod';
import matrices from '../matrix-runner/matrices.json';
import { canonical, digest, type Contract } from './domain';
import type { Env } from './env';
import { GitHub } from './github';
import { ensureDefaultReviewer } from './default-reviewer';
import { doombotNoticeBody, ensureDoomBotNotice } from './doombot-notice';
import { organizationEnv } from './organization';
import { scoreMatrix, validateSnapshot } from './matrix';
import { reserveMatrixStart } from './matrix-budget';
import { readBaseline, retainBaseline } from './matrix-baseline';
import { acquireMatrixSlot, releaseMatrixSlot } from './matrix-capacity';
import {
  acceptMatrixPR,
  dispatchMatrix,
  type MatrixRun,
} from './matrix-service';

type RepoKey = keyof typeof matrices;
const repoKey = (name: string): RepoKey => {
  const key = name.split('/')[1];
  if (key !== 'noyyal-treasury' && key !== 'rasoi-offer-roulette')
    throw new Error('MATRIX_UNKNOWN_REPOSITORY');
  return key;
};
const dbFor = (env: Env) => env.ORG_DB ?? env.DB;
async function current(env: Env, id: string) {
  const db = dbFor(env);
  const run = await db
    .prepare(
      "SELECT r.* FROM matrix_runs r JOIN matrix_submissions s ON s.latest_run_id=r.id JOIN github_repositories g ON g.id=r.repository_id WHERE r.id=? AND s.closed=0 AND g.accessible=1 AND r.state IN ('QUEUED','RUNNING')",
    )
    .bind(id)
    .first<MatrixRun>();
  if (!run) throw new Error('MATRIX_SUPERSEDED');
  return run;
}
async function clientFor(env: Env, run: MatrixRun, pullRequestsWrite = false) {
  const scoped = await organizationEnv(env);
  const installation = await dbFor(env)
    .prepare('SELECT installation_id FROM github_connection WHERE id=1')
    .first<number>('installation_id');
  if (!installation) throw new Error('APP_NOT_INSTALLED');
  return GitHub.installation(
    scoped,
    {
      repository: {
        id: run.repository_id,
        fullName: run.full_name,
        installationId: installation,
      },
    } as Contract,
    { issuesWrite: false, pullRequestsWrite, checksWrite: false },
  );
}
export async function matrixSnapshot(
  github: GitHub,
  repo: string,
  commit: string,
) {
  const tree = await github.api<{
    truncated: boolean;
    tree: { path: string; type: string; mode: string; size?: number }[];
  }>(`/repos/${repo}/git/trees/${commit}?recursive=1`);
  if (tree.truncated) throw new Error('MATRIX_TREE_LIMIT');
  const entries = tree.tree.filter(
    (f) =>
      f.path.startsWith('src/') && f.path.endsWith('.py') && f.type !== 'tree',
  );
  if (
    !entries.length ||
    entries.length > 250 ||
    entries.some(
      (f) =>
        f.type !== 'blob' ||
        !['100644', '100755'].includes(f.mode) ||
        (f.size ?? 0) > 100000,
    ) ||
    entries.reduce((n, f) => n + (f.size ?? 0), 0) > 1500000
  )
    throw new Error('MATRIX_SOURCE_LIMIT');
  const files = [];
  for (const f of entries) {
    const text = await github.file(repo, commit, f.path, 100000);
    if (text === null) throw new Error('MATRIX_SOURCE_UNAVAILABLE');
    files.push({
      path: f.path,
      base64: Buffer.from(text, 'utf8').toString('base64'),
    });
  }
  return validateSnapshot(files);
}
const requestSchema = z
  .object({
    repository: z.enum(['noyyal-treasury', 'rasoi-offer-roulette']),
    image: z
      .string()
      .regex(
        /^registry\.cloudflare\.com\/[A-Za-z0-9/_-]+@sha256:[a-f0-9]{64}$/,
      ),
    files: z.unknown(),
  })
  .strict();
async function boundedStream(stream: ReadableStream | null, max: number) {
  if (!stream) return '';
  const reader = stream.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new Error('MATRIX_OUTPUT_LIMIT');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
class MatrixRunner extends DurableObject<Env> {
  protected repository: RepoKey = 'noyyal-treasury';
  private async destroyAndRelease() {
    const lease = await this.ctx.storage.get<{ slot: string; owner: string }>(
      'activeCapacity',
    );
    try {
      if (!this.ctx.container) throw new Error('MATRIX_CONTAINER_NOT_BOUND');
      await this.ctx.container.destroy();
      if (lease)
        await releaseMatrixSlot(dbFor(this.env), lease.slot, lease.owner);
      await this.ctx.storage.delete('activeCapacity');
      await this.ctx.storage.deleteAlarm();
    } catch (error) {
      // Uncertain destruction never frees admission capacity, including after expiry.
      await this.ctx.storage.setAlarm(Date.now() + 30000);
      throw error;
    }
  }
  async alarm() {
    try {
      await this.destroyAndRelease();
    } catch {
      // The persisted lease and retry alarm remain until destruction is confirmed.
    }
  }
  async evaluate(raw: unknown) {
    const request = requestSchema.parse(raw);
    if (request.image !== this.env.MATRIX_IMAGE_URI)
      throw new Error('MATRIX_IMAGE_MISMATCH');
    if (request.repository !== this.repository)
      throw new Error('MATRIX_REPOSITORY_MISMATCH');
    const files = validateSnapshot(request.files),
      container = this.ctx.container;
    if (!container) throw new Error('MATRIX_CONTAINER_NOT_BOUND');
    if (container.images.base !== request.image)
      throw new Error('MATRIX_IMAGE_MISMATCH');
    if (await this.ctx.storage.get('used'))
      throw new Error('MATRIX_CONTAINER_ALREADY_USED');
    await this.ctx.storage.put('used', true);
    const owner = crypto.randomUUID(),
      capacityDB = dbFor(this.env);
    const slot = await acquireMatrixSlot(capacityDB, this.repository, owner);
    // Reserve even failed starts; all RPC callers, including diagnostics, pass here.
    try {
      await reserveMatrixStart(capacityDB, this.env, owner);
      await this.ctx.storage.put('activeCapacity', { slot, owner });
      await this.ctx.storage.setAlarm(Date.now() + 180000);
    } catch (error) {
      await releaseMatrixSlot(capacityDB, slot, owner);
      await this.ctx.storage.delete('activeCapacity');
      throw error;
    }
    let process: ExecProcess | undefined;
    const deadline = Date.now() + 150000;
    const timer = setTimeout(() => {
      try {
        process?.kill(9);
      } catch {}
      void this.destroyAndRelease().catch(() => undefined);
    }, 150000);
    try {
      container.start({
        image: request.image,
        // Named basic instance is supported by the platform; installed workers-types lags.
        // https://developers.cloudflare.com/containers/platform/limits/
        // Live deployment validation is required before treating this size as verified.
        instance: 'basic' as ContainerStartupOptions['instance'],
        enableInternet: false,
        env: {},
        entrypoint: ['sleep', 'infinity'],
      });
      await container.setInactivityTimeout(180000);
      // Exec can race initial image provisioning; only retry before launching code.
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          process = await container.exec(
            ['python', '/opt/judge/controller.py'],
            {
              cwd: '/opt/judge',
              env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
              stdin: 'pipe',
              stdout: 'pipe',
              stderr: 'pipe',
              signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
            },
          );
          break;
        } catch (error) {
          if (attempt === 59) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (!process) throw new Error('MATRIX_CONTAINER_START_TIMEOUT');
      const out = boundedStream(process.stdout, 32000),
        err = boundedStream(process.stderr, 8192);
      const writer = process.stdin!.getWriter();
      await writer.write(
        new TextEncoder().encode(
          JSON.stringify({ repository: request.repository, files }),
        ),
      );
      await writer.close();
      const [stdout, , exitCode] = await Promise.all([
        out,
        err,
        process.exitCode,
      ]);
      if (exitCode !== 0) throw new Error('MATRIX_CONTROLLER_FAILED');
      const result = z
        .object({ checks: z.array(z.unknown()).max(100) })
        .passthrough()
        .parse(JSON.parse(stdout));
      const report = scoreMatrix(
        matrices[this.repository].checks,
        result.checks,
      );
      if ((await container.inspect())?.image !== request.image)
        throw new Error('MATRIX_IMAGE_MISMATCH');
      return {
        ...report,
        image: (await container.inspect())?.image ?? 'unavailable',
        finishedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
      try {
        process?.kill(9);
      } catch {}
      await this.destroyAndRelease();
    }
  }
}
export class NoyyalMatrixRunner extends MatrixRunner {
  protected repository: RepoKey = 'noyyal-treasury';
}
export class RasoiMatrixRunner extends MatrixRunner {
  protected repository: RepoKey = 'rasoi-offer-roulette';
}

type MatrixReport = ReturnType<typeof scoreMatrix> & {
  image?: string;
  finishedAt?: string;
};
async function requestMatrixReviewer(env: Env, run: MatrixRun) {
  if (!env.DEFAULT_PR_REVIEWER) return;
  try {
    await ensureDefaultReviewer(
      dbFor(env),
      await clientFor(env, run, true),
      run,
      env.DEFAULT_PR_REVIEWER,
    );
  } catch {
    /* Cron retries configuration and API failures. */
  }
}
async function notifyMatrix(env: Env, run: MatrixRun) {
  try {
    const db = dbFor(env);
    const slug = await db
      .prepare('SELECT slug FROM github_connection WHERE id=1')
      .first<string>('slug');
    const origin = env.ORG_PUBLIC_ORIGIN || env.PUBLIC_ORIGIN;
    if (!slug || !origin) return;
    const github = await clientFor(env, run, true);
    await ensureDoomBotNotice(db, github, run, origin, slug + '[bot]');
  } catch {
    /* Notification must never block evaluation. Cron retries it. */
  }
}
export class MatrixEvaluationWorkflow extends WorkflowEntrypoint<
  Env,
  { runId: string }
> {
  async run(event: WorkflowEvent<{ runId: string }>, step: WorkflowStep) {
    const id = event.payload.runId,
      db = dbFor(this.env);
    try {
      await step.do('verify-inputs', async () => {
        const run = await current(this.env, id),
          key = repoKey(run.full_name),
          matrix = matrices[key];
        if (
          run.matrix_version !== matrix.version ||
          run.matrix_digest !== (await digest(canonical(matrix)))
        )
          throw new Error('MATRIX_VERSION_MISMATCH');
        const github = await clientFor(this.env, run),
          pr = await github.api<{
            head: { sha: string };
            state: 'open' | 'closed';
            updated_at: string;
          }>(`/repos/${run.full_name}/pulls/${run.pr_number}`);
        if (pr.head.sha !== run.head_sha || pr.state !== 'open') {
          const installation = await db
            .prepare('SELECT installation_id FROM github_connection WHERE id=1')
            .first<number>('installation_id');
          if (installation)
            await acceptMatrixPR(
              {
                action: pr.state === 'open' ? 'synchronize' : 'closed',
                installation: { id: installation },
                repository: { id: run.repository_id, full_name: run.full_name },
                pull_request: {
                  number: run.pr_number,
                  head: pr.head,
                  base: { repo: { id: run.repository_id } },
                  state: pr.state,
                  updated_at: pr.updated_at,
                },
              },
              this.env,
              'reconcile-' + run.id.slice(0, 20) + '-' + pr.head.sha,
              await digest(canonical(pr)),
            );
          throw new Error('MATRIX_SUPERSEDED');
        }
        await notifyMatrix(this.env, run);
        await requestMatrixReviewer(this.env, run);
        await db
          .prepare(
            "UPDATE matrix_runs SET state='RUNNING',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='QUEUED'",
          )
          .bind(id)
          .run();
      });
      const execute = async (kind: 'baseline' | 'head') =>
        step.do(
          'execute-' + kind,
          {
            retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
            timeout: '5 minutes',
          },
          async () => {
            const run = await current(this.env, id),
              key = repoKey(run.full_name),
              github = await clientFor(this.env, run),
              commit = kind === 'baseline' ? run.baseline_sha : run.head_sha;
            const identity = {
              repository: run.full_name,
              baselineSha: run.baseline_sha,
              matrixDigest: run.matrix_digest,
              imageUri: run.image_uri,
            };
            if (kind === 'baseline') {
              const cached = await readBaseline(
                db,
                identity,
                matrices[key].checks,
              );
              if (cached) return cached;
            }
            const files = await matrixSnapshot(github, run.full_name, commit);
            await current(this.env, id);
            const namespace =
              key === 'noyyal-treasury'
                ? this.env.NOYYAL_MATRIX
                : this.env.RASOI_MATRIX;
            if (!namespace) throw new Error('MATRIX_CONTAINER_NOT_CONFIGURED');
            const stub = namespace.get(namespace.newUniqueId()) as unknown as {
              evaluate(raw: unknown): Promise<MatrixReport>;
            };
            const report = await stub.evaluate({
              repository: key,
              image: run.image_uri,
              files,
            });
            if (kind === 'baseline')
              await retainBaseline(db, identity, matrices[key].checks, report);
            return report;
          },
        );
      const baseline = await execute('baseline');
      await step.do('retain-baseline', async () => {
        const run = await current(this.env, id);
        await db
          .prepare(
            "UPDATE matrix_runs SET report=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='RUNNING'",
          )
          .bind(
            canonical({
              ...scoreMatrix(matrices[repoKey(run.full_name)].checks, []),
              baseline,
            }),
            id,
          )
          .run();
      });
      const head = await execute('head');
      if (!baseline.image || baseline.image !== head.image)
        throw new Error('MATRIX_IMAGE_MISMATCH');
      await step.do('save-result', async () => {
        await current(this.env, id);
        await db
          .prepare(
            "UPDATE matrix_runs SET report=?,state='COMPLETED',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='RUNNING'",
          )
          .bind(canonical({ ...head, baseline }), id)
          .run();
      });
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
          ? error.message
          : 'MATRIX_EXECUTION_UNAVAILABLE';
      await step.do('retain-failure', async () => {
        await db
          .prepare(
            "UPDATE matrix_runs SET state=?,failure_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state IN ('QUEUED','RUNNING')",
          )
          .bind(
            code === 'MATRIX_SUPERSEDED' ? 'SUPERSEDED' : 'FAILED',
            code,
            id,
          )
          .run();
      });
    }
  }
}
export async function reconcileMatrix(env: Env) {
  const db = dbFor(env);
  const queued = await db
    .prepare(
      "SELECT r.id FROM matrix_runs r JOIN matrix_submissions s ON s.latest_run_id=r.id WHERE r.state='QUEUED' AND s.closed=0 LIMIT 20",
    )
    .all<{ id: string }>();
  for (const row of queued.results)
    await dispatchMatrix(env, row.id).catch(() => undefined);
  if (env.DEFAULT_PR_REVIEWER) {
    const reviews = await db
      .prepare(
        "SELECT r.* FROM matrix_runs r JOIN matrix_submissions s ON s.latest_run_id=r.id JOIN github_repositories g ON g.id=r.repository_id LEFT JOIN matrix_default_reviewers d ON d.repository_id=r.repository_id AND d.pr_number=r.pr_number AND d.reviewer=? WHERE s.closed=0 AND g.accessible=1 AND (d.status IS NULL OR d.status='PENDING') ORDER BY COALESCE(d.updated_at,'1970-01-01') ASC,r.created_at ASC LIMIT 100",
      )
      .bind(env.DEFAULT_PR_REVIEWER)
      .all<MatrixRun>();
    for (const run of reviews.results) await requestMatrixReviewer(env, run);
  }
  const origin = env.ORG_PUBLIC_ORIGIN || env.PUBLIC_ORIGIN;
  if (!origin) return;
  const noticeHash = await digest(doombotNoticeBody(origin));
  const pending = await db
    .prepare(
      "SELECT r.* FROM matrix_runs r JOIN matrix_submissions s ON s.latest_run_id=r.id JOIN github_repositories g ON g.id=r.repository_id LEFT JOIN matrix_doombot_notices n ON n.repository_id=r.repository_id AND n.pr_number=r.pr_number WHERE s.closed=0 AND g.accessible=1 AND r.state IN ('RUNNING','COMPLETED','FAILED') AND (n.comment_id IS NULL OR n.body_hash IS NULL OR n.body_hash<>?) ORDER BY r.created_at DESC LIMIT 100",
    )
    .bind(noticeHash)
    .all<MatrixRun>();
  for (const run of pending.results) {
    try {
      const github = await clientFor(env, run);
      const pr = await github.api<{ state: string; head: { sha: string } }>(
        `/repos/${run.full_name}/pulls/${run.pr_number}`,
      );
      if (pr.state === 'open' && pr.head.sha === run.head_sha)
        await notifyMatrix(env, run);
    } catch {
      /* Retry next reconciliation. */
    }
  }
}
