import { loginSchema } from '../../../shared/schemas';
import { error, json } from '../../_shared/responses';
import { TOKEN_TTL_MS, timingSafeEqual } from '../../_shared/auth';
import { sqliteToIso } from '../../_shared/db';

type Env = {
  DB: D1Database;
  MANAGER_PASSWORD: string;
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 8;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

function isRateLimited(request: Request): boolean {
  const key = clientKey(request);
  const now = Date.now();
  const existing = loginAttempts.get(key);
  if (!existing || existing.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  existing.count += 1;
  return existing.count > RATE_LIMIT_MAX_ATTEMPTS;
}

function clearRateLimit(request: Request): void {
  loginAttempts.delete(clientKey(request));
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  if (isRateLimited(ctx.request)) {
    return error(429, 'RATE_LIMIT', 'Too many login attempts');
  }

  const raw = await ctx.request.json().catch(() => null);
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return error(400, 'VALIDATION_ERROR', 'Invalid body');
  }
  if (!ctx.env.MANAGER_PASSWORD) {
    return error(500, 'SERVER_ERROR', 'Manager password not configured');
  }
  if (!timingSafeEqual(parsed.data.password, ctx.env.MANAGER_PASSWORD)) {
    return error(401, 'INVALID_PASSWORD', 'Contraseña incorrecta');
  }
  clearRateLimit(ctx.request);

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  await ctx.env.DB.prepare(
    'INSERT INTO manager_sessions (token, expires_at) VALUES (?, ?)',
  )
    .bind(token, expiresAt)
    .run();

  // Best-effort cleanup of expired sessions (no error if it fails).
  ctx.waitUntil(
    ctx.env.DB.prepare(
      "DELETE FROM manager_sessions WHERE expires_at < datetime('now')",
    )
      .run()
      .catch(() => {}),
  );

  return json(200, { token, expiresAt: sqliteToIso(expiresAt) });
};
