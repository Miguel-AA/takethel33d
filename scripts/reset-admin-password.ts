// Replaces one administrator's password, then PROVES the new one works.
//
// WHY THIS EXISTS AT ALL. The bootstrap reported success, the row it wrote was
// structurally perfect, and the owner still could not log in — because "a hash
// was written" and "this credential authenticates" are different claims, and
// only the first was ever checked. Every layer was individually correct and the
// whole was not.
//
// So this tool does not finish when the UPDATE lands. While the password is
// still in memory it:
//
//   1. re-reads the stored hash from the database it just wrote to,
//   2. verifies the captured password against it with the canonical verifier,
//   3. performs a REAL HTTPS login against production,
//   4. makes one authenticated request with the session that login returned,
//   5. logs that session out again.
//
// If any of those fails, the reset is reported as FAILED even though the row
// changed — because from the owner's side it did fail. Nobody is sent to a
// browser on the strength of a database write.
//
// WHAT NEVER HAPPENS TO THE PASSWORD: it is not a command-line option, never
// printed, never written to a file, never put in an environment variable, and
// never sent anywhere except the production login endpoint over HTTPS.
//
//   npm run reset:admin-password -- --email you@example.com --remote --confirm taketheleed

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, verifyPassword } from '../functions/_shared/password.ts';
import { canPromptInteractively, promptHidden, promptVisible } from './securePrompt.ts';
import { buildWranglerCommand } from './bootstrapAdmin.lib.ts';
import {
  buildHashReadSql,
  buildLookupSql,
  buildResetStatements,
  describeHash,
  parseArgs,
  validateInput,
} from './resetAdminPassword.lib.ts';

const DATABASE_BINDING = 'DB';
const DATABASE_NAME = 'taketheleed';
const PRODUCTION_ORIGIN = 'https://takethel33d.pages.dev';

const USAGE = `
Reset an existing administrator's password.

Usage:
  npm run reset:admin-password -- --email <email> [options]

Options:
  --email <email>        Administrator whose password is being replaced (required)
  --local                Target the local D1 database (default)
  --remote               Target the PRODUCTION D1 database
  --confirm <db-name>    Non-interactive confirmation for --remote
  --dry-run              Show what would change; write nothing
  --skip-login-check     Do not verify against the production URL (--local only)
  --help                 Show this message

The password is typed at a hidden prompt. It is never an option, never printed
and never stored anywhere but the database, as a PBKDF2 hash.

After writing, the new password is verified against the stored hash AND used to
perform one real login. The reset only succeeds if that login succeeds.
`;

function fail(message: string): never {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

interface WranglerResult {
  status: number;
  output: string;
}

/**
 * Runs SQL through wrangler.
 *
 * Written to a temporary FILE and passed with `--file`, never inlined with
 * `--command` — the same reasoning the bootstrap records: a shell is required
 * to reach wrangler on Windows and would tear an inlined statement into
 * separate arguments, and the file keeps the password hash out of the process
 * command line where other users could read it.
 */
function runWranglerSql(sql: string, target: 'local' | 'remote'): WranglerResult {
  const directory = mkdtempSync(join(tmpdir(), 'l33d-reset-'));
  const sqlPath = join(directory, 'statement.sql');

  try {
    writeFileSync(sqlPath, sql, { encoding: 'utf8', mode: 0o600 });
    const command = buildWranglerCommand(
      sqlPath,
      target,
      DATABASE_BINDING,
      process.env.WRANGLER_CMD ?? 'npx wrangler',
    );
    const result = spawnSync(command, { encoding: 'utf8', shell: true });
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    };
  } finally {
    // The file holds a password hash; remove it whatever happened.
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Runs a read and returns its rows, or null when the output is unreadable.
 *
 * USES `--command`, NOT `--file`, and the distinction is not cosmetic: against
 * a REMOTE database wrangler uploads a file and answers with execution
 * STATISTICS — "Total queries executed", "Rows read" — rather than the selected
 * rows. A read issued that way silently returns a shape with none of the
 * requested columns in it, which is exactly what happened the first time this
 * was written.
 *
 * Inlining is safe here and only here: a read carries no credential. Every
 * statement that contains a password hash still goes through `runWranglerSql`
 * and a temporary file, so the hash never reaches the process command line.
 */
function queryRows(sql: string, target: 'local' | 'remote'): Record<string, unknown>[] | null {
  const wrangler = process.env.WRANGLER_CMD ?? 'npx wrangler';
  const flag = target === 'local' ? '--local' : '--remote';
  // The statements built here quote with single quotes only, so wrapping in
  // double quotes is unambiguous on both PowerShell and POSIX shells.
  const command = `${wrangler} d1 execute ${DATABASE_BINDING} ${flag} --json --command "${sql.replace(
    /"/g,
    '\\"',
  )}"`;

  const result = spawnSync(command, { encoding: 'utf8', shell: true });
  if ((result.status ?? 1) !== 0) return null;

  try {
    // wrangler prints a decorated banner before the JSON. Anchor on a line that
    // is exactly `[` rather than the first bracket anywhere, because the banner
    // contains ANSI escapes — which begin with one.
    const text = result.stdout ?? '';
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === '[');
    if (start === -1) return null;
    const parsed = JSON.parse(lines.slice(start).join('\n')) as Array<{ results?: unknown }>;
    return (parsed[0]?.results as Record<string, unknown>[]) ?? [];
  } catch {
    return null;
  }
}

/**
 * Logs in for real, uses the session once, then throws it away.
 *
 * This is the check the bootstrap was missing. It exercises the entire path the
 * owner is about to use — the deployed Worker, its D1 binding, the login
 * endpoint, the password verifier, session creation and session validation —
 * with the exact bytes that were just hashed.
 */
async function verifyRealLogin(
  origin: string,
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetch(`${origin}/api/manager/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    return { ok: false, reason: `login request failed: ${(err as Error).message}` };
  }

  if (!response.ok) {
    // The body carries a typed code and never the credential.
    let code = String(response.status);
    try {
      const body = (await response.json()) as { error?: { code?: string } };
      code = body.error?.code ?? code;
    } catch {
      /* keep the status */
    }
    return { ok: false, reason: `login refused (${code})` };
  }

  const cookie = response.headers.get('set-cookie');
  if (!cookie) return { ok: false, reason: 'login succeeded but issued no session' };
  // Only the name=value pair is sent back; the attributes are for a browser.
  const sessionCookie = cookie.split(';')[0];

  const me = await fetch(`${origin}/api/manager/me`, { headers: { Cookie: sessionCookie } });
  if (!me.ok) return { ok: false, reason: `session did not authenticate (${me.status})` };

  // Leave nothing behind: the diagnostic session is logged out immediately.
  const out = await fetch(`${origin}/api/manager/logout`, {
    method: 'POST',
    headers: { Cookie: sessionCookie },
  });
  if (!out.ok) return { ok: false, reason: `logout failed (${out.status})` };

  const after = await fetch(`${origin}/api/manager/me`, { headers: { Cookie: sessionCookie } });
  if (after.ok) return { ok: false, reason: 'session still valid after logout' };

  return { ok: true };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (!args.dryRun && !canPromptInteractively()) {
    fail(
      'This command needs a real terminal: the password is typed at a hidden prompt.\n' +
        'Run it directly in PowerShell or a shell, not through a pipe or a task runner.',
    );
  }

  // Guardrail: writing to production requires naming the database explicitly,
  // so `--remote` can never be triggered by a stray flag alone.
  if (args.target === 'remote' && !args.dryRun) {
    const confirmation =
      args.confirm ??
      (await promptVisible(
        `\nYou are about to change a password in the REMOTE (production) database.\n` +
          `Type the database name (${DATABASE_NAME}) to continue: `,
      ));
    if (confirmation.trim() !== DATABASE_NAME) {
      fail('Confirmation did not match the database name. Nothing was written.');
    }
  }

  const email = args.email ?? (await promptVisible('Email: '));

  // Resolve the account BEFORE asking for a password, so a typo in the address
  // is caught before somebody types a credential.
  const rows = queryRows(buildLookupSql(email.trim().toLowerCase()), args.target);
  if (rows === null) fail('Could not read the administrator table. Nothing was changed.');
  if (rows.length === 0) fail(`No administrator found for ${email}. Nothing was changed.`);
  if (rows.length > 1) {
    fail(`${rows.length} administrators share that address. Refusing to guess.`);
  }

  const account = rows[0] as {
    id: string;
    email: string;
    display_name: string;
    role: string;
    status: string;
  };

  process.stdout.write(
    `\nAccount:\n` +
      `  email:  ${account.email}\n` +
      `  name:   ${account.display_name}\n` +
      `  role:   ${account.role}\n` +
      `  status: ${account.status}\n\n`,
  );

  if (args.dryRun) {
    process.stdout.write(
      `-- dry run (${args.target}); nothing was executed --\n` +
        buildResetStatements({
          adminId: account.id,
          passwordHash: '<redacted: a fresh pbkdf2-sha256 hash>',
          timestamp: new Date().toISOString(),
        }) +
        '\n',
    );
    return;
  }

  const password = await promptHidden('New password (min 12 chars): ');
  const repeated = await promptHidden('Confirm password: ');
  if (repeated !== password) fail('Passwords did not match. Nothing was changed.');

  const validated = validateInput({ email, password });
  if (!validated.ok) {
    fail(`Invalid input:\n  - ${validated.errors.join('\n  - ')}`);
  }

  const passwordHash = await hashPassword(validated.value.password);
  const sql = buildResetStatements({
    adminId: account.id,
    passwordHash,
    timestamp: new Date().toISOString(),
  });

  const written = runWranglerSql(sql, args.target);
  if (written.status !== 0) {
    fail(`The password was not changed.\n${written.output.trim()}`);
  }
  process.stdout.write('Password updated; existing sessions revoked.\n');

  // --- the checks the bootstrap did not make -------------------------------

  const stored = queryRows(buildHashReadSql(validated.value.normalizedEmail), args.target);
  if (!stored || stored.length !== 1) fail('Could not read the stored hash back.');
  const storedHash = String(stored[0].password_hash ?? '');

  const shape = describeHash(storedHash);
  process.stdout.write(
    `Stored hash: ${shape.algorithm}, ${shape.iterations} iterations, ` +
      `${shape.saltBytes}-byte salt, ${shape.digestBytes}-byte digest\n`,
  );
  if (!shape.valid) fail('The stored hash does not match the expected format.');

  const parity = await verifyPassword(validated.value.password, storedHash);
  process.stdout.write(`Verifies against the stored hash: ${parity ? 'YES' : 'NO'}\n`);
  if (!parity) {
    fail(
      'The password you typed does NOT verify against what was stored.\n' +
        'Do not try to log in; report this.',
    );
  }

  if (args.target === 'local' || args.skipLoginCheck) {
    process.stdout.write('\nLogin check skipped (local target).\n');
    return;
  }

  process.stdout.write(`\nVerifying a real login against ${PRODUCTION_ORIGIN} ...\n`);
  const login = await verifyRealLogin(
    PRODUCTION_ORIGIN,
    validated.value.normalizedEmail,
    validated.value.password,
  );

  if (!login.ok) {
    fail(
      `The password was stored and verifies locally, but the real login FAILED:\n` +
        `  ${login.reason}\n` +
        `Do not try to log in from the browser; report this.`,
    );
  }

  process.stdout.write(
    '\nReal login: PASS\n' +
      '  authenticated request: PASS\n' +
      '  logout: PASS\n\n' +
      `You can now sign in at ${PRODUCTION_ORIGIN}/manager/login\n`,
  );
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
