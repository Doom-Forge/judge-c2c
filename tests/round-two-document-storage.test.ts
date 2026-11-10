import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import { participantDocuments } from '../src/round-two-documents';
import { participantConsole } from '../src/console-identities';
import type { ConsoleSession } from '../src/console-identities';
import type { Env } from '../src/env';

const origin = 'https://organization.test',
  encoder = new TextEncoder();
let mf: Miniflare, env: Env, storedObjects: Map<string, Uint8Array>;
const participant: ConsoleSession = {
  hash: 'participant-session',
  role: 'participant',
  identity_id: 'participant-identity',
  name: 'Team A',
  team_id: 'team-a',
};

function uploadRequest(filename: string, bytes: Uint8Array) {
  const form = new FormData();
  form.set(
    'file',
    new File([bytes as Uint8Array<ArrayBuffer>], filename, {
      type: 'application/octet-stream',
    }),
  );
  return new Request(origin + '/api/organization/participant/documents', {
    method: 'POST',
    body: form,
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
  await db.prepare("UPDATE teams SET hackathon_id='initial',status='ACTIVE',lead_email='lead@example.test' WHERE id='team-a'").run();
  await db.prepare("UPDATE teams SET hackathon_id='initial',status='ACTIVE' WHERE id='team-b'").run();
  await db.prepare("INSERT INTO github_repositories(id,full_name,private,default_branch) VALUES(10,'Doom-Forge/mazhai-cover',0,'main')").run();
  await db.prepare("INSERT INTO team_repositories(team_id,repository_id,actor) VALUES('team-a',10,'organizer:test')").run();
  await db.prepare("UPDATE teams SET track_finalized=1 WHERE id='team-a'").run();
  await db.prepare("INSERT INTO team_roster_members(id,team_id,hackathon_id,display_name,email) VALUES('lead-roster','team-a','initial','Team Lead','lead@example.test')").run();
  await db
    .prepare(
      "INSERT INTO console_identities(id,name,role,team_id,team_roster_member_id,github_verified_at,credential_hash) VALUES('participant-identity','Team A lead','participant','team-a','lead-roster','2026-11-09',?)",
    )
    .bind('a'.repeat(64))
    .run();
  storedObjects = new Map();
  env = {
    ORG_DB: db,
    ARTIFACTS: {
      async put(key: string, value: Uint8Array) {
        storedObjects.set(key, Uint8Array.from(value));
      },
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
      async delete(key: string) {
        storedObjects.delete(key);
      },
    },
  } as unknown as Env;
});

afterEach(async () => {
  await mf.dispose();
});

describe('participant analysis document storage', () => {
  it('retains each upload version in private storage', async () => {
    const bytes = encoder.encode('%PDF-1.7\nteam analysis'),
      first = await participantDocuments(
        uploadRequest('analysis.pdf', bytes),
        env,
        participant,
      ),
      firstResult = (await first.json()) as {
        document?: { version: number; filename: string };
      },
      second = await participantDocuments(
        uploadRequest('revised.pdf', bytes),
        env,
        participant,
      ),
      secondResult = (await second.json()) as {
        document?: { version: number; filename: string };
      };

    expect(first.status).toBe(201);
    expect(firstResult.document).toMatchObject({
      version: 1,
      filename: 'analysis.pdf',
    });
    expect(secondResult.document).toMatchObject({
      version: 2,
      filename: 'revised.pdf',
    });
  });

  it('does not let another team download the uploaded document', async () => {
    const uploaded = await participantDocuments(
        uploadRequest(
          'analysis.pdf',
          encoder.encode('%PDF-1.7\nteam analysis'),
        ),
        env,
        participant,
      ),
      result = (await uploaded.json()) as { document: { id: string } },
      otherTeam = { ...participant, team_id: 'team-b' },
      denied = await participantDocuments(
        new Request(
          origin +
            '/api/organization/participant/documents/' +
            result.document.id,
        ),
        env,
        otherTeam,
      ),
      allowed = await participantDocuments(
        new Request(
          origin +
            '/api/organization/participant/documents/' +
            result.document.id,
        ),
        env,
        participant,
      );

    expect(denied.status).toBe(404);
    expect(allowed.status).toBe(200);
  });

  it('rejects uploads if private R2 storage is unavailable', async () => {
    env.ARTIFACTS = undefined;
    const response = await participantDocuments(
      uploadRequest('analysis.pdf', encoder.encode('%PDF-1.7\nteam analysis')),
      env,
      participant,
    );

    expect(response.status).toBe(503);
  });

  it('routes participant document uploads through the authenticated console', async () => {
    const response = await participantConsole(
      uploadRequest('analysis.pdf', encoder.encode('%PDF-1.7\nteam analysis')),
      env,
      participant,
    );

    expect(response.status).toBe(201);
  });
});
