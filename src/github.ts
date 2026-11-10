import { requireOrganizationActive } from './organization-retirement';
import { importPKCS8, SignJWT } from 'jose';
import { pathSchema, sha, type Contract } from './domain';
import { boundedBody } from './security';
import type { Env } from './env';
import { observe } from './operational-telemetry';
import { githubBackoffActive, recordGitHubBackoff } from './reviewer-capacity';
export type ChangedFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  patchTruncated?: boolean;
};
export class GitHub {
  constructor(
    private token?: string,
    private db?: D1Database,
    private capacityDB?: D1Database,
  ) {}
  static async application(env: Env) {
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
      throw new Error('GITHUB_APP_NOT_CONFIGURED');
    const key = await importPKCS8(
      env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
      'RS256',
    );
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(env.GITHUB_APP_ID)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 540)
      .sign(key);
    return new GitHub(jwt, env.DB, env.CAPACITY_DB ?? env.DB);
  }
  static async installation(
    env: Env,
    contract: Contract,
    options: {
      issuesWrite?: boolean;
      checksWrite?: boolean;
      pullRequestsWrite?: boolean;
    } = {},
  ) {
    await requireOrganizationActive(env);
    const client = await GitHub.application(env);
    await requireOrganizationActive(env);
    const response = await client.api<{ token: string }>(
      `/app/installations/${contract.repository.installationId}/access_tokens`,
      {
        method: 'POST',
        body: JSON.stringify({
          repository_ids: [contract.repository.id],
          permissions: {
            contents: 'read',
            pull_requests: options.pullRequestsWrite ? 'write' : 'read',
            issues: options.issuesWrite ? 'write' : 'read',
            ...(options.checksWrite === false ? {} : { checks: 'write' }),
          },
        }),
      },
    );
    return new GitHub(response.token, env.DB, env.CAPACITY_DB ?? env.DB);
  }
  async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new Error('Invalid GitHub path');
    const started = Date.now();
    let failed = false;
    let rateLimited = false;
    try {
      const coordinator = this.capacityDB;
      if (coordinator && (await githubBackoffActive(coordinator))) {
        rateLimited = true;
        throw new Error('GITHUB_RATE_LIMITED');
      }
      const response = await fetch('https://api.github.com' + path, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(25_000),
        headers: {
          accept: 'application/vnd.github+json',
          ...(this.token ? { authorization: 'Bearer ' + this.token } : {}),
          'user-agent': 'Judge-C2C',
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
        },
      });
      rateLimited =
        response.status === 429 ||
        (response.status === 403 && response.headers.has('retry-after')) ||
        response.headers.get('x-ratelimit-remaining') === '0';
      if (rateLimited && coordinator)
        await recordGitHubBackoff(coordinator, response.headers);
      if (!response.ok && rateLimited && coordinator)
        throw new Error('GITHUB_RATE_LIMITED');
      if (!response.ok) throw new Error(`GITHUB_HTTP_${response.status}`);
      if (response.status === 204) return undefined as T;
      const bytes = await boundedBody(
        new Request('https://internal/', {
          method: 'POST',
          body: response.body,
          duplex: 'half',
        } as RequestInit),
        2_000_000,
      );
      if (response.status === 202 && bytes.length === 0) return undefined as T;
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await Promise.all([
        observe(this.db, 'github.request'),
        observe(this.db, 'github.latencyMs', Math.max(0, Date.now() - started)),
        ...(failed ? [observe(this.db, 'github.error')] : []),
        ...(rateLimited ? [observe(this.db, 'github.rateLimited')] : []),
      ]);
    }
  }
  async compare(contract: Contract, head: string) {
    const result = await this.api<{
      merge_base_commit: { sha: string };
      files?: ChangedFile[];
      status: string;
    }>(
      `/repos/${contract.repository.fullName}/compare/${contract.baseline}...${head}`,
    );
    if (result.merge_base_commit.sha !== contract.baseline)
      throw new Error('BASELINE_NOT_ANCESTOR');
    if (
      !result.files ||
      result.files.length >= 300 ||
      result.files.length > contract.execution.maxFiles
    )
      throw new Error('DIFF_LIMIT');
    return result.files;
  }
  async publicFile(repo: string, commit: string, path: string, max: number) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error('INVALID_PUBLIC_REPOSITORY');
    sha.parse(commit);
    pathSchema.parse(path);
    const escaped = path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(
      `https://raw.githubusercontent.com/${repo}/${commit}/${escaped}`,
      {
        redirect: 'manual',
        signal: AbortSignal.timeout(25000),
        headers: { 'user-agent': 'Judge-C2C' },
      },
    );
    if (response.status === 404) return '';
    if (!response.ok) throw new Error(`GITHUB_RAW_HTTP_${response.status}`);
    try {
      const bytes = await boundedBody(
        new Request('https://internal/', {
          method: 'POST',
          body: response.body,
          duplex: 'half',
        } as RequestInit),
        max,
      );
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        bytes,
      );
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error instanceof Error && error.message === 'BODY_LIMIT')
      )
        return null;
      throw error;
    }
  }
  async file(repo: string, commit: string, path: string, max: number) {
    const escaped = path.split('/').map(encodeURIComponent).join('/');
    try {
      const value = await this.api<{
        type: string;
        encoding?: string;
        content?: string;
        size: number;
      }>(`/repos/${repo}/contents/${escaped}?ref=${commit}`);
      if (
        value.type !== 'file' ||
        value.encoding !== 'base64' ||
        value.size > max ||
        !value.content
      )
        return null;
      const bytes = Uint8Array.from(
        atob(value.content.replace(/\s/g, '')),
        (c) => c.charCodeAt(0),
      );
      if (bytes.length > max) return null;
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        bytes,
      );
    } catch (error) {
      if (error instanceof TypeError) return null;
      if (error instanceof Error && error.message === 'GITHUB_HTTP_404')
        return '';
      throw error;
    }
  }
}
