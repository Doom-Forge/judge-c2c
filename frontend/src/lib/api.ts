import ky, { HTTPError } from 'ky';
import { z } from 'zod';
import {
  OrganizationStatusSchema,
  type OrganizationStatus,
} from '@/types/session';

const api = ky.create({
  prefixUrl: '/api/organization',
  credentials: 'same-origin',
  retry: 0,
  timeout: 10_000,
  headers: { accept: 'application/json' },
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(code ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const ErrorPayloadSchema = z.object({ error: z.string() });

export async function getOrganizationStatus(): Promise<OrganizationStatus> {
  try {
    const payload: unknown = await api.get('status').json();
    return OrganizationStatusSchema.parse(payload);
  } catch (error) {
    if (error instanceof HTTPError) {
      const payload: unknown = await error.response
        .json()
        .catch((cause: unknown) => {
          if (cause instanceof SyntaxError) return null;
          throw cause;
        });
      const parsed = ErrorPayloadSchema.safeParse(payload);
      throw new ApiError(
        error.response.status,
        parsed.success ? parsed.data.error : null,
      );
    }
    throw error;
  }
}

export async function loginOrganization(token: string): Promise<void> {
  try {
    await api.post('login', { json: { token } }).json();
  } catch (error) {
    if (error instanceof HTTPError) {
      const payload: unknown = await error.response.json().catch(() => null);
      const parsed = ErrorPayloadSchema.safeParse(payload);
      throw new ApiError(
        error.response.status,
        parsed.success ? parsed.data.error : null,
      );
    }
    throw error;
  }
}

export async function logoutOrganization(): Promise<void> {
  try {
    await api.post('logout').json();
  } catch (error) {
    if (error instanceof HTTPError) {
      const payload: unknown = await error.response.json().catch(() => null);
      const parsed = ErrorPayloadSchema.safeParse(payload);
      throw new ApiError(
        error.response.status,
        parsed.success ? parsed.data.error : null,
      );
    }
    throw error;
  }
}

export async function verifyParticipant(email: string, code: string, teamKey?: string): Promise<void> {
  try {
    await api.post('participant/verify', { json: { email, code, ...(teamKey ? { teamKey } : {}) } }).json();
  } catch (error) {
    if (error instanceof HTTPError) {
      const payload: unknown = await error.response.json().catch(() => null);
      const parsed = ErrorPayloadSchema.safeParse(payload);
      throw new ApiError(error.response.status, parsed.success ? parsed.data.error : null);
    }
    throw error;
  }
}

export async function requestParticipantCode(email: string, teamKey?: string): Promise<void> {
  try {
    await api.post('participant/request-code', { json: { email, ...(teamKey ? { teamKey } : {}) } }).json();
  } catch (error) {
    if (error instanceof HTTPError) {
      const payload: unknown = await error.response.json().catch(() => null);
      const parsed = ErrorPayloadSchema.safeParse(payload);
      throw new ApiError(error.response.status, parsed.success ? parsed.data.error : null);
    }
    throw error;
  }
}

export type JudgeTeam = {
  id: string;
  name: string;
  status: string;
  submission_count: number;
  document_count: number;
};

export async function getRoundTwoTeams(): Promise<{
  teams: JudgeTeam[];
  deadlines: {
    analysisDocumentDeadline: string | null;
    pullRequestDeadline: string | null;
  } | null;
}> {
  try {
    const payload: unknown = await api.get('round-two/teams').json();
    return z.object({
      teams: z.array(z.object({
        id: z.string(),
        name: z.string(),
        status: z.string(),
        submission_count: z.number(),
        document_count: z.number(),
      })),
      deadlines: z.object({
        analysisDocumentDeadline: z.string().nullable(),
        pullRequestDeadline: z.string().nullable(),
      }).nullable(),
    }).parse(payload);
  } catch (error) {
    if (error instanceof HTTPError) {
      const payload: unknown = await error.response.json().catch(() => null);
      const parsed = ErrorPayloadSchema.safeParse(payload);
      throw new ApiError(
        error.response.status,
        parsed.success ? parsed.data.error : null,
      );
    }
    throw error;
  }
}
