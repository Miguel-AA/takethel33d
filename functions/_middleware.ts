import { error } from './_shared/responses';
import { extractBearerToken, validateSession } from './_shared/auth';

type Env = {
  DB: D1Database;
};

const PROTECTED_PREFIXES = [
  '/api/manager/me',
  '/api/attendees',
  '/api/metrics',
  '/api/raffle/',
];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p),
  );
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  if (!isProtected(url.pathname)) {
    return ctx.next();
  }

  const token = extractBearerToken(ctx.request);
  if (!token) {
    return error(401, 'UNAUTHORIZED', 'Missing bearer token');
  }
  const valid = await validateSession(ctx.env.DB, token);
  if (!valid) {
    return error(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }
  return ctx.next();
};
