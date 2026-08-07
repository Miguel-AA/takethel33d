// @vitest-environment node
//
// Exercises AdminAuthService against the real migrated schema.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { AdminAuthService } from '../functions/_shared/adminAuthService';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { SessionRepository } from '../functions/_shared/sessionRepository';
import { hashPassword } from '../functions/_shared/password';
import { hashToken } from '../functions/_shared/tokens';
import { normalizeEmail } from '../shared/schemas';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { AdminStatus } from '../shared/types';

const PASSWORD = 'a-strong-admin-password';

let db: TestDatabase;
let auth: AdminAuthService;
let admins: AdminRepository;
let sessions: SessionRepository;

async function seedAdmin(
  email = 'Ada@Example.com',
  status: AdminStatus = 'ACTIVE',
  password = PASSWORD,
): Promise<string> {
  const result = await admins.create({
    email,
    normalizedEmail: normalizeEmail(email),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword(password),
    status,
  });
  if (result.kind !== 'created') throw new Error('seed failed');
  return result.admin.id;
}

function setStatus(id: string, status: AdminStatus): void {
  db.raw.prepare('UPDATE admin_users SET status = ? WHERE id = ?').run(status, id);
}

beforeEach(() => {
  db = createTestDatabase();
  auth = new AdminAuthService(db.d1);
  admins = new AdminRepository(db.d1);
  sessions = new SessionRepository(db.d1);
});

afterEach(() => {
  db.close();
});

describe('login', () => {
  it('signs in with correct credentials and returns only public fields', async () => {
    await seedAdmin();
    const result = await auth.login({ email: 'Ada@Example.com', password: PASSWORD });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.admin.email).toBe('Ada@Example.com');
    expect(result.admin.displayName).toBe('Ada Lovelace');
    expect(result.admin.role).toBe('ADMIN');
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // No secret may appear on the public object.
    const serialized = JSON.stringify(result.admin);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('pbkdf2');
    expect(serialized).not.toContain('token');
  });

  it('normalizes the email so case and whitespace do not matter', async () => {
    await seedAdmin('Ada@Example.com');
    for (const variant of ['ada@example.com', 'ADA@EXAMPLE.COM', '  Ada@Example.Com  ']) {
      const result = await auth.login({ email: variant, password: PASSWORD });
      expect(result.kind).toBe('ok');
    }
  });

  it('returns invalid_credentials for an unknown email', async () => {
    await seedAdmin();
    const result = await auth.login({ email: 'nobody@example.com', password: PASSWORD });
    expect(result.kind).toBe('invalid_credentials');
  });

  it('returns invalid_credentials for a wrong password', async () => {
    await seedAdmin();
    const result = await auth.login({ email: 'ada@example.com', password: 'nope' });
    expect(result.kind).toBe('invalid_credentials');
  });

  it('gives the SAME outcome for unknown email and wrong password', async () => {
    await seedAdmin();
    const unknown = await auth.login({ email: 'ghost@example.com', password: 'x' });
    const wrong = await auth.login({ email: 'ada@example.com', password: 'x' });
    // No enumeration oracle: the caller cannot tell the cases apart.
    expect(unknown).toEqual(wrong);
  });

  it('refuses a suspended administrator', async () => {
    await seedAdmin('sus@example.com', 'SUSPENDED');
    const result = await auth.login({ email: 'sus@example.com', password: PASSWORD });
    expect(result.kind).toBe('suspended');
  });

  it('refuses a disabled administrator', async () => {
    await seedAdmin('off@example.com', 'DISABLED');
    const result = await auth.login({ email: 'off@example.com', password: PASSWORD });
    expect(result.kind).toBe('disabled');
  });

  it('does not reveal status when the password is wrong', async () => {
    await seedAdmin('sus@example.com', 'SUSPENDED');
    const result = await auth.login({ email: 'sus@example.com', password: 'wrong' });
    // Status is only disclosed to someone who proved they own the credentials.
    expect(result.kind).toBe('invalid_credentials');
  });

  it('updates last_login_at', async () => {
    const id = await seedAdmin();
    expect(
      (db.raw.prepare('SELECT last_login_at AS t FROM admin_users WHERE id = ?').get(id) as {
        t: string | null;
      }).t,
    ).toBeNull();

    await auth.login({ email: 'ada@example.com', password: PASSWORD });

    const after = db.raw
      .prepare('SELECT last_login_at AS t FROM admin_users WHERE id = ?')
      .get(id) as { t: string | null };
    expect(after.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates an attributable session storing only the token hash', async () => {
    const id = await seedAdmin();
    const result = await auth.login({
      email: 'ada@example.com',
      password: PASSWORD,
      userAgent: 'vitest/1.0',
      clientIp: '203.0.113.7',
    });
    if (result.kind !== 'ok') throw new Error('expected login to succeed');

    const row = db.raw
      .prepare('SELECT * FROM admin_sessions WHERE id = ?')
      .get(result.sessionId) as Record<string, unknown>;

    expect(row.admin_user_id).toBe(id);
    expect(row.token_hash).toBe(await hashToken(result.token));
    expect(row.revoked_at).toBeNull();
    expect(row.user_agent).toBe('vitest/1.0');

    // Neither the plaintext token nor the raw IP is persisted.
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(result.token);
    expect(dump).not.toContain('203.0.113.7');
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rate limits repeated failures from one source, including a correct password', async () => {
    await seedAdmin();
    const ip = '198.51.100.42';
    for (let i = 0; i < 10; i++) {
      const attempt = await auth.login({
        email: 'ada@example.com',
        password: 'wrong',
        clientIp: ip,
      });
      expect(attempt.kind).toBe('invalid_credentials');
    }

    // The IP bucket is a hard block: the same source is refused even with the
    // right password, which is what stops volumetric guessing.
    const blocked = await auth.login({
      email: 'ada@example.com',
      password: PASSWORD,
      clientIp: ip,
    });
    expect(blocked.kind).toBe('rate_limited');
    if (blocked.kind === 'rate_limited') {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }

    // A different account from a clean source is unaffected.
    await seedAdmin('other@example.com');
    const other = await auth.login({
      email: 'other@example.com',
      password: PASSWORD,
      clientIp: '203.0.113.200',
    });
    expect(other.kind).toBe('ok');
  });

  it('a burnt email bucket refuses wrong passwords but not the real admin', async () => {
    await seedAdmin();
    // Failures spread across many IPs burn only the email bucket.
    for (let i = 0; i < 12; i++) {
      await auth.login({
        email: 'ada@example.com',
        password: 'wrong',
        clientIp: `198.51.100.${i}`,
      });
    }

    const guess = await auth.login({
      email: 'ada@example.com',
      password: 'wrong-again',
      clientIp: '203.0.113.5',
    });
    expect(guess.kind).toBe('rate_limited');

    // The genuine admin is never locked out of their own account.
    const genuine = await auth.login({
      email: 'ada@example.com',
      password: PASSWORD,
      clientIp: '203.0.113.5',
    });
    expect(genuine.kind).toBe('ok');
  });
});

describe('session validation', () => {
  async function login(): Promise<{ token: string; sessionId: string; adminId: string }> {
    const adminId = await seedAdmin();
    const result = await auth.login({ email: 'ada@example.com', password: PASSWORD });
    if (result.kind !== 'ok') throw new Error('login failed');
    return { token: result.token, sessionId: result.sessionId, adminId };
  }

  it('accepts a fresh session and identifies the actor', async () => {
    const { token, sessionId, adminId } = await login();
    const outcome = await auth.validateSessionToken(token);

    expect(outcome.kind).toBe('valid');
    if (outcome.kind !== 'valid') return;
    expect(outcome.admin.id).toBe(adminId);
    expect(outcome.admin.sessionId).toBe(sessionId);
    expect(outcome.admin.email).toBe('Ada@Example.com');
    expect(outcome.admin.displayName).toBe('Ada Lovelace');
    expect(outcome.admin.role).toBe('ADMIN');
  });

  it('reports missing when there is no token', async () => {
    expect((await auth.validateSessionToken(null)).kind).toBe('missing');
    expect((await auth.validateSessionToken('')).kind).toBe('missing');
  });

  it('rejects an unknown token', async () => {
    await login();
    expect((await auth.validateSessionToken('not-a-real-token')).kind).toBe('invalid');
  });

  it('rejects a tampered token', async () => {
    const { token } = await login();
    const tampered = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;
    expect((await auth.validateSessionToken(tampered)).kind).toBe('invalid');
  });

  it('rejects an expired session', async () => {
    const { token, sessionId } = await login();
    db.raw
      .prepare('UPDATE admin_sessions SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', sessionId);
    expect((await auth.validateSessionToken(token)).kind).toBe('expired');
  });

  it('rejects a revoked session', async () => {
    const { token, sessionId } = await login();
    await sessions.revokeById(sessionId);
    expect((await auth.validateSessionToken(token)).kind).toBe('revoked');
  });

  it('rejects a session whose admin was suspended AFTER login', async () => {
    const { token, adminId } = await login();
    expect((await auth.validateSessionToken(token)).kind).toBe('valid');

    setStatus(adminId, 'SUSPENDED');
    expect((await auth.validateSessionToken(token)).kind).toBe('admin_suspended');
  });

  it('rejects a session whose admin was disabled AFTER login', async () => {
    const { token, adminId } = await login();
    setStatus(adminId, 'DISABLED');
    expect((await auth.validateSessionToken(token)).kind).toBe('admin_disabled');
  });

  it('binds the session to the right actor when several admins exist', async () => {
    await seedAdmin('one@example.com');
    await seedAdmin('two@example.com');

    const first = await auth.login({ email: 'one@example.com', password: PASSWORD });
    const second = await auth.login({ email: 'two@example.com', password: PASSWORD });
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('login failed');

    const a = await auth.validateSessionToken(first.token);
    const b = await auth.validateSessionToken(second.token);
    if (a.kind !== 'valid' || b.kind !== 'valid') throw new Error('expected valid');

    expect(a.admin.email).toBe('one@example.com');
    expect(b.admin.email).toBe('two@example.com');
    expect(a.admin.id).not.toBe(b.admin.id);
  });
});

describe('logout', () => {
  async function loginToken(): Promise<string> {
    await seedAdmin();
    const result = await auth.login({ email: 'ada@example.com', password: PASSWORD });
    if (result.kind !== 'ok') throw new Error('login failed');
    return result.token;
  }

  it('revokes the session server-side', async () => {
    const token = await loginToken();
    expect((await auth.logout(token)).revoked).toBe(true);

    const row = db.raw
      .prepare('SELECT revoked_at FROM admin_sessions LIMIT 1')
      .get() as { revoked_at: string | null };
    expect(row.revoked_at).not.toBeNull();
  });

  it('makes the token stop working immediately', async () => {
    const token = await loginToken();
    expect((await auth.validateSessionToken(token)).kind).toBe('valid');

    await auth.logout(token);

    expect((await auth.validateSessionToken(token)).kind).toBe('revoked');
  });

  it('is idempotent and keeps the first revocation timestamp', async () => {
    const token = await loginToken();
    await auth.logout(token);

    const firstAt = (
      db.raw.prepare('SELECT revoked_at FROM admin_sessions LIMIT 1').get() as {
        revoked_at: string;
      }
    ).revoked_at;

    // Repeating is safe and does not rewrite history.
    await expect(auth.logout(token)).resolves.toEqual({ revoked: false });
    await expect(auth.logout(token)).resolves.toEqual({ revoked: false });

    const stillAt = (
      db.raw.prepare('SELECT revoked_at FROM admin_sessions LIMIT 1').get() as {
        revoked_at: string;
      }
    ).revoked_at;
    expect(stillAt).toBe(firstAt);
  });

  it('tolerates an absent or unknown token', async () => {
    await expect(auth.logout(null)).resolves.toEqual({ revoked: false });
    await expect(auth.logout('garbage')).resolves.toEqual({ revoked: false });
  });

  it('only revokes the session used, not the admin\'s other sessions', async () => {
    await seedAdmin();
    const first = await auth.login({ email: 'ada@example.com', password: PASSWORD });
    const second = await auth.login({ email: 'ada@example.com', password: PASSWORD });
    if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('login failed');

    await auth.logout(first.token);

    expect((await auth.validateSessionToken(first.token)).kind).toBe('revoked');
    expect((await auth.validateSessionToken(second.token)).kind).toBe('valid');
  });
});

describe('AdminRepository', () => {
  it('rejects a duplicate email regardless of case', async () => {
    await seedAdmin('Ada@Example.com');
    const duplicate = await admins.create({
      email: 'ADA@EXAMPLE.COM',
      normalizedEmail: normalizeEmail('ADA@EXAMPLE.COM'),
      displayName: 'Impostor',
      passwordHash: await hashPassword(PASSWORD),
    });
    expect(duplicate.kind).toBe('email_exists');
  });

  it('never exposes password_hash on the public object', async () => {
    const result = await admins.create({
      email: 'x@example.com',
      normalizedEmail: 'x@example.com',
      displayName: 'X',
      passwordHash: await hashPassword(PASSWORD),
    });
    if (result.kind !== 'created') throw new Error('create failed');
    expect(Object.keys(result.admin)).not.toContain('passwordHash');
    expect(Object.keys(result.admin)).not.toContain('password_hash');
  });

  it('stores the presentable email and the normalized one separately', async () => {
    const id = await seedAdmin('Ada.Lovelace@Example.COM');
    const row = db.raw
      .prepare('SELECT email, normalized_email FROM admin_users WHERE id = ?')
      .get(id) as { email: string; normalized_email: string };
    expect(row.email).toBe('Ada.Lovelace@Example.COM');
    expect(row.normalized_email).toBe('ada.lovelace@example.com');
  });
});
