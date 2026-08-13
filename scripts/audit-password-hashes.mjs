// Audits every stored administrator password hash against the project's own
// hashing contract.
//
// WHAT IT NEVER DOES: learn, guess or verify a password. It reads only the
// STRUCTURE of the encoded hash — algorithm, cost, salt and digest — which is
// exactly what tells you whether an account is protected properly. A hash with
// one PBKDF2 iteration is not a password; it is a formality.
//
// THE AUTHORITY IS `functions/_shared/password.ts`, imported rather than
// restated. A second copy of `PBKDF2_ITERATIONS` here would be a number that
// could quietly disagree with the one the application actually uses, and this
// script exists to catch precisely that class of drift.
//
//   node scripts/audit-password-hashes.mjs <path-to-sqlite-db> [--json]
//
// Exit code 0 when every hash meets the contract, 1 when any does not — so it
// can be a gate rather than a report somebody has to read.

import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { PBKDF2_ALGORITHM, PBKDF2_ITERATIONS } from '../functions/_shared/password.ts';

/** The shape the application writes: alg$iterations$base64(salt)$base64(key). */
const EXPECTED_PARTS = 4;
const MIN_SALT_BYTES = 16;
const MIN_KEY_BYTES = 32;

function decodeBase64Length(value) {
  try {
    return Buffer.from(value, 'base64').length;
  } catch {
    return -1;
  }
}

/**
 * Everything wrong with one stored hash.
 *
 * Returns a list rather than a boolean so an operator is told WHICH property
 * failed — "too few iterations" and "malformed" need different responses.
 */
export function auditHash(encoded) {
  const problems = [];

  if (typeof encoded !== 'string' || encoded.length === 0) {
    return ['missing'];
  }

  const parts = encoded.split('$');
  if (parts.length !== EXPECTED_PARTS) return ['malformed'];

  const [algorithm, iterationsRaw, salt, key] = parts;

  if (algorithm !== PBKDF2_ALGORITHM) problems.push(`algorithm:${algorithm}`);

  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 1) {
    problems.push('iterations:unparseable');
  } else if (iterations < PBKDF2_ITERATIONS) {
    // The cost is stored inside the hash so it can be raised over time, which
    // means a LOW value is a real account that was created weakly rather than a
    // corruption. Reported with the number so the gap is visible.
    problems.push(`iterations:${iterations}<${PBKDF2_ITERATIONS}`);
  }

  const saltBytes = decodeBase64Length(salt);
  if (saltBytes < MIN_SALT_BYTES) problems.push(`salt:${saltBytes}bytes`);

  const keyBytes = decodeBase64Length(key);
  if (keyBytes < MIN_KEY_BYTES) problems.push(`digest:${keyBytes}bytes`);

  return problems;
}

function main() {
  const [, , dbPath, ...flags] = process.argv;
  if (!dbPath) {
    console.error('usage: node scripts/audit-password-hashes.mjs <db> [--json]');
    process.exit(2);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows;
  try {
    rows = db.prepare('SELECT id, email, status, password_hash FROM admin_users').all();
  } catch (err) {
    console.error(`cannot read admin_users: ${err.message}`);
    process.exit(2);
  } finally {
    db.close();
  }

  const findings = rows
    .map((row) => ({
      // The email identifies the account to whoever must fix it. The hash
      // itself is NEVER printed — not even truncated: a prefix still leaks the
      // salt, and there is no reason to put any of it in a transcript.
      email: row.email,
      status: row.status,
      problems: auditHash(row.password_hash),
    }))
    .filter((finding) => finding.problems.length > 0);

  if (flags.includes('--json')) {
    console.log(JSON.stringify({ audited: rows.length, findings }, null, 2));
  } else {
    console.log(`audited: ${rows.length} account(s)`);
    console.log(`contract: ${PBKDF2_ALGORITHM}, >= ${PBKDF2_ITERATIONS} iterations`);
    if (findings.length === 0) {
      console.log('weak or malformed hashes: 0');
    } else {
      console.log(`weak or malformed hashes: ${findings.length}`);
      for (const finding of findings) {
        console.log(`  ${finding.email} [${finding.status}] -> ${finding.problems.join(', ')}`);
      }
    }
  }

  process.exit(findings.length === 0 ? 0 : 1);
}

// Only when run directly, so `auditHash` can be imported by a test without the
// script trying to open a database.
//
// Compared as a FILE URL rather than by string suffix: on Windows `argv[1]` is
// `C:\...\audit-password-hashes.mjs` while `import.meta.url` is
// `file:///C:/...`, and a suffix match silently never fires — which it did,
// producing a clean exit code and no output at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
