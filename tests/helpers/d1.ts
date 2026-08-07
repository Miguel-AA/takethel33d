// A D1-compatible database backed by `node:sqlite` (stable in Node 24).
//
// This lets the auth stack be tested against REAL SQL — the actual migration
// files, the actual CHECK constraints, the actual UNIQUE indexes and foreign
// keys — instead of a hand-written fake that would happily accept statements
// SQLite rejects.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type SqlValue = string | number | null;

function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new TypeError(`Unsupported bind value: ${typeof value}`);
}

class TestStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: SqlValue[] = [],
  ) {}

  bind(...args: unknown[]): TestStatement {
    return new TestStatement(this.db, this.sql, args.map(toSqlValue));
  }

  async first<T = unknown>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args);
    return (row ?? null) as T | null;
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: true }> {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return { results: rows as T[], success: true };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(info.changes) } };
  }
}

export interface TestDatabase {
  /** Usable anywhere a `D1Database` is expected. */
  d1: D1Database;
  /** Direct handle, for assertions that bypass the adapter. */
  raw: DatabaseSync;
  close(): void;
}

function createAdapter(raw: DatabaseSync): D1Database {
  /**
   * Serialises batches.
   *
   * `node:sqlite` is one synchronous connection, so two overlapping
   * BEGIN/COMMIT blocks would raise "cannot start a transaction within a
   * transaction". Real D1 isolates concurrent batches from each other, and
   * queuing reproduces that: each batch sees the committed result of the one
   * before it, which is exactly what the revision guards are written against.
   */
  let queue: Promise<unknown> = Promise.resolve();

  return {
    prepare: (sql: string) => new TestStatement(raw, sql),
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
    /**
     * Runs statements inside one transaction, mirroring D1's `batch()`.
     *
     * The atomicity is the point: event mutations commit together with their
     * audit row, so a mutation cannot land without the record of who made it.
     * Statements run sequentially on the same connection, so SQL `changes()`
     * sees the preceding statement — which is how a conditional audit insert
     * knows whether the guarded UPDATE actually matched.
     */
    batch: async (statements: TestStatement[]) => {
      const run = queue.then(async () => {
        raw.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          raw.exec('COMMIT');
          return results;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        }
      });
      // The queue must keep advancing even when a batch fails.
      queue = run.catch(() => undefined);
      return run;
    },
  } as unknown as D1Database;
}

export function migrationFiles(): string[] {
  const dir = join(process.cwd(), 'migrations');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

export function readMigration(name: string): string {
  return readFileSync(join(process.cwd(), 'migrations', name), 'utf8');
}

export interface CreateOptions {
  /** Stop after this migration (inclusive). Defaults to applying all of them. */
  through?: string;
  /** Enforce foreign keys once migrations have run. Default: true. */
  foreignKeys?: boolean;
}

/**
 * Builds a database by replaying the real migration files in order.
 *
 * Foreign keys stay OFF during replay because migration 0003 drops `attendees`
 * while `raffle_draws` still references it — the same condition D1 tolerates —
 * and are switched on afterwards so tests exercise real FK enforcement.
 */
export function createTestDatabase(options: CreateOptions = {}): TestDatabase {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF;');

  for (const name of migrationFiles()) {
    raw.exec(readMigration(name));
    if (options.through && name === options.through) break;
  }

  if (options.foreignKeys !== false) {
    raw.exec('PRAGMA foreign_keys = ON;');
  }

  return {
    d1: createAdapter(raw),
    raw,
    close: () => raw.close(),
  };
}

/** Lists the tables currently present, excluding SQLite internals. */
export function tableNames(raw: DatabaseSync): string[] {
  return (
    raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** Lists index names for a table. */
export function indexNames(raw: DatabaseSync, table: string): string[] {
  return (
    raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
      )
      .all(table) as Array<{ name: string }>
  ).map((row) => row.name);
}
