import type { Env } from './env';

interface RegisteredRepository {
  id: number;
  full_name: string;
  document: string;
}

interface ConnectedRepository {
  id: number;
  full_name: string;
  private: number;
  default_branch: string;
  judging_configured: number;
}

export async function dashboardRepositories(env: Env) {
  const [registered, connected] = await Promise.all([
    env.DB.prepare(
      'SELECT r.*,c.document FROM repositories r JOIN contracts c ON c.hash=r.active_contract_hash',
    ).all<RegisteredRepository>(),
    env.ORG_DB
      ? env.ORG_DB.prepare(
          'SELECT g.id,g.full_name,g.private,g.default_branch,c.hash IS NOT NULL AS judging_configured FROM github_repositories g LEFT JOIN repositories r ON r.id=g.id LEFT JOIN contracts c ON c.hash=r.active_contract_hash AND c.repository_id=g.id WHERE g.accessible=1',
        ).all<ConnectedRepository>()
      : Promise.resolve({ results: [] as ConnectedRepository[] }),
  ]);
  const repositories = new Map<
    number,
    {
      id: number;
      full_name: string;
      connected: boolean;
      judgingConfigured: boolean;
      document?: string;
      private?: number;
      default_branch?: string;
    }
  >();
  for (const row of registered.results)
    repositories.set(row.id, {
      ...row,
      connected: false,
      judgingConfigured: true,
    });
  for (const row of connected.results) {
    const existing = repositories.get(row.id);
    repositories.set(row.id, {
      ...existing,
      id: row.id,
      full_name: row.full_name,
      private: row.private,
      default_branch: row.default_branch,
      connected: true,
      judgingConfigured:
        existing?.judgingConfigured || !!row.judging_configured,
    });
  }
  return [...repositories.values()].sort((a, b) =>
    a.full_name.localeCompare(b.full_name),
  );
}
