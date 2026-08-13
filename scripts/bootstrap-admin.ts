// Creates the first (or an additional) administrator account.
//
//   npm run bootstrap:admin -- --email you@example.com --name "Your Name"
//   npm run bootstrap:admin -- --email you@example.com --name "You" --remote --confirm taketheleed
//
// Run directly with Node 24+ (native TypeScript execution). The password is
// NEVER passed on the command line — it is read from the ADMIN_BOOTSTRAP_PASSWORD
// environment variable or prompted for with echo disabled, so it does not land
// in shell history or the process list.
//
// There is deliberately no public endpoint that creates administrators: this
// script requires local access to the project and to wrangler's credentials.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../functions/_shared/password.ts';
import { promptHidden, promptVisible } from './securePrompt.ts';
import {
  buildDuplicateCheckSql,
  buildInsertSql,
  buildWranglerCommand,
  isUniqueViolation,
  parseArgs,
  validateInput,
} from './bootstrapAdmin.lib.ts';

const DATABASE_BINDING = 'DB';
const DATABASE_NAME = 'taketheleed';

const USAGE = `
Create an administrator for the L33D admin panel.

Usage:
  npm run bootstrap:admin -- --email <email> --name <display name> [options]

Options:
  --email <email>        Administrator email (required)
  --name <name>          Display name (required)
  --local                Write to the local D1 database (default)
  --remote               Write to the PRODUCTION D1 database
  --confirm <db-name>    Non-interactive confirmation for --remote
  --dry-run              Print the SQL without executing it
  -h, --help             Show this message

The password is read from the ADMIN_BOOTSTRAP_PASSWORD environment variable,
or prompted for interactively. Minimum length: 12 characters.
`.trim();

function fail(message: string): never {
  process.stderr.write(`\nerror: ${message}\n`);
  process.exit(1);
}

interface WranglerResult {
  status: number;
  output: string;
}

/**
 * Runs SQL through wrangler.
 *
 * The statement is written to a temporary FILE and passed with `--file`, never
 * inlined with `--command`. Two reasons:
 *
 *  1. Correctness. Reaching wrangler requires a shell (on Windows `npx` is a
 *     `.cmd`, which Node refuses to spawn without one), and a shell does not
 *     quote an argument array — so a multi-word SQL string is torn into
 *     separate arguments and wrangler fails with "Unknown arguments: INTO,
 *     admin_users". Only the file path crosses the shell boundary, and it is
 *     quoted.
 *  2. Secrecy. The generated password hash never appears in the process
 *     command line, where other users on the machine could read it.
 */
function runWrangler(sql: string, target: 'local' | 'remote'): WranglerResult {
  const directory = mkdtempSync(join(tmpdir(), 'l33d-bootstrap-'));
  const sqlPath = join(directory, 'statement.sql');

  try {
    writeFileSync(sqlPath, sql, { encoding: 'utf8', mode: 0o600 });

    // WRANGLER_CMD is overridable so an operator whose locally installed
    // wrangler is broken or outdated can point at a working one, e.g.
    //   WRANGLER_CMD="npx --yes wrangler@latest" npm run bootstrap:admin -- ...
    const command = buildWranglerCommand(
      sqlPath,
      target,
      DATABASE_BINDING,
      process.env.WRANGLER_CMD ?? 'npx wrangler',
    );

    const result = spawnSync(command, {
      encoding: 'utf8',
      shell: true,
    });

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return { status: result.status ?? 1, output };
  } finally {
    // The file holds a password hash; remove it whatever happened.
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  // Guardrail: writing to production requires naming the database explicitly,
  // so `--remote` can never be triggered by a stray flag alone.
  if (args.target === 'remote' && !args.dryRun) {
    const confirmation =
      args.confirm ??
      (await promptVisible(
        `\nYou are about to write to the REMOTE (production) database.\n` +
          `Type the database name (${DATABASE_NAME}) to continue: `,
      ));
    if (confirmation.trim() !== DATABASE_NAME) {
      fail('Confirmation did not match the database name. Nothing was written.');
    }
  }

  const email = args.email ?? (await promptVisible('Email: '));
  const displayName = args.displayName ?? (await promptVisible('Display name: '));

  const envPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const password = envPassword ?? (await promptHidden('Password (min 12 chars): '));
  if (!envPassword) {
    const repeated = await promptHidden('Confirm password: ');
    if (repeated !== password) fail('Passwords did not match.');
  }

  const validated = validateInput({ email, displayName, password });
  if (!validated.ok) {
    fail(`Invalid input:\n  - ${validated.errors.join('\n  - ')}`);
  }

  const passwordHash = await hashPassword(validated.value.password);
  const sql = buildInsertSql({
    id: crypto.randomUUID(),
    email: validated.value.email,
    normalizedEmail: validated.value.normalizedEmail,
    displayName: validated.value.displayName,
    passwordHash,
    timestamp: new Date().toISOString(),
  });

  if (args.dryRun) {
    // The hash is REDACTED, not printed.
    //
    // A dry run exists so somebody can read the statement before it is
    // executed, and the one field they must not need to read is the credential
    // material. Printing it puts a real account's salt and derived key into a
    // terminal scrollback, a screen share or a pasted transcript — and a dry
    // run is exactly the command somebody runs when they intend to show
    // somebody else what will happen.
    //
    // What is shown instead identifies the ALGORITHM and COST, which is what a
    // reviewer actually wants to check.
    const [algorithm, iterations] = passwordHash.split('$');
    process.stdout.write(
      `\n-- dry run (${args.target}); nothing was executed --\n` +
        `${sql.replace(`'${passwordHash}'`, `'<redacted: ${algorithm}, ${iterations} iterations>'`)}\n`,
    );
    return;
  }

  // Best-effort pre-check for a friendlier message. The UNIQUE index on
  // normalized_email remains the authoritative guard against duplicates.
  const check = runWrangler(
    buildDuplicateCheckSql(validated.value.normalizedEmail),
    args.target,
  );
  if (check.status === 0 && /"id"\s*:/.test(check.output)) {
    fail(`An administrator with email ${validated.value.email} already exists.`);
  }

  const result = runWrangler(sql, args.target);
  if (result.status !== 0) {
    if (isUniqueViolation(result.output)) {
      fail(`An administrator with email ${validated.value.email} already exists.`);
    }
    process.stderr.write(result.output);
    fail(
      'wrangler failed (its output is above). Common causes:\n' +
        `  * migrations not applied: npx wrangler d1 migrations apply ${DATABASE_BINDING} --${args.target}\n` +
        '  * a broken or outdated local wrangler: retry with\n' +
        '    WRANGLER_CMD="npx --yes wrangler@latest" npm run bootstrap:admin -- ...',
    );
  }

  process.stdout.write(
    `\nAdministrator created (${args.target}):\n` +
      `  email: ${validated.value.email}\n` +
      `  name:  ${validated.value.displayName}\n` +
      `  role:  ADMIN\n  status: ACTIVE\n\n` +
      `Sign in at /manager/login.\n`,
  );
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
