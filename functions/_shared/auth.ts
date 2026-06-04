export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : null;
}

export async function validateSession(
  db: D1Database,
  token: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT expires_at FROM manager_sessions WHERE token = ?')
    .bind(token)
    .first<{ expires_at: string }>();
  if (!row) return false;
  // SQLite stores naive UTC; ensure we treat it as UTC.
  const expiresMs = Date.parse(
    row.expires_at.endsWith('Z') ? row.expires_at : row.expires_at + 'Z',
  );
  return Number.isFinite(expiresMs) && expiresMs > Date.now();
}
