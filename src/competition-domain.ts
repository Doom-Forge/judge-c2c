import { z } from 'zod';
export const teamStatus = z.enum([
  'PENDING',
  'ACTIVE',
  'WITHDRAWN',
  'DISQUALIFIED',
  'COMPLETED',
]);
const identifier = z.string().regex(/^[\w.-]{1,80}$/);
const category = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const eventPolicySchema = z
  .object({
    claimingEnabled: z.boolean().default(false),
    organizerMappingOverrideAllowed: z.boolean().default(true),
    allowDraftSubmissions: z.boolean().default(false),
    maxRepositoriesPerTeam: z.number().int().min(1).max(100).default(10),
    multipleIssuesPerPR: z.boolean().default(true),
    multiplePRsPerIssue: z.boolean().default(true),
    participantRegistration: z
      .literal('ORGANIZER_ONLY')
      .default('ORGANIZER_ONLY'),
    discoveryCredit: z
      .enum(['NONE', 'RECOGNITION', 'BONUS_REVIEW', 'SCORED_REVIEW'])
      .default('RECOGNITION'),
    completionOverrideAllowed: z.boolean().default(false),
    organizerGitHubIds: z
      .array(z.number().int().positive())
      .max(100)
      .default([]),
  })
  .strict();
export const defaultTypes = [
  'bug',
  'feature',
  'performance',
  'security',
  'testing',
  'analytics',
  'architecture',
  'documentation',
  'ai-ml',
  'language-conversion',
  'refactor',
  'infrastructure',
  'accessibility',
  'reliability',
  'usability',
  'clarification',
];
export const taxonomySchema = z
  .array(
    z
      .object({
        name: z
          .string()
          .regex(
            /^judge:(type|source|status|evaluation|priority|difficulty|domain):[a-z][a-z0-9-]{0,39}$/,
          ),
        color: z.string().regex(/^[a-f0-9]{6}$/),
        description: z.string().max(100),
      })
      .strict(),
  )
  .min(1)
  .max(100)
  .refine((xs) => new Set(xs.map((x) => x.name)).size === xs.length);
export const defaultTaxonomy = [
  ...defaultTypes.map((type) => ({
    name: 'judge:type:' + type,
    color: type === 'security' ? 'b60205' : '0969da',
    description: 'Judge-C2C type: ' + type,
  })),
  ...['participant', 'organizer', 'unknown'].map((source) => ({
    name: 'judge:source:' + source,
    color: '8250df',
    description: 'Issue provenance; not proof of official approval',
  })),
  ...[
    'needs-triage',
    'needs-information',
    'possible-duplicate',
    'available',
    'assigned',
    'in-progress',
    'needs-review',
    'completed',
    'blocked',
    'rejected',
    'duplicate',
    'security-review',
    'possible-spam',
  ].map((status) => ({
    name: 'judge:status:' + status,
    color: 'fbca04',
    description: 'Judge-C2C workflow: ' + status,
  })),
  ...['critical', 'high', 'medium', 'low'].map((value) => ({
    name: 'judge:priority:' + value,
    color: 'fbca04',
    description: 'Advisory priority; organizer decisions take precedence',
  })),
  ...['easy', 'medium', 'hard', 'expert'].map((value) => ({
    name: 'judge:difficulty:' + value,
    color: 'c2e0c6',
    description: 'Advisory difficulty; not an objective score',
  })),
  ...[
    'frontend',
    'backend',
    'database',
    'api',
    'security',
    'cloud',
    'devops',
    'ai',
    'testing',
  ].map((value) => ({
    name: 'judge:domain:' + value,
    color: 'bfdadc',
    description: 'Advisory affected component',
  })),
  ...['mandatory', 'optional', 'bonus', 'not-scored', 'approved-challenge'].map(
    (kind) => ({
      name: 'judge:evaluation:' + kind,
      color: '0e8a16',
      description: 'Judge-C2C approved evaluation scope',
    }),
  ),
];
export const memberSchema = z
  .object({
    githubLogin: z
      .string()
      .trim()
      .regex(/^@?[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/)
      .optional(),
    displayName: z.string().trim().min(1).max(100),
    email: z.email().max(200).optional(),
    externalId: z.string().max(100).optional(),
  })
  .strict()
  .refine((member) => Boolean(member.githubLogin || member.email), {
    message: 'MEMBER_EMAIL_OR_GITHUB_REQUIRED',
  });
export const teamCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    leadEmail: z.email().max(200).optional(),
    status: teamStatus.default('PENDING'),
    metadata: z.record(z.string().max(50), z.string().max(500)).default({}),
    members: z.array(memberSchema).min(1).max(30),
    repositoryIds: z.array(z.number().int().positive()).max(100).default([]),
  })
  .strict();
export const teamUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    status: teamStatus.optional(),
    metadata: z.record(z.string().max(50), z.string().max(500)).optional(),
  })
  .strict()
  .refine((x) => Object.keys(x).length > 0);
export const assignmentInput = z
  .object({
    teamId: identifier,
    repositoryId: z.number().int().positive(),
    issueNumber: z.number().int().positive(),
    reservation: z.boolean().default(false),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();
export const reviewIssueSchema = z
  .object({
    reviewStatus: z.enum([
      'NEEDS_TRIAGE',
      'APPROVED',
      'REJECTED',
      'DUPLICATE',
      'NEEDS_INFORMATION',
      'RECOGNIZED',
    ]),
    type: category.nullable().optional(),
    priority: z
      .enum(['critical', 'high', 'medium', 'low'])
      .nullable()
      .optional(),
    difficulty: z
      .enum(['easy', 'medium', 'hard', 'expert'])
      .nullable()
      .optional(),
    severity: z
      .enum(['critical', 'high', 'medium', 'low', 'info'])
      .nullable()
      .optional(),
    suppressedLabels: z.array(z.string().min(1).max(100)).max(100).optional(),
    preservedLabels: z.array(z.string().min(1).max(100)).max(100).optional(),
    clarification: z.string().trim().min(10).max(2000).optional(),
    canonicalNumber: z.number().int().positive().optional(),
    recognition: z.string().min(10).max(1000).optional(),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
export interface GitHubIdentity {
  id: number;
  login: string;
}
export function linkedIssueNumbers(description: string, fullName: string) {
  const local = new Set<number>(),
    foreign: string[] = [];
  const pattern =
    /\b(?:fix(?:es|ed)?|clos(?:e|es|ed)|resolv(?:e|es|ed)|referenc(?:e|es|ed)|address(?:es|ed)?|implement(?:s|ed)?)\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|([\w.-]+\/[\w.-]+)#|#)([1-9]\d{0,8})/gi;
  for (const match of description.matchAll(pattern)) {
    const repository = match[1] ?? match[2];
    if (repository && repository.toLowerCase() !== fullName.toLowerCase()) {
      foreign.push(repository + '#' + match[3]);
    } else local.add(Number(match[3]));
  }
  return { local: [...local].sort((a, b) => a - b), foreign };
}
export function classifyIssue(
  title: string,
  body: string,
  labels: string[],
  types = defaultTypes,
) {
  const present = labels
    .filter((x) => x.startsWith('judge:type:'))
    .map((x) => x.slice(11))
    .filter((x) => types.includes(x));
  const text = (title + '\n' + body).toLowerCase();
  const rules: Record<string, RegExp> = {
    security:
      /\b(vulnerability|sql injection|xss|credential leak|authorization bypass|security)\b/,
    performance: /\b(performance|latency|slow|benchmark|memory leak)\b/,
    bug: /\b(bug|crash(?:es|ed|ing)?|incorrect|fails|failure|broken)\b/,
    documentation: /\b(documentation|readme|typo|docs)\b/,
    testing: /\b(test coverage|missing test|unit test)\b/,
    clarification: /\b(clarification|ambiguous|acceptance criteria unclear)\b/,
    feature: /\b(feature request|new feature|enhancement)\b/,
    analytics: /\b(analytics|reporting dashboard|funnel analysis)\b/,
    architecture: /\b(architecture|component boundaries|layer bypass)\b/,
    'ai-ml': /\b(machine learning|model inference|ai pipeline)\b/,
    'language-conversion':
      /\b(language conversion|port to python|port to typescript)\b/,
    refactor: /\b(refactor|duplicated logic)\b/,
    infrastructure:
      /\b(devops|deployment pipeline|infrastructure|ci configuration)\b/,
    accessibility: /\b(accessibility|screen reader|keyboard navigation)\b/,
    reliability: /\b(reliability|retry policy|fault tolerance)\b/,
    usability: /\b(usability|user experience|confusing interface)\b/,
  };
  const candidates = Object.entries(rules)
    .filter(([type, rule]) => types.includes(type) && rule.test(text))
    .map(([type]) => type);
  const security =
    candidates.includes('security') || present.includes('security');
  const type =
    present.length === 1
      ? present[0]
      : present.length > 1
        ? null
        : security
          ? 'security'
          : candidates.length === 1
            ? candidates[0]
            : null;
  const flags: string[] = [];
  if (!type) flags.push('needs-triage');
  if (body.trim().length < 40) flags.push('needs-information');
  if (security) flags.push('security-review');
  if (type === 'bug' && !/\b(reproduc|steps|expected|actual)\b/i.test(body)) {
    flags.push('needs-information');
  }
  const explicit = (field: string, allowed: string[]) => {
    const values = [
      ...new Set(
        [
          ...text.matchAll(
            new RegExp(
              '^\\s*' + field + ':\\s*(' + allowed.join('|') + ')\\s*$',
              'gm',
            ),
          ),
        ].map((m) => m[1]!),
      ),
    ];
    if (values.length > 1) flags.push('needs-triage');
    return values.length === 1 ? values[0]! : null;
  };
  const priority = explicit('priority', ['critical', 'high', 'medium', 'low']);
  const difficulty = explicit('difficulty', [
    'easy',
    'medium',
    'hard',
    'expert',
  ]);
  const domains = Object.entries({
    frontend: /\b(frontend|browser|screen reader)\b/,
    backend: /\b(backend|server|endpoint)\b/,
    database: /\b(database|sql|migration)\b/,
    api: /\b(api|endpoint)\b/,
    security: /\b(security|vulnerability|xss)\b/,
    cloud: /\b(cloud|cloudflare)\b/,
    devops: /\b(devops|deployment|ci)\b/,
    ai: /\b(machine learning|ai pipeline)\b/,
    testing: /\b(unit test|test coverage)\b/,
  })
    .filter(([, rule]) => rule.test(text))
    .map(([domain]) => domain);
  return {
    type: type ?? null,
    priority,
    difficulty,
    severity: null,
    domains,
    advisory: true,
    flags: [...new Set(flags)],
    provenance: present.length ? 'github-label' : 'rule',
    ruleVersion: 'triage-v2',
  };
}
export function possibleDuplicates(
  title: string,
  others: { number: number; title: string }[],
) {
  const tokens = (s: string) =>
    new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const current = tokens(title);
  if (current.size < 3) return [];
  return others
    .filter((o) => {
      const other = tokens(o.title),
        common = [...current].filter((t) => other.has(t)).length;
      return common / Math.max(current.size, other.size) >= 0.8;
    })
    .slice(0, 5)
    .map((o) => o.number);
}
export function parseTeamCSV(text: string) {
  if (Buffer.byteLength(text) > 100000) throw new Error('IMPORT_SIZE_LIMIT');
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (!value || quoted) quoted = !quoted;
      else throw new Error('INVALID_CSV');
    } else if (c === ',' && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = '';
    } else value += c;
  }
  if (quoted) throw new Error('INVALID_CSV');
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  const headers = rows
    .shift()
    ?.map((h) => h.replace(/^\uFEFF/, '').toLowerCase());
  if (
    !headers ||
    !['team_name', 'participant_name'].every((h) =>
      headers.includes(h),
    ) ||
    new Set(headers).size !== headers.length
  ) {
    throw new Error('IMPORT_HEADERS_REQUIRED');
  }
  if (rows.length > 100) throw new Error('IMPORT_ROW_LIMIT');
  const teams = new Map<
    string,
    {
      name: string;
      status: z.infer<typeof teamStatus>;
      repositoryNames: string[];
      leadEmail?: string;
      members: z.infer<typeof memberSchema>[];
      repositoryIds: number[];
      initialIssues: { repository: string; issueNumber: number }[];
    }
  >();
  for (const cells of rows) {
    if (cells.length !== headers.length) {
      throw new Error('INVALID_CSV_COLUMNS');
    }
    const entry = Object.fromEntries(headers.map((h, i) => [h, cells[i]!]));
    const name = entry.team_name!;
    const leadEmail = entry.team_lead_email
      ? z.email().max(200).parse(entry.team_lead_email).toLowerCase()
      : undefined;
    let team = teams.get(name);
    if (!team) {
      team = {
        name,
        status: teamStatus.parse(entry.team_status || 'PENDING'),
        repositoryNames: [],
        leadEmail,
        members: [],
        repositoryIds: [],
        initialIssues: [],
      };
      teams.set(name, team);
    } else if (
      entry.team_status &&
      team.status !== teamStatus.parse(entry.team_status)
    ) {
      throw new Error('IMPORT_CONFLICTING_TEAM_STATUS');
    }
    if (
      leadEmail &&
      team.leadEmail &&
      leadEmail.toLowerCase() !== team.leadEmail.toLowerCase()
    ) {
      throw new Error('IMPORT_CONFLICTING_TEAM_LEAD');
    }
    if (leadEmail) team.leadEmail ??= leadEmail;
    const participantEmail = entry.email
      ? z.email().max(200).parse(entry.email).toLowerCase()
      : undefined;
    team.members.push(
      memberSchema.parse({
        ...(entry.github_username
          ? { githubLogin: entry.github_username }
          : {}),
        displayName: entry.participant_name,
        ...(participantEmail ? { email: participantEmail } : {}),
        ...(entry.external_id ? { externalId: entry.external_id } : {}),
      }),
    );
    if (entry.repository && entry.issue_number) {
      const issueNumber = Number(entry.issue_number);
      if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
        throw new Error('INVALID_ISSUE_NUMBER');
      }
      if (
        !team.initialIssues.some(
          (i) =>
            i.repository === entry.repository && i.issueNumber === issueNumber,
        )
      ) {
        team.initialIssues.push({
          repository: entry.repository,
          issueNumber,
        });
      }
    }
    if (entry.repository && !team.repositoryNames.includes(entry.repository)) {
      team.repositoryNames.push(entry.repository);
    }
  }
  return [...teams.values()];
}
