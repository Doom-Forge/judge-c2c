import { organizationActive } from './organization-retirement';
import { dashboardRepositories } from './dashboard-repositories';
import { attentionItems } from './attention';
import { retryableRun } from './retry-policy';
import { assessExpectedArtifacts } from './expected-artifacts';
import { buildEvaluationPlan } from './evaluation-plan';
import type { ArtifactMetadata } from './artifact-store';
import { AI_POLICY_VERSION, type Context } from './evaluate';
import { listCandidates } from './additional-contributions';
import { requirementOutcomes } from './requirement-assessment';
import { readArtifact, captureRunArtifacts } from './artifact-store';
import { z } from 'zod';
import { contractSchema, canonical, digest } from './domain';
import { equalSecret, boundedBody } from './security';
import { demoContract, demoRun, demoDetail } from './demo';
import { getRun, dispatch, isCurrent } from './store';
import type { Env } from './env';
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const assignmentSchema = z
  .object({
    repositoryId: z.number().int().positive(),
    prNumber: z.number().int().positive(),
    teamId: z.string().regex(/^[\w.-]{1,80}$/),
    teamName: z.string().min(1).max(100),
    contractHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    issueNumbers: z.array(z.number().int().positive()).min(1).max(30),
  })
  .strict();
export async function api(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== 'GET' && !(await organizationActive(env)))
    return json({ error: 'ORGANIZATION_RETIRED' }, 409);
  const demo = env.DEMO_MODE === 'true';
  if (demo && request.method !== 'GET')
    return json({ error: 'REVIEW_IS_READ_ONLY' }, 403);
  if (
    !demo &&
    !(await equalSecret(
      request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
      env.ADMIN_TOKEN,
    ))
  )
    return json({ error: 'UNAUTHORIZED' }, 401);
  if (request.method === 'GET' && path === '/api/overview') {
    if (demo)
      return json({
        demo: true,
        counts: {
          repositories: 1,
          teams: 1,
          openSubmissions: 1,
          active: 0,
          completed: 1,
          failed: 0,
          attention: 1,
        },
        runs: [demoRun],
      });
    const [counts, runs, repositoryCount] = await Promise.all([
      env.DB.prepare(
        `SELECT (SELECT count(*) FROM repositories) AS repositories,(SELECT count(*) FROM teams) AS teams,(SELECT count(*) FROM submissions WHERE closed=0) AS openSubmissions,(SELECT count(*) FROM evaluations WHERE state NOT IN ('COMPLETED','FAILED','SUPERSEDED')) AS active,(SELECT count(*) FROM evaluations WHERE state='COMPLETED') AS completed,(SELECT count(*) FROM evaluations WHERE state='FAILED') AS failed,(SELECT count(*) FROM evaluations e JOIN submissions s ON s.latest_run_id=e.id WHERE e.state='FAILED' OR (e.state='COMPLETED' AND (e.ai_status<>'COMPLETED' OR json_extract(coalesce(e.report,'{}'),'$.aiTrace.requiresHumanAttention')=1 OR coalesce(json_extract(coalesce(e.report,'{}'),'$.aiTrace.groundingPolicy'),'')<>'objective-facts-unverified-narratives-v1' OR e.evidence LIKE '%UNVERIFIED%'))) AS attention`,
      ).first(),
      env.DB.prepare(
        'SELECT e.*,r.full_name FROM evaluations e JOIN repositories r ON r.id=e.repository_id ORDER BY e.created_at DESC LIMIT 100',
      ).all(),
      env.ORG_DB
        ? dashboardRepositories(env).then((repositories) => repositories.length)
        : Promise.resolve(null),
    ]);
    return json({
      demo: false,
      counts: {
        ...counts,
        ...(repositoryCount !== null ? { repositories: repositoryCount } : {}),
      },
      runs: runs.results,
    });
  }
  if (request.method === 'GET' && path === '/api/repositories') {
    if (demo)
      return json({
        repositories: [
          {
            id: 1,
            full_name: demoContract.repository.fullName,
            document: JSON.stringify(demoContract),
          },
        ],
      });
    return json({
      repositories: await dashboardRepositories(env),
    });
  }
  const runMatch = path.match(/^\/api\/evaluations\/([\w-]{1,80})(\/bundle)?$/);
  if (request.method === 'GET' && runMatch) {
    if (demo)
      return runMatch[1] === demoRun.id
        ? json(demoDetail)
        : json({ error: 'NOT_FOUND' }, 404);
    const run = await getRun(env, runMatch[1]!);
    if (!run) return json({ error: 'NOT_FOUND' }, 404);
    const [timeline, artifacts, execution, currentSubmission] =
      await Promise.all([
        env.DB.prepare('SELECT * FROM timeline WHERE run_id=? ORDER BY id')
          .bind(run.id)
          .all(),
        env.DB.prepare('SELECT * FROM artifacts WHERE run_id=?')
          .bind(run.id)
          .all(),
        env.DB.prepare(
          'SELECT * FROM execution_results WHERE run_id=? ORDER BY created_at',
        )
          .bind(run.id)
          .all(),
        env.DB.prepare(
          'SELECT head_sha AS headSha,latest_run_id AS latestRunId,closed FROM submissions WHERE repository_id=? AND pr_number=?',
        )
          .bind(run.repository_id, run.pr_number)
          .first<{ headSha: string; latestRunId: string; closed: number }>(),
      ]);
    const detail = {
      ...run,
      retryable: retryableRun(run),
      attentionItems: attentionItems(run, JSON.parse(run.evidence ?? '[]')),
      reviewPolicyCurrent:
        JSON.parse(run.report || '{}').aiTrace?.policy === AI_POLICY_VERSION,
      timeline: timeline.results,
      artifacts: artifacts.results,
      execution: execution.results,
      additionalContributions: await listCandidates(env, run.id),
      evaluationPlan: run.context
        ? buildEvaluationPlan(
            contractSchema.parse(JSON.parse(run.contract_snapshot)),
            JSON.parse(run.context) as Context,
          )
        : null,
      expectedArtifactResults: assessExpectedArtifacts(
        contractSchema.parse(JSON.parse(run.contract_snapshot)),
        artifacts.results as unknown as ArtifactMetadata[],
      ),
      requirementResults: requirementOutcomes(
        contractSchema.parse(JSON.parse(run.contract_snapshot)),
        JSON.parse(run.evidence ?? '[]'),
      ),
      currentSubmission: currentSubmission
        ? { ...currentSubmission, closed: Boolean(currentSubmission.closed) }
        : null,
    };
    if (runMatch[2]) {
      const content = canonical({
        schemaVersion: 1,
        storage: 'bounded-database-evidence',
        evaluation: detail,
      });
      if (new TextEncoder().encode(content).length > 2_000_000)
        return json({ error: 'BUNDLE_LIMIT_USE_ARTIFACT_STORAGE' }, 413);
      return new Response(content, {
        headers: {
          'content-type': 'application/json',
          'content-disposition': `attachment; filename="judge-c2c-${run.id}.json"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-evidence-sha256': await digest(content),
        },
      });
    }
    return json(detail);
  }
  if (request.method === 'GET' && path === '/api/artifact') {
    if (demo) return json({ error: 'ARTIFACT_STORAGE_NOT_CONFIGURED' }, 503);
    return readArtifact(env, url.searchParams.get('key') ?? '');
  }
  const artifactRetry = path.match(
    /^\/api\/evaluations\/([a-f0-9]{64})\/artifacts\/retry$/,
  );
  if (request.method === 'POST' && artifactRetry && !demo) {
    const raw = await boundedBody(request, 1024);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }
    const body = z.object({}).strict().safeParse(parsed);
    if (!body.success) return json({ error: 'INVALID_REQUEST' }, 400);
    const run = await getRun(env, artifactRetry[1]!);
    if (!run) return json({ error: 'NOT_FOUND' }, 404);
    if (!['COMPLETED', 'FAILED', 'SUPERSEDED'].includes(run.state))
      return json({ error: 'RUN_NOT_TERMINAL' }, 409);
    if (!env.ARTIFACTS && !env.ARTIFACT_KV)
      return json({ error: 'ARTIFACT_STORAGE_NOT_CONFIGURED' }, 503);
    return json(await captureRunArtifacts(env, run.id));
  }
  if (request.method === 'POST' && path === '/api/contracts') {
    const raw = await boundedBody(request, 200_000);
    const c = contractSchema.parse(JSON.parse(new TextDecoder().decode(raw)));
    const document = canonical(c);
    const hash = await digest(document);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO repositories(id,full_name,installation_id,active_contract_hash) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name,installation_id=excluded.installation_id,active_contract_hash=excluded.active_contract_hash',
      ).bind(
        c.repository.id,
        c.repository.fullName,
        c.repository.installationId,
        hash,
      ),
      env.DB.prepare(
        'INSERT OR IGNORE INTO contracts(hash,repository_id,document) VALUES(?,?,?)',
      ).bind(hash, c.repository.id, document),
      env.DB.prepare('INSERT INTO audit(action,entity) VALUES(?,?)').bind(
        'contract.registered',
        hash,
      ),
    ]);
    return json({ hash }, 201);
  }
  if (request.method === 'POST' && path === '/api/assignments') {
    const raw = await boundedBody(request, 20_000);
    const a = assignmentSchema.parse(JSON.parse(new TextDecoder().decode(raw)));
    const repo = await env.DB.prepare(
      'SELECT c.document,c.hash FROM repositories r JOIN contracts c ON c.hash=COALESCE(?,r.active_contract_hash) AND c.repository_id=r.id WHERE r.id=?',
    )
      .bind(a.contractHash ?? null, a.repositoryId)
      .first<{ document: string; hash: string }>();
    if (!repo) return json({ error: 'REPOSITORY_NOT_REGISTERED' }, 422);
    const contract = contractSchema.parse(JSON.parse(repo.document));
    if (
      a.issueNumbers.length !== contract.issueNumbers.length ||
      a.issueNumbers.some((i) => !contract.issueNumbers.includes(i))
    )
      return json({ error: 'ISSUE_MISMATCH' }, 422);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO teams(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',
      ).bind(a.teamId, a.teamName),
      env.DB.prepare(
        'INSERT INTO assignments(repository_id,pr_number,team_id,issue_numbers,contract_hash) VALUES(?,?,?,?,?) ON CONFLICT(repository_id,pr_number) DO UPDATE SET team_id=excluded.team_id,issue_numbers=excluded.issue_numbers,contract_hash=excluded.contract_hash',
      ).bind(
        a.repositoryId,
        a.prNumber,
        a.teamId,
        canonical(a.issueNumbers),
        repo.hash,
      ),
      env.DB.prepare('INSERT INTO audit(action,entity) VALUES(?,?)').bind(
        'assignment.registered',
        `${a.repositoryId}:${a.prNumber}`,
      ),
    ]);
    return json({ status: 'registered' }, 201);
  }
  const retryMatch = path.match(/^\/api\/evaluations\/([a-f0-9]{64})\/retry$/);
  if (request.method === 'POST' && retryMatch) {
    const run = await getRun(env, retryMatch[1]!);
    if (!run) return json({ error: 'NOT_FOUND' }, 404);
    if (
      !(await env.DB.prepare(
        "SELECT id FROM hackathons WHERE id='initial' AND status='ACTIVE'",
      ).first())
    )
      return json({ error: 'EVENT_NOT_ACTIVE' }, 409);
    if (run.state === 'QUEUED') {
      await dispatch(env, run.id);
      return json({ status: 'dispatch_requested', runId: run.id }, 202);
    }
    if (!retryableRun(run) || !(await isCurrent(env, run)))
      return json({ error: 'RUN_NOT_RETRYABLE' }, 409);
    // A retry is a new auditable attempt; the failed report is never overwritten.
    const newId = await digest(run.id + crypto.randomUUID());
    const retried = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO evaluations(id,repository_id,pr_number,head_sha,baseline_sha,contract_hash,contract_snapshot,assignment_snapshot,state) SELECT ?,repository_id,pr_number,head_sha,baseline_sha,contract_hash,contract_snapshot,assignment_snapshot,'QUEUED' FROM evaluations WHERE id=? AND EXISTS(SELECT 1 FROM submissions WHERE latest_run_id=?) AND EXISTS(SELECT 1 FROM hackathons WHERE id='initial' AND status='ACTIVE')",
      ).bind(newId, run.id, run.id),
      env.DB.prepare(
        'UPDATE submissions SET latest_run_id=? WHERE latest_run_id=? AND EXISTS(SELECT 1 FROM evaluations WHERE id=?)',
      ).bind(newId, run.id, newId),
      env.DB.prepare(
        'INSERT INTO outbox(run_id) SELECT id FROM evaluations WHERE id=?',
      ).bind(newId),
      env.DB.prepare(
        'INSERT INTO timeline(run_id,state,detail) SELECT id,state,? FROM evaluations WHERE id=?',
      ).bind('Retry of ' + run.id, newId),
      env.DB.prepare(
        'INSERT INTO audit(action,entity) SELECT ?,? WHERE EXISTS(SELECT 1 FROM evaluations WHERE id=?)',
      ).bind('evaluation.retried', run.id + ':' + newId, newId),
    ]);
    if (!retried[0]!.meta.changes)
      return json({ error: 'RUN_NOT_CURRENT' }, 409);
    await dispatch(env, newId);
    return json({ status: 'retry_requested', runId: newId }, 202);
  }
  return json({ error: 'NOT_FOUND' }, 404);
}
