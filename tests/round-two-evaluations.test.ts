import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import type { ConsoleSession } from '../src/console-identities';
import type { Env } from '../src/env';
import { roundTwoEvaluations } from '../src/round-two-evaluations';

const origin = 'https://organization.test',
  judgeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  feedback = {
    problemUnderstanding: 'The issue is identified.',
    remediation: 'The proposed fix is feasible.',
    innovationImpact: 'The change has useful impact.',
    overall: 'Clear evidence and rationale.',
  },
  judge: ConsoleSession = {
    hash: 'judge-session',
    role: 'judge',
    identity_id: judgeId,
    name: 'Judge A',
    team_id: null,
  };
let mf: Miniflare, env: Env;

function request(path: string, method = 'GET', data?: unknown) {
  return new Request(origin + '/api/organization/round-two/reviews' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}

async function uploadDocument(db: D1Database, id: string, version: number) {
  await db
    .prepare(
      "INSERT INTO team_documents(id,team_id,version,object_key,filename,content_type,bytes,sha256,status,uploaded_by_identity_id) VALUES(?, 'team-a', ?, ?, ?, 'application/pdf', 12, ?, 'STORED', ?)",
    )
    .bind(
      id,
      version,
      'analysis-documents/' + id,
      `analysis-${version}.pdf`,
      'a'.repeat(64),
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    .run();
}

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default{fetch(){return new Response("ok")}}',
    d1Databases: ['ORG_DB'],
    compatibilityDate: '2026-08-01',
  });
  const db = await mf.getD1Database('ORG_DB');
  await migrate(db as unknown as D1Database);
  await db
    .prepare(
      "INSERT INTO teams(id,name) VALUES('team-a','Team A'),('team-b','Team B')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES(?, 'Judge A', 'judge', NULL, ?),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Team A lead','participant','team-a',?)",
    )
    .bind(judgeId, 'a'.repeat(64), 'b'.repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES('assignment-a',?,'team-a','organizer:test')",
    )
    .bind(judgeId)
    .run();
  await uploadDocument(db as unknown as D1Database, 'document-v1', 1);
  env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => {
  await mf.dispose();
});

describe('auditable review lifecycle', () => {
  it('keeps drafts out of final history and locks edits after submission', async () => {
    const draft = await roundTwoEvaluations(
        request('', 'POST', {
          action: 'SAVE_DRAFT',
          teamId: 'team-a',
          stage: 'ANALYSIS',
          score: 80,
          feedback,
          documentId: 'document-v1',
        }),
        env,
        judge,
      ),
      beforeSubmit = await roundTwoEvaluations(
        request('?teamId=team-a&stage=ANALYSIS'),
        env,
        judge,
      ),
      beforeResult = (await beforeSubmit.json()) as {
        draft: unknown;
        submissions: unknown[];
      },
      submitted = await roundTwoEvaluations(
        request('', 'POST', {
          action: 'SUBMIT',
          teamId: 'team-a',
          stage: 'ANALYSIS',
        }),
        env,
        judge,
      ),
      locked = await roundTwoEvaluations(
        request('', 'POST', {
          action: 'SAVE_DRAFT',
          teamId: 'team-a',
          stage: 'ANALYSIS',
          score: 85,
          feedback,
          documentId: 'document-v1',
        }),
        env,
        judge,
      );

    expect([
      draft.status,
      beforeResult.draft !== null,
      beforeResult.submissions.length,
      submitted.status,
      locked.status,
    ]).toEqual([200, true, 0, 201, 409]);
  });

  it('requires revision reasons and preserves stale document snapshots', async () => {
    await roundTwoEvaluations(
      request('', 'POST', {
        action: 'SAVE_DRAFT',
        teamId: 'team-a',
        stage: 'ANALYSIS',
        score: 80,
        feedback,
        documentId: 'document-v1',
      }),
      env,
      judge,
    );
    await roundTwoEvaluations(
      request('', 'POST', {
        action: 'SUBMIT',
        teamId: 'team-a',
        stage: 'ANALYSIS',
      }),
      env,
      judge,
    );
    await uploadDocument(env.ORG_DB!, 'document-v2', 2);
    const stale = await roundTwoEvaluations(
        request('?teamId=team-a&stage=ANALYSIS'),
        env,
        judge,
      ),
      staleResult = (await stale.json()) as { documentStale: boolean },
      noReason = await roundTwoEvaluations(
        request('', 'POST', {
          action: 'REVISE',
          teamId: 'team-a',
          stage: 'ANALYSIS',
          score: 90,
          feedback,
          documentId: 'document-v2',
        }),
        env,
        judge,
      ),
      revised = await roundTwoEvaluations(
        request('', 'POST', {
          action: 'REVISE',
          teamId: 'team-a',
          stage: 'ANALYSIS',
          score: 90,
          feedback,
          documentId: 'document-v2',
          reason: 'Reassessed after the updated document.',
        }),
        env,
        judge,
      ),
      current = await roundTwoEvaluations(
        request('?teamId=team-a&stage=ANALYSIS'),
        env,
        judge,
      ),
      result = (await current.json()) as {
        documentStale: boolean;
        submissions: {
          revision: number;
          score: number;
          reason: string;
        }[];
      };

    expect([
      staleResult.documentStale,
      noReason.status,
      revised.status,
      result.documentStale,
      result.submissions.map(({ revision, score }) => [revision, score]),
      result.submissions[1]?.reason,
    ]).toEqual([
      true,
      400,
      201,
      false,
      [
        [2, 90],
        [1, 80],
      ],
      'Initial submission',
    ]);
  });

  it('does not expose another team review to an unassigned judge', async () => {
    const response = await roundTwoEvaluations(
      request('?teamId=team-b&stage=ANALYSIS'),
      env,
      judge,
    );

    expect(response.status).toBe(404);
  });

  it('computes engineering draft and final scores from the selected repo rubric', async () => {
    const db = env.ORG_DB!;
    await db
      .prepare(
        "INSERT INTO github_repositories(id,full_name,private,default_branch,accessible) VALUES(1,'180DC-VIT-CHENNAI/veera-footwear',0,'main',1)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',1,'participant:team-a')",
      )
      .run();
    await db
      .prepare(
        'INSERT INTO round_two_repository_rubric_versions(id,repository_id,version,criteria,actor) VALUES(?,1,1,?,?)',
      )
      .bind(
        'rubric-v1',
        JSON.stringify([
          { id: 'correctness', label: 'Correctness', weight: 30 },
          { id: 'security', label: 'Security', weight: 20 },
          { id: 'performance', label: 'Performance', weight: 20 },
          { id: 'quality', label: 'Quality', weight: 15 },
          { id: 'innovation', label: 'Innovation', weight: 10 },
          {
            id: 'reproducibility',
            label: 'Reproducibility',
            weight: 5,
          },
        ]),
        'organizer:test',
      )
      .run();
    await db
      .prepare(
        'INSERT INTO round_two_active_repository_rubrics(repository_id,rubric_id,actor) VALUES(1,?,?)',
      )
      .bind('rubric-v1', 'organizer:test')
      .run();
    const rubricView = await roundTwoEvaluations(
        request('?teamId=team-a&stage=ENGINEERING'),
        env,
        judge,
      ),
      rubricViewResult = (await rubricView.json()) as {
        rubric: {
          id: string;
          criteria: { id: string; weight: number }[];
        };
      };
    expect(rubricViewResult.rubric.id).toBe('rubric-v1');
    expect(
      rubricViewResult.rubric.criteria.map(({ id, weight }) => ({
        id,
        weight,
      })),
    ).toEqual([
      { id: 'correctness', weight: 30 },
      { id: 'security', weight: 20 },
      { id: 'performance', weight: 20 },
      { id: 'quality', weight: 15 },
      { id: 'innovation', weight: 10 },
      { id: 'reproducibility', weight: 5 },
    ]);
    const criteriaScores = [
        { criterionId: 'correctness', score: 100, comment: 'Complete' },
        {
          criterionId: 'security',
          score: 80,
          comment: 'Secure enough',
        },
        { criterionId: 'performance', score: 90, comment: 'Fast' },
        { criterionId: 'quality', score: 80, comment: 'Readable' },
        { criterionId: 'innovation', score: 100, comment: 'Useful' },
        {
          criterionId: 'reproducibility',
          score: 100,
          comment: 'Reproducible',
        },
      ],
      draft = await roundTwoEvaluations(
        request('', 'POST', {
          action: 'SAVE_DRAFT',
          teamId: 'team-a',
          stage: 'ENGINEERING',
          criteriaScores,
          overall: 'Strong implementation.',
        }),
        env,
        judge,
      ),
      draftResult = (await draft.json()) as { score: number };

    expect([draft.status, draftResult.score]).toEqual([200, 91]);
    const submitted = await roundTwoEvaluations(
        request('', 'POST', {
          action: 'SUBMIT',
          teamId: 'team-a',
          stage: 'ENGINEERING',
        }),
        env,
        judge,
      ),
      revised = await roundTwoEvaluations(
        request('', 'POST', {
          action: 'REVISE',
          teamId: 'team-a',
          stage: 'ENGINEERING',
          criteriaScores: criteriaScores.map((criterion) => ({
            ...criterion,
            score: criterion.score - 10,
          })),
          overall: 'Revised after reviewing the updated evidence.',
          reason: 'The final code review found additional test gaps.',
        }),
        env,
        judge,
      ),
      revisedResult = (await revised.json()) as {
        status: string;
        revision: number;
        score: number;
      };

    expect([
      submitted.status,
      revised.status,
      revisedResult.status,
      revisedResult.revision,
      revisedResult.score,
    ]).toEqual([201, 201, 'FINAL', 2, 81]);
  });
});
