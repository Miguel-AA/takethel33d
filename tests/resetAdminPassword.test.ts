// @vitest-environment node
//
// The credential-reset CLI.
//
// The property this suite exists to protect is the one whose absence caused a
// production login failure: A RESET IS NOT FINISHED WHEN A HASH IS WRITTEN. It
// is finished when the password that was typed authenticates. Every layer can
// be individually correct while the whole is not, and only an end-to-end check
// notices.
//
// No production credential appears anywhere here; every password below is a
// fixture invented for the test.

import { describe, expect, it } from 'vitest';
import {
  buildHashReadSql,
  buildLookupSql,
  buildResetStatements,
  describeHash,
  parseArgs,
  validateInput,
} from '../scripts/resetAdminPassword.lib';
import { hashPassword, verifyPassword, PBKDF2_ITERATIONS } from '../functions/_shared/password';
import { ADMIN_PASSWORD_MIN_LENGTH } from '../shared/limits';

const FIXTURE_PASSWORD = 'FixtureResetPassword2026';

// ---------------------------------------------------------------------------
describe('argument parsing', () => {
  it('reads the options it supports', () => {
    const args = parseArgs([
      '--email',
      'someone@example.com',
      '--remote',
      '--confirm',
      'taketheleed',
    ]);
    expect(args).toMatchObject({
      email: 'someone@example.com',
      target: 'remote',
      confirm: 'taketheleed',
      dryRun: false,
      help: false,
    });
  });

  it('defaults to the LOCAL database', () => {
    // Production has to be asked for. A missing flag must never mean "live".
    expect(parseArgs(['--email', 'a@b.com']).target).toBe('local');
  });

  it('REFUSES a password on the command line, by name', () => {
    // A credential in argv reaches shell history and the process table, where
    // any other user on the machine can read it.
    for (const argv of [
      ['--password', 'hunter2hunter2'],
      ['--password=hunter2hunter2'],
    ]) {
      expect(() => parseArgs(argv)).toThrow(/cannot be passed as an option/i);
    }
  });

  it('rejects an unknown option rather than ignoring it', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown option/i);
  });
});

// ---------------------------------------------------------------------------
describe('input validation', () => {
  it('accepts a real address and a long enough password', () => {
    const result = validateInput({ email: '  Owner@Example.COM ', password: FIXTURE_PASSWORD });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalizedEmail).toBe('owner@example.com');
      // The password is OPAQUE: not trimmed, not lowercased, not normalised.
      expect(result.value.password).toBe(FIXTURE_PASSWORD);
    }
  });

  it('leaves a password with surrounding spaces exactly as typed', () => {
    // Trimming here is how a stored credential comes to differ from the one
    // somebody types into a browser afterwards.
    const padded = `  ${FIXTURE_PASSWORD}  `;
    const result = validateInput({ email: 'owner@example.com', password: padded });
    expect(result.ok && result.value.password).toBe(padded);
  });

  it('refuses a password below the shared minimum', () => {
    const result = validateInput({ email: 'owner@example.com', password: 'short' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain(String(ADMIN_PASSWORD_MIN_LENGTH));
    }
  });

  it('refuses a malformed address', () => {
    expect(validateInput({ email: 'not-an-email', password: FIXTURE_PASSWORD }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the statements it builds', () => {
  const values = {
    adminId: 'admin-1',
    passwordHash: 'pbkdf2-sha256$100000$c2FsdA==$ZGlnZXN0',
    timestamp: '2026-08-13T12:00:00.000Z',
  };

  it('changes the credential and NOTHING about the identity', () => {
    const sql = buildResetStatements(values);
    expect(sql).toContain('UPDATE admin_users');
    expect(sql).toContain('password_hash');
    expect(sql).toContain('password_changed_at');

    // The columns a reset must never touch are not in the statement at all.
    for (const column of [
      'display_name',
      'normalized_email',
      'role =',
      'status =',
      'created_at =',
    ]) {
      expect(sql, `reset touches ${column}`).not.toContain(column);
    }
  });

  it('scopes by id, never by email', () => {
    // The id was resolved from exactly one row a moment earlier. An email in a
    // WHERE clause is one typo away from somebody else's account.
    const sql = buildResetStatements(values);
    expect(sql).toContain("WHERE id = 'admin-1'");
    expect(sql).not.toMatch(/WHERE normalized_email/);
  });

  it('revokes every session for that administrator', () => {
    // A password replaced because it might be known must not leave the
    // sessions minted under it working.
    expect(buildResetStatements(values)).toContain(
      "DELETE FROM admin_sessions WHERE admin_user_id = 'admin-1'",
    );
  });

  it('escapes a quote in an identifier rather than breaking the statement', () => {
    const sql = buildResetStatements({ ...values, adminId: "ad'min" });
    expect(sql).toContain("'ad''min'");
  });

  it('scopes its reads by the normalized address', () => {
    expect(buildLookupSql('owner@example.com')).toContain(
      "normalized_email = 'owner@example.com'",
    );
    expect(buildHashReadSql('owner@example.com')).toContain('password_hash');
  });
});

// ---------------------------------------------------------------------------
describe('hash description', () => {
  it('reports the shape without revealing any of it', async () => {
    const hash = await hashPassword(FIXTURE_PASSWORD);
    const shape = describeHash(hash);

    expect(shape).toMatchObject({
      algorithm: 'pbkdf2-sha256',
      iterations: PBKDF2_ITERATIONS,
      saltBytes: 16,
      digestBytes: 32,
      valid: true,
    });
    // Nothing in the description carries hash material.
    expect(JSON.stringify(shape)).not.toContain(hash.split('$')[2]);
    expect(JSON.stringify(shape)).not.toContain(hash.split('$')[3]);
  });

  it('calls a malformed or weak hash invalid', () => {
    expect(describeHash('nonsense').valid).toBe(false);
    expect(describeHash('pbkdf2-sha256$1$c2FsdA==$ZGln').valid).toBe(false);
    expect(describeHash('sha1$100000$c2FsdA==$ZGlnZXN0').valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the check the bootstrap was missing', () => {
  it('a captured password verifies against the hash that gets stored', async () => {
    // THE REGRESSION. This is the assertion whose absence let a reset report
    // success while the credential could not authenticate: hash it, store it,
    // read it back, and verify the ORIGINAL captured string against it.
    const captured = FIXTURE_PASSWORD;
    const hash = await hashPassword(captured);

    // Round-trips through the SQL layer the way the real value does.
    const sql = buildResetStatements({
      adminId: 'admin-1',
      passwordHash: hash,
      timestamp: '2026-08-13T12:00:00.000Z',
    });
    const stored = sql.match(/password_hash = '([^']+)'/)![1];

    expect(stored).toBe(hash);
    expect(await verifyPassword(captured, stored)).toBe(true);
  });

  it('any difference at all fails the check', async () => {
    const hash = await hashPassword(FIXTURE_PASSWORD);
    for (const wrong of [
      `${FIXTURE_PASSWORD} `,
      ` ${FIXTURE_PASSWORD}`,
      `${FIXTURE_PASSWORD}\r`,
      `${FIXTURE_PASSWORD}\n`,
      FIXTURE_PASSWORD.toLowerCase(),
      FIXTURE_PASSWORD.slice(0, -1),
      `${FIXTURE_PASSWORD}x`,
    ]) {
      expect(await verifyPassword(wrong, hash), JSON.stringify(wrong)).toBe(false);
    }
  });

  it('the stored hash is never equal to the password', async () => {
    const hash = await hashPassword(FIXTURE_PASSWORD);
    expect(hash).not.toContain(FIXTURE_PASSWORD);
  });

  it('two resets of the SAME password produce different hashes', async () => {
    // A fresh salt every time, so the stored value does not reveal that a
    // password was reused.
    const a = await hashPassword(FIXTURE_PASSWORD);
    const b = await hashPassword(FIXTURE_PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(FIXTURE_PASSWORD, a)).toBe(true);
    expect(await verifyPassword(FIXTURE_PASSWORD, b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the hidden prompt is the one the bootstrap uses', () => {
  it('is a single shared implementation, not two copies', async () => {
    const prompt = await import('../scripts/securePrompt');
    expect(typeof prompt.promptHidden).toBe('function');
    expect(typeof prompt.canPromptInteractively).toBe('function');

    // The bootstrap must not carry its own copy any more.
    const fs = await import('node:fs');
    const source = fs.readFileSync('scripts/bootstrap-admin.ts', 'utf8');
    expect(source).toContain("from './securePrompt.ts'");
    expect(source).not.toContain('async function promptHidden');
  });
});
