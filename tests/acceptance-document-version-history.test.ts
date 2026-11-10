import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import { participantDocuments } from '../src/round-two-documents';
import type { ConsoleSession } from '../src/console-identities';
import type { Env } from '../src/env';

const origin = 'https://organization.test';
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
    .prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A')")
    .run();
  await db
    .prepare(
      "INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES('participant-identity','Team A lead','participant','team-a',?)",
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

describe('analysis document version history acceptance', () => {
  it('keeps replaced uploads immutable and reports the latest version metadata', async () => {
    const firstBytes = new TextEncoder().encode('%PDF-1.7\noriginal analysis'),
      replacementBytes = new TextEncoder().encode('%PDF-1.7\nrevised analysis'),
      firstResponse = await participantDocuments(
        uploadRequest('analysis-v1.pdf', firstBytes),
        env,
        participant,
      ),
      firstResult = (await firstResponse.json()) as {
        document: { id: string; version: number; sha256: string };
      },
      secondResponse = await participantDocuments(
        uploadRequest('analysis-v2.pdf', replacementBytes),
        env,
        participant,
      ),
      secondResult = (await secondResponse.json()) as {
        document: { id: string; version: number; sha256: string };
      };

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    expect(secondResult.document.version).toBe(
      firstResult.document.version + 1,
    );

    const historyResponse = await participantDocuments(
        new Request(origin + '/api/organization/participant/documents'),
        env,
        participant,
      ),
      history = (await historyResponse.json()) as {
        documents: Array<{
          id: string;
          version: number;
          filename: string;
          sha256: string;
          status: string;
        }>;
      };

    expect(historyResponse.status).toBe(200);
    expect(history.documents).toHaveLength(2);
    expect(history.documents).toEqual([
      expect.objectContaining({
        id: secondResult.document.id,
        version: 2,
        filename: 'analysis-v2.pdf',
        sha256: secondResult.document.sha256,
        status: 'STORED',
      }),
      expect.objectContaining({
        id: firstResult.document.id,
        version: 1,
        filename: 'analysis-v1.pdf',
        sha256: firstResult.document.sha256,
        status: 'STORED',
      }),
    ]);

    const firstDownload = await participantDocuments(
        new Request(
          origin +
            '/api/organization/participant/documents/' +
            firstResult.document.id,
        ),
        env,
        participant,
      ),
      secondDownload = await participantDocuments(
        new Request(
          origin +
            '/api/organization/participant/documents/' +
            secondResult.document.id,
        ),
        env,
        participant,
      );

    expect(new Uint8Array(await firstDownload.arrayBuffer())).toEqual(
      firstBytes,
    );
    expect(new Uint8Array(await secondDownload.arrayBuffer())).toEqual(
      replacementBytes,
    );
    expect(storedObjects.size).toBe(2);
  });
});
