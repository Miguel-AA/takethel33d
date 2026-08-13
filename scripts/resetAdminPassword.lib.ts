// Pure helpers for the credential-reset CLI.
//
// Kept apart from `reset-admin-password.ts` for the same reason
// `bootstrapAdmin.lib.ts` is: argument parsing, SQL construction and validation
// can then be tested without spawning wrangler, touching a database or knowing
// a password.

import { z } from 'zod';
import { normalizeEmail } from '../shared/schemas.ts';
import { ADMIN_PASSWORD_MAX_LENGTH, ADMIN_PASSWORD_MIN_LENGTH } from '../shared/limits.ts';
import { escapeSqlString } from './bootstrapAdmin.lib.ts';

export interface ResetArgs {
  email: string | null;
  target: 'local' | 'remote';
  confirm: string | null;
  dryRun: boolean;
  help: boolean;
  /** Skips the production round-trip. Only for a database with no public URL. */
  skipLoginCheck: boolean;
}

export function parseArgs(argv: string[]): ResetArgs {
  const args: ResetArgs = {
    email: null,
    target: 'local',
    confirm: null,
    dryRun: false,
    help: false,
    skipLoginCheck: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--email':
        args.email = argv[++i] ?? null;
        break;
      case '--local':
        args.target = 'local';
        break;
      case '--remote':
        args.target = 'remote';
        break;
      case '--confirm':
        args.confirm = argv[++i] ?? null;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--skip-login-check':
        args.skipLoginCheck = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        // A PASSWORD IS NEVER AN OPTION. `--password` is rejected by name
        // rather than falling into the generic "unknown option" branch, so the
        // refusal explains itself — and so nobody can put a credential on a
        // command line that ends up in shell history and the process table.
        if (arg === '--password' || arg.startsWith('--password=')) {
          throw new Error(
            'The password cannot be passed as an option. It is typed at a hidden prompt.',
          );
        }
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }

  return args;
}

/**
 * The reset's own input contract.
 *
 * Deliberately NOT `adminBootstrapSchema`: a reset takes no display name, and
 * reusing a schema that requires one would mean inventing a value for a field
 * this operation must never touch. The password rules are the same constants,
 * so the two cannot drift on the part that matters.
 */
export const adminPasswordResetSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z
    .string()
    .min(ADMIN_PASSWORD_MIN_LENGTH, 'password_too_short')
    .max(ADMIN_PASSWORD_MAX_LENGTH),
});

export interface ValidatedResetInput {
  normalizedEmail: string;
  password: string;
}

export type ResetValidation =
  | { ok: true; value: ValidatedResetInput }
  | { ok: false; errors: string[] };

export function validateInput(raw: {
  email: string | null;
  password: string | null;
}): ResetValidation {
  const parsed = adminPasswordResetSchema.safeParse({
    email: raw.email ?? '',
    password: raw.password ?? '',
  });

  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const field = issue.path.join('.') || 'input';
      if (issue.message === 'password_too_short') {
        return `password: must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`;
      }
      return `${field}: ${issue.message}`;
    });
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      normalizedEmail: normalizeEmail((raw.email ?? '').trim()),
      // Opaque. Whatever was typed is what gets hashed.
      password: parsed.data.password,
    },
  };
}

/** Resolves the account that is about to be changed, and nothing else. */
export function buildLookupSql(normalizedEmail: string): string {
  return (
    `SELECT id, email, display_name, role, status FROM admin_users ` +
    `WHERE normalized_email = '${escapeSqlString(normalizedEmail)}';`
  );
}

/** Reads back what was stored, so the caller can verify it. */
export function buildHashReadSql(normalizedEmail: string): string {
  return (
    `SELECT password_hash FROM admin_users ` +
    `WHERE normalized_email = '${escapeSqlString(normalizedEmail)}' LIMIT 1;`
  );
}

export interface ResetValues {
  adminId: string;
  passwordHash: string;
  timestamp: string;
}

/**
 * The reset itself: a new hash, a new `password_changed_at`, and every session
 * for that administrator gone.
 *
 * SCOPED BY ID, not by email, because the id was resolved from exactly one row
 * a moment earlier — an email in a WHERE clause is one typo away from touching
 * somebody else.
 *
 * WHAT IS ABSENT FROM THE SET LIST: `email`, `normalized_email`,
 * `display_name`, `role`, `status`, `created_at`. A credential reset changes a
 * credential. It is not a way to edit an identity, and the columns it must not
 * touch are not named here at all.
 *
 * Revoking the sessions is not optional politeness. If the password is being
 * replaced because it might be wrong or known, every session minted under the
 * old one has to stop working at the same instant — otherwise the reset changes
 * how you log in and nothing about who is already inside.
 */
export function buildResetStatements(values: ResetValues): string {
  const quoted = (raw: string) => `'${escapeSqlString(raw)}'`;
  return [
    'UPDATE admin_users',
    `   SET password_hash = ${quoted(values.passwordHash)},`,
    `       password_changed_at = ${quoted(values.timestamp)},`,
    `       updated_at = ${quoted(values.timestamp)}`,
    ` WHERE id = ${quoted(values.adminId)};`,
    '',
    `DELETE FROM admin_sessions WHERE admin_user_id = ${quoted(values.adminId)};`,
  ].join('\n');
}

/** Reports the shape of a stored hash without revealing any of it. */
export function describeHash(encoded: string): {
  algorithm: string;
  iterations: number;
  saltBytes: number;
  digestBytes: number;
  valid: boolean;
} {
  const parts = encoded.split('$');
  if (parts.length !== 4) {
    return { algorithm: 'unknown', iterations: 0, saltBytes: 0, digestBytes: 0, valid: false };
  }
  const [algorithm, iterations, salt, digest] = parts;
  const bytes = (value: string) => {
    try {
      return Buffer.from(value, 'base64').length;
    } catch {
      return 0;
    }
  };
  const saltBytes = bytes(salt);
  const digestBytes = bytes(digest);
  return {
    algorithm,
    iterations: Number(iterations),
    saltBytes,
    digestBytes,
    valid:
      algorithm === 'pbkdf2-sha256' &&
      Number.isInteger(Number(iterations)) &&
      Number(iterations) >= 1 &&
      saltBytes >= 16 &&
      digestBytes >= 32,
  };
}
