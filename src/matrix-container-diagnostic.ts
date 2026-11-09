import type { Env } from './env';
import { z } from 'zod';

const repositories = ['mazhai-cover', 'pricingpulse', 'veera-footwear', 'janus'] as const;
const commitsSchema = z.object({
  'mazhai-cover': z.string().regex(/^[a-f0-9]{40}$/),
  pricingpulse: z.string().regex(/^[a-f0-9]{40}$/),
  'veera-footwear': z.string().regex(/^[a-f0-9]{40}$/),
  janus: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

const targets = [
  ['mazhai-cover', 'MAZHAI_COVER_MATRIX'],
  ['pricingpulse', 'PRICINGPULSE_MATRIX'],
  ['veera-footwear', 'VEERA_FOOTWEAR_MATRIX'],
  ['janus', 'JANUS_MATRIX'],
] as const;

export interface DiagnosticSource { sha: string; code: string }

export async function readDiagnosticSources(raw: unknown): Promise<Record<(typeof repositories)[number], DiagnosticSource>> {
  const commits = commitsSchema.parse(raw);
  const sources = {} as Record<(typeof repositories)[number], DiagnosticSource>;
  for (const repository of repositories) {
    const sha = commits[repository];
    const response = await fetch(
      `https://raw.githubusercontent.com/180DC-VIT-CHENNAI/${repository}/${sha}/src/diagnostic.py`,
      { redirect: 'error', signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok || !response.body) throw new Error('MATRIX_DIAGNOSTIC_SOURCE_UNAVAILABLE');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 4096) throw new Error('MATRIX_DIAGNOSTIC_SOURCE_LIMIT');
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const content = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
    sources[repository] = { sha, code: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(content) };
  }
  return sources;
}

export async function diagnoseMatrixContainers(
  env: Env,
  sources: Record<(typeof targets)[number][0], DiagnosticSource>,
) {
  const results = [];
  for (const [repository, binding] of targets) {
    const namespace = env[binding];
    if (!namespace) {
      results.push({ repository, diagnosticOnly: true, status: 'NOT_CONFIGURED' });
      continue;
    }
    const source = sources[repository];
    try {
      const stub = namespace.get(namespace.newUniqueId()) as unknown as {
        diagnose(input: unknown): Promise<Record<string, unknown>>;
      };
      results.push(await stub.diagnose({ image: env.MATRIX_DIAGNOSTIC_IMAGE_URI, code: source.code, sourceSha: source.sha }));
    } catch {
      results.push({ repository, diagnosticOnly: true, status: 'FAILED', reason: 'container diagnostic failed' });
    }
  }
  return {
    diagnosticOnly: true,
    competitionMarks: false,
    status: results.every((result) => result.status === 'READY') ? 'READY' : 'INCOMPLETE',
    results,
  };
}
