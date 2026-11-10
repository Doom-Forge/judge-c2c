import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import {
  DOCX_CONTENT_TYPE,
  MAX_ANALYSIS_DOCUMENT_BYTES,
  participantDocuments,
} from '../src/round-two-documents';
import type { ConsoleSession } from '../src/console-identities';
import type { Env } from '../src/env';

const origin = 'https://organization.test',
  encoder = new TextEncoder();
let mf: Miniflare, env: Env;
const participant: ConsoleSession = {
  hash: 'participant-session',
  role: 'participant',
  identity_id: 'participant-identity',
  name: 'Team A',
  team_id: 'team-a',
};

function uploadRequest(
  filename: string,
  bytes: Uint8Array,
  contentType = 'application/octet-stream',
) {
  const form = new FormData();
  form.set(
    'file',
    new File([bytes as Uint8Array<ArrayBuffer>], filename, {
      type: contentType,
    }),
  );
  return new Request(origin + '/api/organization/participant/documents', {
    method: 'POST',
    body: form,
  });
}

function write16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function write32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function storedZip(entries: Record<string, string>) {
  const local: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let localOffset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = encoder.encode(name),
      content = encoder.encode(text),
      localHeader = new Uint8Array(30 + filename.length + content.length),
      localView = new DataView(localHeader.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write32(localView, 18, content.length);
    write32(localView, 22, content.length);
    write16(localView, 26, filename.length);
    localHeader.set(filename, 30);
    localHeader.set(content, 30 + filename.length);
    local.push(localHeader);

    const centralHeader = new Uint8Array(46 + filename.length),
      centralView = new DataView(centralHeader.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, 20);
    write16(centralView, 6, 20);
    write32(centralView, 20, content.length);
    write32(centralView, 24, content.length);
    write16(centralView, 28, filename.length);
    write32(centralView, 42, localOffset);
    centralHeader.set(filename, 46);
    central.push(centralHeader);
    localOffset += localHeader.length;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0),
    end = new Uint8Array(22),
    endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 8, central.length);
  write16(endView, 10, central.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, localOffset);
  return Uint8Array.from(
    [...local, ...central, end].flatMap((part) => [...part]),
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
    .prepare("INSERT INTO teams(id,name) VALUES('team-a','Team A')")
    .run();
  await db
    .prepare(
      "INSERT INTO console_identities(id,name,role,team_id,credential_hash) VALUES('participant-identity','Team A lead','participant','team-a',?)",
    )
    .bind('a'.repeat(64))
    .run();
  env = {
    ORG_DB: db,
    ARTIFACTS: {
      async put() {},
      async get() {
        return null;
      },
      async delete() {},
    },
  } as unknown as Env;
});

afterEach(async () => {
  await mf.dispose();
});

describe('server-side analysis document upload validation', () => {
  it('accepts PDF and DOCX content based on bytes regardless of client MIME', async () => {
    const pdf = await participantDocuments(
        uploadRequest(
          'analysis.pdf',
          encoder.encode('%PDF-1.7\ncontent'),
          'image/png',
        ),
        env,
        participant,
      ),
      docxBytes = storedZip({
        '[Content_Types].xml': '<Types></Types>',
        'word/document.xml': '<w:document></w:document>',
      }),
      docx = await participantDocuments(
        uploadRequest('analysis.docx', docxBytes, 'text/plain'),
        env,
        participant,
      );

    expect(pdf.status).toBe(201);
    expect(await pdf.json()).toMatchObject({
      document: { content_type: 'application/pdf' },
    });
    expect(docx.status).toBe(201);
    expect(await docx.json()).toMatchObject({
      document: { content_type: DOCX_CONTENT_TYPE },
    });
  });

  it.each([
    [
      'PDF extension with DOCX content',
      'analysis.pdf',
      storedZip({
        '[Content_Types].xml': '<Types></Types>',
        'word/document.xml': '<w:document></w:document>',
      }),
    ],
    [
      'DOCX extension with PDF content',
      'analysis.docx',
      encoder.encode('%PDF-1.7\ncontent'),
    ],
    [
      'supported extension with invalid content',
      'analysis.pdf',
      encoder.encode('not a PDF'),
    ],
    [
      'unsupported extension with PDF content',
      'analysis.exe',
      encoder.encode('%PDF-1.7\ncontent'),
    ],
  ])('rejects %s at the server boundary', async (_case, filename, bytes) => {
    const response = await participantDocuments(
      uploadRequest(filename, bytes, 'application/pdf'),
      env,
      participant,
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: 'DOCUMENT_TYPE_INVALID',
    });
  });

  it('accepts a document exactly at the maximum size and rejects one byte over', async () => {
    const atLimit = new Uint8Array(MAX_ANALYSIS_DOCUMENT_BYTES);
    atLimit.set(encoder.encode('%PDF-1.7'));
    const accepted = await participantDocuments(
        uploadRequest('at-limit.pdf', atLimit, 'application/pdf'),
        env,
        participant,
      ),
      overLimit = new Uint8Array(MAX_ANALYSIS_DOCUMENT_BYTES + 1);
    overLimit.set(encoder.encode('%PDF-1.7'));
    const rejected = await participantDocuments(
      uploadRequest('over-limit.pdf', overLimit, 'application/pdf'),
      env,
      participant,
    );

    expect(accepted.status).toBe(201);
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({ error: 'DOCUMENT_LIMIT' });
  });
});
