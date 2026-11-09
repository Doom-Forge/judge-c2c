import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import type { ConsoleSession } from '../src/console-identities';
import type { Env } from '../src/env';
import { roundTwoReview } from '../src/round-two-review';

let mf: Miniflare, env: Env, storedObjects: Map<string, Uint8Array>;
const origin = 'https://organization.test',
  documentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
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

function request(teamId: string, id = documentId) {
  return new Request(
    `${origin}/api/organization/round-two/teams/${teamId}/documents/${id}`,
  );
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
      "INSERT INTO console_identities(id,name,role,credential_hash) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Judge A','judge',?),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Judge B','judge',?)",
    )
    .bind('a'.repeat(64), 'b'.repeat(64))
    .run();
  await db
    .prepare(
      "INSERT INTO round_two_judge_assignments(id,judge_identity_id,team_id,assigned_by) VALUES('11111111-1111-4111-8111-111111111111',?,'team-a','organizer')",
    )
    .bind(judgeA.identity_id)
    .run();
  const bytes = new TextEncoder().encode('%PDF-1.7 exact version');
  await db
    .prepare(
      "INSERT INTO team_documents(id,team_id,version,object_key,filename,content_type,bytes,sha256,uploaded_by_identity_id,status) VALUES(?, 'team-a', 2, 'private/object-key', ?, 'application/pdf', ?, ?, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'STORED'), ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','team-a',3,'private/pending-key','pending.pdf','application/pdf',1,?, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','PENDING')",
    )
    .bind(
      documentId,
      'report "final" ä.pdf',
      bytes.byteLength,
      'c'.repeat(64),
      'd'.repeat(64),
    )
    .run();
  storedObjects = new Map([['private/object-key', bytes]]);
  env = {
    ORG_DB: db,
    ARTIFACTS: {
      async get(key: string) {
        const value = storedObjects.get(key);
        return value
          ? {
              async arrayBuffer() {
                return value.slice().buffer;
              },
            }
          : null;
      },
    },
  } as unknown as Env;
});

afterEach(async () => {
  await mf.dispose();
});

describe('assigned judge document downloads', () => {
  it('serves the exact stored version with safe download headers', async () => {
    const response = await roundTwoReview(request('team-a'), env, judgeA);

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(
      '%PDF-1.7 exact version',
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toContain(
      'attachment; filename=',
    );
    expect(response.headers.get('content-disposition')).toContain(
      'filename="report _final_ _.pdf"',
    );
    expect(response.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''report%20%22final%22%20%C3%A4.pdf",
    );
    expect(response.headers.get('content-disposition')).not.toContain(
      'private/object-key',
    );
  });

  it('denies unassigned judges, mismatched teams, and pending documents', async () => {
    const unassigned = await roundTwoReview(request('team-a'), env, judgeB),
      otherTeam = await roundTwoReview(request('team-b'), env, judgeA),
      pending = await roundTwoReview(
        request('team-a', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
        env,
        judgeA,
      );

    expect([unassigned.status, otherTeam.status, pending.status]).toEqual([
      404, 404, 404,
    ]);
  });
});
