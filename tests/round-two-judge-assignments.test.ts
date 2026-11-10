import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import type { ConsoleSession } from '../src/console-identities';
import type { Env } from '../src/env';
import { roundTwoReview } from '../src/round-two-review';

let mf: Miniflare, env: Env;
const origin = 'https://organization.test',
  organizer: ConsoleSession = {
    hash: 'organizer-session',
    role: 'organizer',
    identity_id: 'organizer-identity',
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
  };

function request(path: string, method = 'GET', data?: unknown) {
  return new Request(origin + '/api/organization/round-two' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
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
      "INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Judge A','judge',NULL,?),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Judge B','judge',NULL,?)",
    )
    .bind('a'.repeat(64), 'b'.repeat(64))
    .run();
  env = { ORG_DB: db } as unknown as Env;
});

afterEach(async () => {
  await mf.dispose();
});

describe('judge team assignments', () => {
  it('lets organizers assign an active judge to an active team', async () => {
    const response = await roundTwoReview(
      request('/assignments', 'POST', {
        judgeIdentityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        teamId: 'team-a',
      }),
      env,
      organizer,
    );

    expect(response.status).toBe(201);
  });

  it('shows judges only the teams assigned to their identity', async () => {
    await roundTwoReview(
      request('/assignments', 'POST', {
        judgeIdentityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        teamId: 'team-a',
      }),
      env,
      organizer,
    );
    const response = await roundTwoReview(request('/teams'), env, judgeA),
      result = (await response.json()) as {
        teams: { id: string; name: string; status: string }[];
      };

    expect(result.teams).toMatchObject([
      { id: 'team-a', name: 'Team A', status: 'ACTIVE' },
    ]);
  });

  it('denies judges access to unassigned team details and mutations', async () => {
    const detail = await roundTwoReview(request('/teams/team-b'), env, judgeA),
      mutation = await roundTwoReview(
        request('/assignments', 'POST', {
          judgeIdentityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          teamId: 'team-b',
        }),
        env,
        judgeA,
      );

    expect([detail.status, mutation.status]).toEqual([404, 403]);
  });

  it('revokes access while retaining the assignment and audit history', async () => {
    const created = await roundTwoReview(
        request('/assignments', 'POST', {
          judgeIdentityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          teamId: 'team-a',
        }),
        env,
        organizer,
      ),
      createdResult = (await created.json()) as {
        assignment: { id: string };
      },
      revoked = await roundTwoReview(
        request('/assignments/' + createdResult.assignment.id, 'DELETE', {
          reason: 'Reassigned to another judge.',
        }),
        env,
        organizer,
      ),
      teamsResponse = await roundTwoReview(request('/teams'), env, judgeA),
      teams = (await teamsResponse.json()) as {
        teams: { id: string }[];
      },
      assignmentsResponse = await roundTwoReview(
        request('/assignments'),
        env,
        organizer,
      ),
      assignments = (await assignmentsResponse.json()) as {
        assignments: {
          revoked_at: string | null;
          reason: string | null;
        }[];
      };

    expect({
      status: revoked.status,
      visibleTeams: teams.teams.length,
      revokedAt: Boolean(assignments.assignments[0]?.revoked_at),
      reason: assignments.assignments[0]?.reason,
    }).toEqual({
      status: 200,
      visibleTeams: 0,
      revokedAt: true,
      reason: 'Reassigned to another judge.',
    });
  });
});
