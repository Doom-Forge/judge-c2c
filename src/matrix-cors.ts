type CorsEnv = { CORS_ALLOWED_ORIGINS?: string };
const methods = ['GET', 'POST', 'OPTIONS'];
const allowedHeaders = ['authorization', 'content-type'];
function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export function isMatrixOriginAllowed(request: Request, env: CorsEnv): boolean {
  const origin = request.headers.get('Origin');
  // CLI and the server-side Arena bridge still require bearer authentication.
  if (origin === null) return true;
  if (!validOrigin(origin)) return false;
  return (
    origin === new URL(request.url).origin ||
    (env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .some((s) => validOrigin(s) && s === origin)
  );
}
export function withMatrixCors(
  request: Request,
  env: CorsEnv,
  response: Response,
): Response {
  const headers = new Headers(response.headers);
  const vary = new Set(
    (headers.get('Vary') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  vary.add('Origin');
  headers.set('Vary', [...vary].join(', '));
  headers.delete('Access-Control-Allow-Credentials');
  headers.delete('Access-Control-Allow-Origin');
  const origin = request.headers.get('Origin');
  if (origin && isMatrixOriginAllowed(request, env)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'X-Trace-Id');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
export function matrixPreflight(
  request: Request,
  env: CorsEnv,
): Response | null {
  if (request.method !== 'OPTIONS') return null;
  const reply = (error: string, status: number) =>
    withMatrixCors(request, env, Response.json({ error }, { status }));
  if (!request.headers.has('Origin') || !isMatrixOriginAllowed(request, env))
    return reply('ORIGIN_NOT_ALLOWED', 403);
  if (
    !methods.includes(
      request.headers.get('Access-Control-Request-Method') ?? '',
    )
  )
    return reply('METHOD_NOT_ALLOWED', 405);
  const requested = (
    request.headers.get('Access-Control-Request-Headers') ?? ''
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (requested.some((s) => !allowedHeaders.includes(s)))
    return reply('HEADERS_NOT_ALLOWED', 400);
  return withMatrixCors(
    request,
    env,
    new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': methods.join(', '),
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Access-Control-Request-Method, Access-Control-Request-Headers',
      },
    }),
  );
}
