import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import type { ConsoleSession } from '../src/console-identities';
import type { Env } from '../src/env';
import { roundTwoEvaluations } from '../src/round-two-evaluations';
import { roundTwoReview } from '../src/round-two-review';

const origin = 'https://organization.test';
const judgeAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const judgeBId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const judgeA: ConsoleSession = {
  hash: 'judge-a',
  role: 'judge',
  identity_id: judgeAId,
  name: 'Judge A',
  team_id: null,
};
const judgeB: ConsoleSession = {
  hash: 'judge-b',
  role: 'judge',
  identity_id: judgeBId,
  name: 'Judge B',
  team_id: null,
};
const organizer: ConsoleSession = {
  hash: 'organizer',
  role: 'organizer',
  identity_id: 'organizer',
  name: 'Organizer',
  team_id: null,
};
let mf: Miniflare;
let env: Env;

function request(path: string) {
  return new Request(origin + '/api/organization/round-two' + path);
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
      "INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES(?, 'Judge A','judge',NULL,?),(?, 'Judge B','judge',NULL,?)",
    )
    .bind(judgeAId, 'a'.repeat(64), judgeBId, 'b'.repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES('assignment-a',?,'team-a','organizer:test'),('assignment-b',?,'team-b','organizer:test')",
    )
    .bind(judgeAId, judgeBId)
    .run();
  env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => {
  await mf.dispose();
});

describe('judge assignment access isolation', () => {
  it('limits team and assignment listings to the judge while preserving organizer visibility', async () => {
    const [teamsResponse, assignmentsResponse, organizerResponse] =
      await Promise.all([
        roundTwoReview(request('/teams'), env, judgeA),
        roundTwoReview(request('/assignments'), env, judgeA),
        roundTwoReview(request('/assignments'), env, organizer),
      ]);
    const teams = (await teamsResponse.json()) as { teams: { id: string }[] };
    const assignments = (await assignmentsResponse.json()) as {
      assignments: { team_id: string; judge_identity_id: string }[];
    };
    const organizerAssignments = (await organizerResponse.json()) as {
      assignments: unknown[];
    };
    expect(teams.teams.map(({ id }) => id)).toEqual(['team-a']);
    expect(assignments.assignments).toMatchObject([
      { team_id: 'team-a', judge_identity_id: judgeAId },
    ]);
    expect(organizerAssignments.assignments).toHaveLength(2);
  });

  it('returns stage review data only for the assigned team and assigned judge', async () => {
    await env
      .ORG_DB!.prepare(
        "INSERT INTO round_two_review_submissions(id,team_id,judge_identity_id,stage,revision,score,payload,reason) VALUES('review-a','team-a',?,'ANALYSIS',1,80,'{}','Initial submission'),('review-b','team-b',?,'ANALYSIS',1,90,'{}','Initial submission')",
      )
      .bind(judgeAId, judgeBId)
      .run();
    const [assigned, unassigned] = await Promise.all([
      roundTwoEvaluations(
        request('/reviews?teamId=team-a&stage=ANALYSIS'),
        env,
        judgeA,
      ),
      roundTwoEvaluations(
        request('/reviews?teamId=team-b&stage=ANALYSIS'),
        env,
        judgeA,
      ),
    ]);
    const result = (await assigned.json()) as {
      submissions: { team_id: string; judge_identity_id: string }[];
    };
    expect(result.submissions).toMatchObject([
      { team_id: 'team-a', judge_identity_id: judgeAId },
    ]);
    expect(unassigned.status).toBe(404);
  });
});
