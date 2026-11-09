import { actionsBroker } from './actions-runner';
import { matrixApi } from './matrix-service';
import {
  isMatrixOriginAllowed,
  matrixPreflight,
  withMatrixCors,
} from './matrix-cors';
import { reconcileMatrix } from './matrix-workflow';
export {
  JanusMatrixRunner,
  MatrixEvaluationWorkflow,
  MazhaiCoverMatrixRunner,
  NoyyalMatrixRunner,
  PricingPulseMatrixRunner,
  RasoiMatrixRunner,
  VeeraFootwearMatrixRunner,
} from './matrix-workflow';
import { z } from 'zod';
import type { Env } from './env';
import { maintainOrganization, organization } from './organization';
export { OrganizationEvaluationWorkflow } from './organization-workflow';
import { api } from './api';
import { webhook } from './intake';
import { reconcile } from './store';
import { dispatchTeamEmail } from './team-email';
import { dispatchTeamInvitations } from './team-invitations';
import { observe } from './operational-telemetry';
import { previewApi, previewEnabled, reconcilePreview } from './preview';
export { PublicPreviewWorkflow } from './preview-workflow';
export { EvaluationWorkflow } from './workflow';
export { IsolatedRunner } from './runner-container';
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const start = Date.now();
    const traceId = crypto.randomUUID();
    const url = new URL(request.url);
    let response: Response;
    try {
      if (
        env.MATRIX_MODE === 'true' &&
        (url.pathname.startsWith('/api/organization/') ||
          url.pathname.startsWith('/auth/github/') ||
          url.pathname === '/webhooks/organization')
      ) {
        response = env.ORG_DB
          ? await organization(request, env, ctx)
          : env.ORG_SERVICE
            ? await env.ORG_SERVICE.fetch(request)
            : Response.json(
                { error: 'ORGANIZATION_NOT_CONFIGURED' },
                { status: 503 },
              );
      } else if (
        env.MATRIX_MODE === 'true' &&
        url.pathname.startsWith('/api/matrix/')
      ) {
        response =
          matrixPreflight(request, env) ??
          (!isMatrixOriginAllowed(request, env)
            ? Response.json(
                { error: 'ORIGIN_NOT_ALLOWED' },
                {
                  status: 403,
                },
              )
            : await matrixApi(request, env));
      } else if (
        env.MATRIX_MODE === 'true' &&
        [
          '/api/auth/config',
          '/api/auth/github',
          '/api/auth/github/callback',
          '/api/auth/github-identity',
          '/api/auth/me',
          '/api/auth/logout',
        ].includes(url.pathname)
      ) {
        response = env.ARENA_SERVICE
          ? await env.ARENA_SERVICE.fetch(request)
          : Response.json(
              { error: 'ARENA_AUTH_UNAVAILABLE' },
              { status: 503 },
            );
      } else if (
        env.MATRIX_MODE === 'true' &&
        url.pathname.startsWith('/api/')
      ) {
        response = Response.json(
          { error: 'NOT_FOUND' },
          {
            status: 404,
          },
        );
      } else if (
        url.pathname.startsWith('/api/organization/') ||
        url.pathname.startsWith('/auth/github/') ||
        url.pathname === '/webhooks/organization'
      ) {
        response = env.ORG_DB
          ? await organization(request, env, ctx)
          : env.ORG_SERVICE
            ? await env.ORG_SERVICE.fetch(request)
            : Response.json(
                { error: 'ORGANIZATION_NOT_CONFIGURED' },
                { status: 503 },
              );
      } else if (url.pathname.startsWith('/api/runner/actions/')) {
        response = await actionsBroker(request, env);
      } else if (url.pathname === '/health') {
        response = Response.json({
          status: 'ok',
          environment: env.ENVIRONMENT,
          mode: previewEnabled(env)
            ? 'public-pr-review'
            : env.DEMO_MODE === 'true'
              ? 'synthetic-review'
              : 'live',
        });
      } else if (
        url.pathname === '/webhooks/github' &&
        request.method === 'POST'
      ) {
        response = await webhook(request, env, ctx);
      } else if (url.pathname.startsWith('/api/')) {
        response = previewEnabled(env)
          ? await previewApi(request, env, ctx)
          : await api(request, env);
      } else if (
        env.MATRIX_MODE === 'true' &&
        request.method === 'GET' &&
        (url.pathname === '/' ||
          url.pathname === '/index.html' ||
          !url.pathname.includes('.'))
      ) {
        const asset = new URL(request.url);
        asset.pathname = '/index.html';
        response = await env.ASSETS.fetch(new Request(asset, request));
      } else response = await env.ASSETS.fetch(request);
    } catch (error) {
      const matrixError =
        env.MATRIX_MODE === 'true' &&
        url.pathname.startsWith('/api/matrix/') &&
        error instanceof Error &&
        [
          'MATRIX_BUDGET_LIMIT',
          'MATRIX_BUSY',
          'MATRIX_INVALID_BUDGET_CONFIG',
        ].includes(error.message)
          ? error.message
          : null;
      const status =
        matrixError === 'MATRIX_BUDGET_LIMIT' || matrixError === 'MATRIX_BUSY'
          ? 429
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : error instanceof Error && error.message === 'BODY_LIMIT'
              ? 413
              : 503;
      response = Response.json(
        {
          error:
            matrixError ??
            (status === 400
              ? 'INVALID_INPUT'
              : status === 413
                ? 'BODY_LIMIT'
                : 'SERVICE_UNAVAILABLE'),
          traceId,
        },
        { status },
      );
      console.error(
        JSON.stringify({ event: 'request_failed', traceId, status }),
      );
    }
    response =
      env.MATRIX_MODE === 'true' && url.pathname.startsWith('/api/matrix/')
        ? withMatrixCors(request, env, response)
        : new Response(response.body, response);
    response.headers.set('x-trace-id', traceId);
    response.headers.set('x-content-type-options', 'nosniff');
    response.headers.set('referrer-policy', 'same-origin');
    response.headers.set(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com",
    );
    response.headers.set(
      'permissions-policy',
      'camera=(), microphone=(), geolocation=()',
    );
    if (url.pathname.startsWith('/api/')) {
      response.headers.set('cache-control', 'no-store');
    }
    console.log(
      JSON.stringify({
        event: 'http',
        traceId,
        path: url.pathname.replace(/[a-f0-9]{64}/g, ':id'),
        status: response.status,
        durationMs: Date.now() - start,
      }),
    );
    if (
      url.pathname === '/webhooks/github' ||
      url.pathname === '/webhooks/organization'
    ) {
      const db =
        url.pathname === '/webhooks/organization'
          ? (env.ORG_DB ?? env.DB)
          : env.DB;
      try {
        ctx.waitUntil(
          Promise.all([
            observe(db, 'webhook.request'),
            observe(db, 'webhook.latencyMs', Math.max(0, Date.now() - start)),
            ...(response.status >= 400 ? [observe(db, 'webhook.error')] : []),
          ]).then(() => undefined),
        );
      } catch {
        // Telemetry scheduling must preserve the response and its security headers.
      }
    }
    return response;
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    if (env.ORG_DB && env.TEAM_EMAIL_SENDER) {
      ctx.waitUntil(dispatchTeamEmail(env));
      ctx.waitUntil(dispatchTeamInvitations(env));
    }
    if (env.MATRIX_MODE === 'true') {
      ctx.waitUntil(reconcileMatrix(env));
      return;
    }
    if (env.ORG_DB) ctx.waitUntil(maintainOrganization(env, ctx));
    if (previewEnabled(env)) ctx.waitUntil(reconcilePreview(env));
    else if (env.DEMO_MODE !== 'true') ctx.waitUntil(reconcile(env));
  },
} satisfies ExportedHandler<Env>;
