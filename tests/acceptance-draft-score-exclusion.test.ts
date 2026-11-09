import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import type { ConsoleSession } from '../src/console-identities';
import type { Env } from '../src/env';
import { roundTwoResults } from '../src/round-two-results';
import { roundTwoEvaluations } from '../src/round-two-evaluations';

const origin = 'https://organization.test',
  organizer: ConsoleSession = {
    hash: 'organizer-session',
    role: 'organizer',
    identity_id: 'organizer-id',
    name: 'Organizer',
    team_id: null,
  },
  judgeA: ConsoleSession = {
    hash: 'judge-a-session',
    role: 'judge',
    identity_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Judge A',
    team_id: null,
  },
  judgeB: ConsoleSession = {
    hash: 'judge-b-session',
    role: 'judge',
    identity_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    name: 'Judge B',
    team_id: null,
  },
  feedback = {
    problemUnderstanding: 'The issue is identified.',
    remediation: 'The proposed fix is feasible.',
    innovationImpact: 'The change has useful impact.',
    overall: 'Clear evidence and rationale.',
  };
let mf: Miniflare, env: Env;

function request(path: string, method = 'GET', data?: unknown) {
  return new Request(origin + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}

async function saveDraft(judge: ConsoleSession, score: number) {
  return roundTwoEvaluations(
    request('/api/organization/round-two/reviews', 'POST', {
      action: 'SAVE_DRAFT',
      teamId: 'team-a',
      stage: 'ANALYSIS',
      score,
      feedback,
      documentId: 'document-a',
    }),
    env,
    judge,
  );
}

async function submitDraft(judge: ConsoleSession) {
  return roundTwoEvaluations(
    request('/api/organization/round-two/reviews', 'POST', {
      action: 'SUBMIT',
      teamId: 'team-a',
      stage: 'ANALYSIS',
    }),
    env,
    judge,
  );
}

async function results() {
  const response = await roundTwoResults(
    request('/api/organization/round-two/results'),
    env,
    organizer,
  );
  return (
    (await response.json()) as {
      results: {
        teamId: string;
        analysisAverage: number | null;
        analysisJudgeCount: number;
        status: string;
        finalScore: number | null;
      }[];
    }
  ).results.find((team) => team.teamId === 'team-a');
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
    .prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A')")
    .run();
  await db
    .prepare(
      "INSERT INTO console_identities(id,name,role,credential_hash) VALUES(?, 'Judge A','judge',?),(?, 'Judge B','judge',?)",
    )
    .bind(
      judgeA.identity_id,
      'a'.repeat(64),
      judgeB.identity_id,
      'b'.repeat(64),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES('assignment-a',?,'team-a','organizer:test'),('assignment-b',?,'team-a','organizer:test')",
    )
    .bind(judgeA.identity_id, judgeB.identity_id)
    .run();
  await db
    .prepare(
      "INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES('participant-id','Team A participant','participant','team-a',?)",
    )
    .bind('p'.repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO team_documents(id,team_id,version,object_key,filename,content_type,bytes,sha256,status,uploaded_by_identity_id) VALUES('document-a','team-a',1,'analysis-documents/a','analysis.pdf','application/pdf',12,?,'STORED',?)",
    )
    .bind('c'.repeat(64), 'participant-id')
    .run();
  env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => {
  await mf.dispose();
});

describe('draft score exclusion from persisted results', () => {
  it('excludes drafts from averages until finalized, including mixed draft/final reviews', async () => {
    const initial = await results();
    expect(initial).toMatchObject({
      analysisAverage: null,
      analysisJudgeCount: 0,
      status: 'PENDING',
      finalScore: null,
    });

    const draftA = await saveDraft(judgeA, 40);
    expect(draftA.status).toBe(200);
    expect(await results()).toMatchObject({
      analysisAverage: null,
      analysisJudgeCount: 0,
      status: 'PENDING',
      finalScore: null,
    });

    const submittedA = await submitDraft(judgeA);
    expect(submittedA.status).toBe(201);
    await saveDraft(judgeB, 100);
    expect(await results()).toMatchObject({
      analysisAverage: 40,
      analysisJudgeCount: 1,
      status: 'PENDING',
      finalScore: null,
    });
  });
});
