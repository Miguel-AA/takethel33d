// Pure helpers for the admin bootstrap CLI.
//
// Kept apart from `bootstrap-admin.ts` so the argument parsing, SQL escaping
// and statement construction can be unit-tested without spawning wrangler or
// touching a database.

import { adminBootstrapSchema, normalizeEmail } from '../shared/schemas.ts';

export interface BootstrapArgs {
  email: string | null;
  displayName: string | null;
  target: 'local' | 'remote';
  confirm: string | null;
  dryRun: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): BootstrapArgs {
  const args: BootstrapArgs = {
    email: null,
    displayName: null,
    target: 'local',
    confirm: null,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--email':
        args.email = argv[++i] ?? null;
        break;
      case '--name':
      case '--display-name':
        args.displayName = argv[++i] ?? null;
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
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }

  return args;
}

/**
 * Escapes a value for inclusion in a single-quoted SQL literal.
 *
 * `wrangler d1 execute` takes SQL text, not bound parameters, so the statement
 * has to be assembled as a string. Every interpolated value is validated
 * upstream by `adminBootstrapSchema` or produced by the hasher, and quotes are
 * doubled here — the standard SQL escape.
 */
export function escapeSqlString(value: string): string {
  if (value.includes('\0')) {
    throw new Error('Value contains a NUL byte and cannot be written to SQLite');
  }
  return value.replace(/'/g, "''");
}

export interface AdminInsertValues {
  id: string;
  email: string;
  normalizedEmail: string;
  displayName: string;
  passwordHash: string;
  timestamp: string;
}

export function buildInsertSql(values: AdminInsertValues): string {
  const quoted = (raw: string) => `'${escapeSqlString(raw)}'`;
  return [
    'INSERT INTO admin_users',
    '  (id, email, normalized_email, display_name, password_hash,',
    '   role, status, created_at, updated_at, password_changed_at)',
    'VALUES (',
    `  ${quoted(values.id)},`,
    `  ${quoted(values.email)},`,
    `  ${quoted(values.normalizedEmail)},`,
    `  ${quoted(values.displayName)},`,
    `  ${quoted(values.passwordHash)},`,
    "  'ADMIN',",
    "  'ACTIVE',",
    `  ${quoted(values.timestamp)},`,
    `  ${quoted(values.timestamp)},`,
    `  ${quoted(values.timestamp)}`,
    ');',
  ].join('\n');
}

export function buildDuplicateCheckSql(normalizedEmail: string): string {
  return `SELECT id FROM admin_users WHERE normalized_email = '${escapeSqlString(
    normalizedEmail,
  )}' LIMIT 1;`;
}

export interface ValidatedBootstrapInput {
  email: string;
  normalizedEmail: string;
  displayName: string;
  password: string;
}

export type ValidationResult =
  | { ok: true; value: ValidatedBootstrapInput }
  | { ok: false; errors: string[] };

/** Validates raw CLI input against the shared bootstrap schema. */
export function validateInput(raw: {
  email: string | null;
  displayName: string | null;
  password: string | null;
}): ValidationResult {
  const parsed = adminBootstrapSchema.safeParse({
    email: raw.email ?? '',
    displayName: raw.displayName ?? '',
    password: raw.password ?? '',
  });

  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const field = issue.path.join('.') || 'input';
      if (issue.message === 'password_too_short') {
        return `password: must be at least 12 characters`;
      }
      return `${field}: ${issue.message}`;
    });
    return { ok: false, errors };
  }

  // `admin_users.email` keeps the address as the operator typed it (minus
  // surrounding whitespace) so the panel can display "Ada@Example.com";
  // uniqueness is carried by the lowercased `normalized_email`.
  const presentableEmail = (raw.email ?? '').trim();

  return {
    ok: true,
    value: {
      email: presentableEmail,
      normalizedEmail: normalizeEmail(presentableEmail),
      displayName: parsed.data.displayName,
      password: parsed.data.password,
    },
  };
}

/** True when wrangler's stderr/stdout indicates a duplicate normalized email. */
export function isUniqueViolation(output: string): boolean {
  return /UNIQUE constraint failed/i.test(output) && /normalized_email/i.test(output);
}

/**
 * Builds the shell command that hands a SQL FILE to wrangler.
 *
 * Reaching wrangler needs a shell (on Windows `npx` is a `.cmd`, which Node
 * will not spawn without one), and a shell does not quote an argument array.
 * An earlier version inlined the statement with `--command`, so the shell split
 * `INSERT INTO admin_users ...` into separate arguments and wrangler died with
 * "Unknown arguments: INTO, admin_users" — the bootstrap could not create an
 * administrator at all. Passing a quoted file path is what keeps the SQL
 * intact, and it also keeps the password hash out of the process command line.
 */
export function buildWranglerCommand(
  sqlPath: string,
  target: 'local' | 'remote',
  binding: string,
  wranglerCmd = 'npx wrangler',
): string {
  const flag = target === 'local' ? '--local' : '--remote';
  return `${wranglerCmd} d1 execute ${binding} ${flag} --file "${sqlPath}"`;
}
