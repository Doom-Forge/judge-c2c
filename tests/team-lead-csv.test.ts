import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare } from './miniflare';
import { migrate } from './database';
import { parseTeamCSV } from '../src/competition-domain';
import { importTeams, teamInsertStatements } from '../src/competition-teams';
import type { createTeam } from '../src/competition-teams';
import type { CompetitionServices } from '../src/competition-store';
import type { Env } from '../src/env';

let mf: Miniflare;
let env: Env;

beforeEach(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default{}',
    d1Databases: ['ORG_DB'],
    compatibilityDate: '2026-08-01',
  });
  const db = await mf.getD1Database('ORG_DB');
  await migrate(db as unknown as D1Database);
  env = {
    ORG_DB: db,
    ORG_VAULT_KEY: '12'.repeat(32),
    ORG_NAME: 'Pilot',
  } as unknown as Env;
});

afterEach(async () => mf.dispose());

describe('Unstop team lead import', () => {
  it('keeps the lead email separate from member email addresses', () => {
    const teams = parseTeamCSV(
      'team_name,participant_name,github_username,email,team_lead_email\nAlpha,Alice,alice,alice@example.test,lead@example.test\nAlpha,Bob,bob,bob@example.test,lead@example.test',
    );

    expect(teams[0]).toMatchObject({
      name: 'Alpha',
      leadEmail: 'lead@example.test',
      members: [
        { email: 'alice@example.test' },
        {
          email: 'bob@example.test',
        },
      ],
    });
  });

  it('accepts an email-only roster with no GitHub username or repository', () => {
    const teams = parseTeamCSV(
      'team_name,participant_name,email,team_lead_email,team_status\nAlpha,Alice,alice@example.test,lead@example.test,ACTIVE\nAlpha,Bob,bob@example.test,lead@example.test,ACTIVE',
    );

    expect(teams[0]).toMatchObject({
      name: 'Alpha',
      status: 'ACTIVE',
      leadEmail: 'lead@example.test',
      repositoryIds: [],
      members: [
        { displayName: 'Alice', email: 'alice@example.test' },
        { displayName: 'Bob', email: 'bob@example.test' },
      ],
    });
    expect(teams[0]?.members[0]).not.toHaveProperty('githubLogin');
  });

  it('rejects conflicting lead email addresses for one team', () => {
    expect(() =>
      parseTeamCSV(
        'team_name,participant_name,github_username,team_lead_email\nAlpha,Alice,alice,lead-one@example.test\nAlpha,Bob,bob,lead-two@example.test',
      ),
    ).toThrow('IMPORT_CONFLICTING_TEAM_LEAD');
  });

  it('keeps member email addresses when the lead email is also present', () => {
    const [team] = parseTeamCSV(
      'team_name,participant_name,github_username,email,team_lead_email\nAlpha,Alice,alice,alice@example.test,lead@example.test',
    );

    expect(team!.members[0]!.email).toBe('alice@example.test');
    expect(team!.leadEmail).toBe('lead@example.test');
  });

  it('persists the imported lead email with its team', () => {
    const prepared: { sql: string; values: unknown[] }[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            const statement = { sql, values };
            prepared.push(statement);
            return statement;
          },
        };
      },
    };
    const team = {
      id: 'team-alpha',
      name: 'Alpha',
      leadEmail: 'lead@example.test',
      status: 'PENDING',
      metadata: {},
      members: [],
      repositoryIds: [],
    } as unknown as Awaited<ReturnType<typeof createTeam>>;

    teamInsertStatements(
      { ORG_DB: db } as unknown as Env,
      'organizer:test',
      team,
    );

    expect(prepared[0]?.sql).toContain('lead_email');
    expect(prepared[0]?.values).toContain('lead@example.test');
  });

  it('persists the imported lead email in the organization database', async () => {
    const services = {
      client: async () => ({
        api: async () => ({
          id: 42,
          login: 'alice',
          type: 'User',
        }),
      }),
    } as unknown as CompetitionServices;
    await importTeams(env, services, 'organizer:test', {
      csv: 'team_name,participant_name,github_username,email,team_lead_email\nAlpha,Alice,alice,alice@example.test,lead@example.test',
      commit: true,
    });
    const team = await env
      .ORG_DB!.prepare("SELECT lead_email FROM teams WHERE name='Alpha'")
      .first<{ lead_email: string }>();

    expect(team?.lead_email).toBe('lead@example.test');
  });

  it('imports email-only members without inventing GitHub IDs or assigning a track', async () => {
    const services = {
      client: async () => {
        throw new Error('GitHub must not be queried for an email-only roster.');
      },
    } as unknown as CompetitionServices;
    await importTeams(env, services, 'organizer:test', {
      csv: [
        'team_name,participant_name,email,team_lead_email,team_status',
        'Beta,Alice,alice@example.test,lead@example.test,ACTIVE',
        'Beta,Bob,bob@example.test,lead@example.test,ACTIVE',
      ].join('\n'),
      commit: true,
    });
    const rows = await env.ORG_DB!
      .prepare(
        "SELECT r.display_name,r.email,m.github_id,m.github_login,t.lead_email FROM team_roster_members r JOIN teams t ON t.id=r.team_id LEFT JOIN team_members m ON m.id=r.linked_team_member_id WHERE t.name='Beta' ORDER BY r.display_name",
      )
      .all<{
        display_name: string;
        email: string;
        github_id: number | null;
        github_login: string | null;
        lead_email: string;
      }>();
    const repositories = await env.ORG_DB!
      .prepare(
        "SELECT COUNT(*) AS count FROM team_repositories tr JOIN teams t ON t.id=tr.team_id WHERE t.name='Beta' AND tr.active=1",
      )
      .first<{ count: number }>();
    expect(rows.results).toEqual([
      {
        display_name: 'Alice',
        email: 'alice@example.test',
        github_id: null,
        github_login: null,
        lead_email: 'lead@example.test',
      },
      {
        display_name: 'Bob',
        email: 'bob@example.test',
        github_id: null,
        github_login: null,
        lead_email: 'lead@example.test',
      },
      {
        display_name: 'Team Lead',
        email: 'lead@example.test',
        github_id: null,
        github_login: null,
        lead_email: 'lead@example.test',
      },
    ]);
    expect(repositories?.count).toBe(0);
  });
});
