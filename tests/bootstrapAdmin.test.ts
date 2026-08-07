// @vitest-environment node
//
// The bootstrap CLI's pure parts, plus an end-to-end check that a hash it
// produces is accepted by the runtime verifier and lands in a real schema.

import { describe, expect, it } from 'vitest';
import {
  buildDuplicateCheckSql,
  buildInsertSql,
  buildWranglerCommand,
  escapeSqlString,
  isUniqueViolation,
  parseArgs,
  validateInput,
} from '../scripts/bootstrapAdmin.lib';
import { hashPassword, verifyPassword } from '../functions/_shared/password';
import { createTestDatabase } from './helpers/d1';

describe('parseArgs', () => {
  it('parses email, name and target', () => {
    const args = parseArgs(['--email', 'a@b.com', '--name', 'Ada', '--remote']);
    expect(args.email).toBe('a@b.com');
    expect(args.displayName).toBe('Ada');
    expect(args.target).toBe('remote');
  });

  it('defaults to the local database', () => {
    expect(parseArgs([]).target).toBe('local');
  });

  it('supports --display-name, --confirm, --dry-run and --help', () => {
    const args = parseArgs([
      '--display-name',
      'Ada L',
      '--confirm',
      'taketheleed',
      '--dry-run',
      '--help',
    ]);
    expect(args.displayName).toBe('Ada L');
    expect(args.confirm).toBe('taketheleed');
    expect(args.dryRun).toBe(true);
    expect(args.help).toBe(true);
  });

  it('rejects unknown options instead of ignoring them', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
  });
});

describe('validateInput', () => {
  it('keeps a presentable email and derives the normalized one', () => {
    const result = validateInput({
      email: '  Ada@Example.COM ',
      displayName: 'Ada Lovelace',
      password: 'a-strong-password',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Display keeps the operator's casing; uniqueness uses the lowercased form.
    expect(result.value.email).toBe('Ada@Example.COM');
    expect(result.value.normalizedEmail).toBe('ada@example.com');
    expect(result.value.displayName).toBe('Ada Lovelace');
  });

  it('rejects a short password', () => {
    const result = validateInput({
      email: 'a@b.com',
      displayName: 'A',
      password: 'short',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/at least 12/);
  });

  it('rejects an invalid email and an empty name', () => {
    expect(
      validateInput({ email: 'nope', displayName: 'A', password: 'a-strong-password' }).ok,
    ).toBe(false);
    expect(
      validateInput({ email: 'a@b.com', displayName: '   ', password: 'a-strong-password' })
        .ok,
    ).toBe(false);
  });

  it('rejects missing input', () => {
    expect(validateInput({ email: null, displayName: null, password: null }).ok).toBe(false);
  });
});

describe('SQL construction', () => {
  it('doubles single quotes', () => {
    expect(escapeSqlString("O'Brien")).toBe("O''Brien");
    expect(escapeSqlString("''")).toBe("''''");
  });

  it('refuses NUL bytes', () => {
    expect(() => escapeSqlString('a\0b')).toThrow(/NUL/);
  });

  it('produces a statement that survives a quote in the display name', () => {
    const db = createTestDatabase();
    try {
      const sql = buildInsertSql({
        id: 'u1',
        email: "O'Brien@example.com",
        normalizedEmail: "o'brien@example.com",
        displayName: "Conor O'Brien",
        passwordHash: 'pbkdf2-sha256$1$c2E=$aGE=',
        timestamp: '2026-01-01T00:00:00.000Z',
      });
      db.raw.exec(sql);

      const row = db.raw
        .prepare('SELECT display_name, normalized_email FROM admin_users WHERE id = ?')
        .get('u1') as { display_name: string; normalized_email: string };
      expect(row.display_name).toBe("Conor O'Brien");
      expect(row.normalized_email).toBe("o'brien@example.com");
    } finally {
      db.close();
    }
  });

  it('builds a duplicate check for the normalized email', () => {
    expect(buildDuplicateCheckSql('a@b.com')).toContain("normalized_email = 'a@b.com'");
  });

  it('never inlines SQL into the wrangler command line', () => {
    // Regression guard. Inlining the statement with `--command` made the shell
    // split it into words: wrangler received "INSERT", "INTO", "admin_users"
    // as separate arguments and the bootstrap could not create an admin at all.
    const sql = buildInsertSql({
      id: 'u1',
      email: 'a@b.com',
      normalizedEmail: 'a@b.com',
      displayName: 'Ada Lovelace',
      passwordHash: 'pbkdf2-sha256$100000$c2E=$aGE=',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const command = buildWranglerCommand('/tmp/x/statement.sql', 'local', 'DB');

    expect(command).not.toContain('--command');
    expect(command).not.toContain('INSERT');
    expect(command).not.toContain(sql);
    expect(command).toContain('--file');
    // The path is quoted, so a directory containing spaces survives the shell.
    expect(command).toContain('"/tmp/x/statement.sql"');
  });

  it('keeps the password hash out of the command line', () => {
    const command = buildWranglerCommand('/tmp/x/statement.sql', 'local', 'DB');
    expect(command).not.toContain('pbkdf2');
  });

  it('quotes a path containing spaces', () => {
    const command = buildWranglerCommand(
      'C:\\Users\\A B\\OneDrive - corp\\stmt.sql',
      'local',
      'DB',
    );
    expect(command).toContain('"C:\\Users\\A B\\OneDrive - corp\\stmt.sql"');
  });

  it('selects the right target flag and honours a wrangler override', () => {
    expect(buildWranglerCommand('/tmp/s.sql', 'local', 'DB')).toContain('--local');
    expect(buildWranglerCommand('/tmp/s.sql', 'remote', 'DB')).toContain('--remote');
    expect(buildWranglerCommand('/tmp/s.sql', 'remote', 'DB')).not.toContain('--local');
    expect(
      buildWranglerCommand('/tmp/s.sql', 'local', 'DB', 'npx --yes wrangler@latest'),
    ).toMatch(/^npx --yes wrangler@latest d1 execute DB --local --file "/);
  });

  it('recognizes a unique-violation message from wrangler', () => {
    expect(
      isUniqueViolation(
        'D1_ERROR: UNIQUE constraint failed: admin_users.normalized_email',
      ),
    ).toBe(true);
    expect(isUniqueViolation('some other failure')).toBe(false);
  });
});

describe('bootstrap end to end', () => {
  it('creates an admin whose password the runtime verifier accepts', async () => {
    const db = createTestDatabase();
    try {
      const password = 'bootstrap-password-1';
      const validated = validateInput({
        email: 'Ada@Example.com',
        displayName: 'Ada',
        password,
      });
      if (!validated.ok) throw new Error('expected valid input');

      const passwordHash = await hashPassword(validated.value.password);
      db.raw.exec(
        buildInsertSql({
          id: crypto.randomUUID(),
          email: validated.value.email,
          normalizedEmail: validated.value.normalizedEmail,
          displayName: validated.value.displayName,
          passwordHash,
          timestamp: new Date().toISOString(),
        }),
      );

      const stored = db.raw
        .prepare('SELECT password_hash, role, status FROM admin_users LIMIT 1')
        .get() as { password_hash: string; role: string; status: string };

      expect(stored.role).toBe('ADMIN');
      expect(stored.status).toBe('ACTIVE');
      // The stored value is a hash, never the password.
      expect(stored.password_hash).not.toContain(password);
      expect(await verifyPassword(password, stored.password_hash)).toBe(true);
      expect(await verifyPassword('wrong', stored.password_hash)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('the schema rejects a second admin with the same normalized email', () => {
    const db = createTestDatabase();
    try {
      const base = {
        normalizedEmail: 'ada@example.com',
        displayName: 'Ada',
        passwordHash: 'pbkdf2-sha256$1$c2E=$aGE=',
        timestamp: '2026-01-01T00:00:00.000Z',
      };
      db.raw.exec(buildInsertSql({ ...base, id: 'u1', email: 'Ada@Example.com' }));

      let message = '';
      try {
        db.raw.exec(buildInsertSql({ ...base, id: 'u2', email: 'ADA@EXAMPLE.COM' }));
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/UNIQUE/i);
      expect(isUniqueViolation(message)).toBe(true);
    } finally {
      db.close();
    }
  });
});
