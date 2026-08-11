// @vitest-environment node
//
// Replays the real migration files against real SQLite.

import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  createTestDatabase,
  indexNames,
  migrationFiles,
  readMigration,
  tableNames,
} from './helpers/d1';

describe('migrations', () => {
  it('apply cleanly from an empty schema', () => {
    const db = createTestDatabase();
    try {
      const tables = tableNames(db.raw);
      expect(tables).toContain('admin_users');
      expect(tables).toContain('admin_sessions');
      expect(tables).toContain('admin_login_attempts');
    } finally {
      db.close();
    }
  });

  it('0005 applies on top of the pre-existing (0001-0004) schema', () => {
    const before = createTestDatabase({ through: '0004_events_lead_fields.sql' });
    try {
      expect(tableNames(before.raw)).toContain('manager_sessions');
      expect(tableNames(before.raw)).not.toContain('admin_users');

      before.raw.exec(readMigration('0005_admin_identity.sql'));

      const after = tableNames(before.raw);
      expect(after).toContain('admin_users');
      expect(after).toContain('admin_sessions');
    } finally {
      before.close();
    }
  });

  it('preserves unrelated tables and their data', () => {
    const db = createTestDatabase({ through: '0004_events_lead_fields.sql' });
    try {
      db.raw
        .prepare(
          `INSERT INTO attendees (id, participant_number, first_name, last_name, email, phone)
           VALUES ('a1', 1, 'Ana', 'Lopez', 'ana@example.com', '555')`,
        )
        .run();

      db.raw.exec(readMigration('0005_admin_identity.sql'));

      const tables = tableNames(db.raw);
      expect(tables).toContain('attendees');
      expect(tables).toContain('raffle_draws');

      const row = db.raw
        .prepare('SELECT email FROM attendees WHERE id = ?')
        .get('a1') as { email: string };
      expect(row.email).toBe('ana@example.com');
    } finally {
      db.close();
    }
  });

  it('invalidates legacy sessions by dropping manager_sessions', () => {
    const db = createTestDatabase({ through: '0004_events_lead_fields.sql' });
    try {
      db.raw
        .prepare(
          "INSERT INTO manager_sessions (token, expires_at) VALUES ('legacy-token', '2099-01-01')",
        )
        .run();
      expect(
        (db.raw.prepare('SELECT COUNT(*) AS n FROM manager_sessions').get() as { n: number }).n,
      ).toBe(1);

      db.raw.exec(readMigration('0005_admin_identity.sql'));

      // The table is gone, so no legacy token can authenticate anything.
      expect(tableNames(db.raw)).not.toContain('manager_sessions');
    } finally {
      db.close();
    }
  });

  it('declares the expected indexes and unique constraints', () => {
    const db = createTestDatabase();
    try {
      const userIndexes = indexNames(db.raw, 'admin_users').join(' ');
      expect(userIndexes).toContain('idx_admin_users_normalized_email');
      expect(userIndexes).toContain('idx_admin_users_status');

      const sessionIndexes = indexNames(db.raw, 'admin_sessions').join(' ');
      expect(sessionIndexes).toContain('idx_admin_sessions_token_hash');
      expect(sessionIndexes).toContain('idx_admin_sessions_admin_user');
      expect(sessionIndexes).toContain('idx_admin_sessions_expires');

      // normalized_email must actually be unique, not merely indexed.
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','A@x.com','a@x.com','A','h')`,
        )
        .run();

      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
             VALUES ('u2','A@X.com','a@x.com','B','h')`,
          )
          .run(),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('rejects unknown role and status values', () => {
    const db = createTestDatabase();
    try {
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash, status)
             VALUES ('u3','a@x.com','a@x.com','A','h','GHOST')`,
          )
          .run(),
      ).toThrow(/CHECK/i);

      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash, role)
             VALUES ('u4','b@x.com','b@x.com','B','h','SUPERUSER')`,
          )
          .run(),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('refuses a session without a real owner (no orphan sessions)', () => {
    const db = createTestDatabase();
    try {
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at)
             VALUES ('s1','does-not-exist','hash','2099-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/i);

      // admin_user_id is NOT NULL, so a session can never be unattributed.
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at)
             VALUES ('s2', NULL, 'hash','2099-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/NOT NULL/i);
    } finally {
      db.close();
    }
  });

  it('supports creating an administrator and an attributable session', () => {
    const db = createTestDatabase();
    try {
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','Ada@Example.com','ada@example.com','Ada','pbkdf2-sha256$1$c2E=$aGE=')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at)
           VALUES ('s1','u1','token-hash','2099-01-01T00:00:00.000Z')`,
        )
        .run();

      const joined = db.raw
        .prepare(
          `SELECT a.display_name AS name, s.id AS session_id
           FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_user_id`,
        )
        .get() as { name: string; session_id: string };

      expect(joined.name).toBe('Ada');
      expect(joined.session_id).toBe('s1');

      // Defaults must land, including the ISO-8601 timestamp convention.
      const created = db.raw
        .prepare('SELECT created_at, role, status FROM admin_users WHERE id = ?')
        .get('u1') as { created_at: string; role: string; status: string };
      expect(created.role).toBe('ADMIN');
      expect(created.status).toBe('ACTIVE');
      expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      db.close();
    }
  });

  it('token_hash is unique across sessions', () => {
    const db = createTestDatabase();
    try {
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','a@x.com','a@x.com','A','h')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at)
           VALUES ('s1','u1','same-hash','2099-01-01T00:00:00.000Z')`,
        )
        .run();

      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at)
             VALUES ('s2','u1','same-hash','2099-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('0006 applies on top of a populated 0001-0005 schema and preserves data', () => {
    const db = createTestDatabase({ through: '0005_admin_identity.sql' });
    try {
      // Populate every pre-existing table.
      db.raw
        .prepare(
          `INSERT INTO attendees (id, participant_number, first_name, last_name, email, phone)
           VALUES ('a1', 1, 'Ana', 'Lopez', 'ana@example.com', '555')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO raffle_draws (attendee_id, drawn_at, mode)
           VALUES ('a1', '2026-01-01T00:00:00.000Z', 'random')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','A@x.com','a@x.com','A','pbkdf2-sha256$1$c2E=$aGE=')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at)
           VALUES ('s1','u1','hash-1','2099-01-01T00:00:00.000Z')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO admin_login_attempts (bucket_key, attempts, window_started_at, updated_at)
           VALUES ('email:abc', 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();

      expect(tableNames(db.raw)).not.toContain('audit_logs');
      db.raw.exec(readMigration('0006_audit_and_data_conventions.sql'));
      expect(tableNames(db.raw)).toContain('audit_logs');

      // Nothing pre-existing was disturbed.
      const counts = (table: string) =>
        (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(counts('attendees')).toBe(1);
      expect(counts('raffle_draws')).toBe(1);
      expect(counts('admin_users')).toBe(1);
      expect(counts('admin_sessions')).toBe(1);
      expect(counts('admin_login_attempts')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('audit_logs declares the expected indexes', () => {
    const db = createTestDatabase();
    try {
      const indexes = indexNames(db.raw, 'audit_logs').join(' ');
      for (const expected of [
        'idx_audit_logs_created_at',
        'idx_audit_logs_actor_admin_id',
        'idx_audit_logs_action',
        'idx_audit_logs_event_id',
        'idx_audit_logs_request_id',
        'idx_audit_logs_entity',
      ]) {
        expect(indexes, expected).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it('audit_logs enforces its non-empty and timestamp constraints', () => {
    const db = createTestDatabase();
    try {
      const insert = (columns: string, values: string) =>
        db.raw.prepare(`INSERT INTO audit_logs (${columns}) VALUES (${values})`).run();

      const base = 'id, action, entity_type, request_id, created_at';
      const good = `'i1','ADMIN_LOGOUT','ADMIN_SESSION','r1','2026-01-01T00:00:00.000Z'`;
      expect(() => insert(base, good)).not.toThrow();

      // Empty identity/credential-shaped columns are refused.
      expect(() =>
        insert(base, `'','ADMIN_LOGOUT','ADMIN_SESSION','r1','2026-01-01T00:00:00.000Z'`),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(base, `'i2','','ADMIN_SESSION','r1','2026-01-01T00:00:00.000Z'`),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(base, `'i3','ADMIN_LOGOUT','','r1','2026-01-01T00:00:00.000Z'`),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(base, `'i4','ADMIN_LOGOUT','ADMIN_SESSION','','2026-01-01T00:00:00.000Z'`),
      ).toThrow(/CHECK/i);

      // A naive SQLite timestamp must never enter this column.
      expect(() =>
        insert(base, `'i5','ADMIN_LOGOUT','ADMIN_SESSION','r1','2026-01-01 00:00:00'`),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(base, `'i6','ADMIN_LOGOUT','ADMIN_SESSION','r1','2026-01-01T00:00:00Z'`),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('audit_logs keeps history when its actor is deleted (SET NULL, not CASCADE)', () => {
    const db = createTestDatabase();
    try {
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','a@x.com','a@x.com','A','h')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO audit_logs (id, actor_admin_id, action, entity_type, request_id, created_at)
           VALUES ('l1','u1','EVENT_CREATED','EVENT','r1','2026-01-01T00:00:00.000Z')`,
        )
        .run();

      db.raw.prepare('DELETE FROM admin_users WHERE id = ?').run('u1');

      const row = db.raw
        .prepare('SELECT actor_admin_id, action FROM audit_logs WHERE id = ?')
        .get('l1') as { actor_admin_id: string | null; action: string };
      expect(row).toBeDefined();
      expect(row.actor_admin_id).toBeNull();
      expect(row.action).toBe('EVENT_CREATED');
    } finally {
      db.close();
    }
  });

  it('audit_logs rejects an actor that never existed', () => {
    const db = createTestDatabase();
    try {
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO audit_logs (id, actor_admin_id, action, entity_type, request_id, created_at)
             VALUES ('l2','ghost','EVENT_CREATED','EVENT','r1','2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('event_id stays free of a foreign key until the events table exists', () => {
    const db = createTestDatabase();
    try {
      // A later phase adds `events`; until then an event id must be storable.
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO audit_logs (id, action, entity_type, event_id, request_id, created_at)
             VALUES ('l3','EVENT_CREATED','EVENT','future-event','r1','2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).not.toThrow();

      const fks = db.raw
        .prepare("SELECT * FROM pragma_foreign_key_list('audit_logs')")
        .all() as Array<{ from: string }>;
      expect(fks.map((fk) => fk.from)).toEqual(['actor_admin_id']);
    } finally {
      db.close();
    }
  });

  it('0007 applies on top of a populated 0001-0006 schema', () => {
    const db = createTestDatabase({ through: '0006_audit_and_data_conventions.sql' });
    try {
      db.raw
        .prepare(
          `INSERT INTO attendees (id, participant_number, first_name, last_name, email, phone)
           VALUES ('a1', 1, 'Ana', 'Lopez', 'ana@example.com', '555')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','A@x.com','a@x.com','A','pbkdf2-sha256$1$c2E=$aGE=')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO audit_logs (id, actor_admin_id, action, entity_type, request_id, created_at)
           VALUES ('l1','u1','ADMIN_LOGIN_SUCCEEDED','ADMIN_SESSION','r1','2026-01-01T00:00:00.000Z')`,
        )
        .run();

      expect(tableNames(db.raw)).not.toContain('events');
      db.raw.exec(readMigration('0007_events.sql'));
      expect(tableNames(db.raw)).toContain('events');

      const counts = (table: string) =>
        (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(counts('attendees')).toBe(1);
      expect(counts('admin_users')).toBe(1);
      expect(counts('audit_logs')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('events declares its indexes and a unique slug', () => {
    const db = createTestDatabase();
    try {
      const indexes = indexNames(db.raw, 'events').join(' ');
      for (const expected of [
        'idx_events_status',
        'idx_events_created_at',
        'idx_events_updated_at',
        'idx_events_archived_at',
        'idx_events_registration_window',
        'idx_events_event_window',
      ]) {
        expect(indexes, expected).toContain(expected);
      }

      const insert = (id: string, slug: string) =>
        db.raw
          .prepare(
            `INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, 'Name', 'UTC', 'u1', 'u1',
                     '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(id, slug);

      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','a@x.com','a@x.com','A','h')`,
        )
        .run();

      insert('e1', 'unique-slug');
      expect(() => insert('e2', 'unique-slug')).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('events enforces its constraints', () => {
    const db = createTestDatabase();
    try {
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','a@x.com','a@x.com','A','h')`,
        )
        .run();

      const insert = (columns: string, values: string) =>
        db.raw.prepare(`INSERT INTO events (${columns}) VALUES (${values})`).run();

      const base =
        'id, slug, name, timezone, created_by, updated_by, created_at, updated_at';
      const ts = `'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'`;

      expect(() => insert(base, `'e1','ok','Name','UTC','u1','u1',${ts}`)).not.toThrow();

      // Empty identity columns.
      expect(() => insert(base, `'e2','','Name','UTC','u1','u1',${ts}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'e3','s3','   ','UTC','u1','u1',${ts}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'e4','s4','Name','','u1','u1',${ts}`)).toThrow(/CHECK/i);

      // Naive timestamps cannot enter.
      expect(() =>
        insert(base, `'e5','s5','Name','UTC','u1','u1','2026-01-01 00:00:00',${ts.split(',')[1]}`),
      ).toThrow(/CHECK/i);

      // Bounds.
      expect(() =>
        insert(
          `${base}, minimum_age`,
          `'e6','s6','Name','UTC','u1','u1',${ts}, 131`,
        ),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(
          `${base}, max_entries_per_identity`,
          `'e7','s7','Name','UTC','u1','u1',${ts}, 0`,
        ),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(`${base}, status`, `'e8','s8','Name','UTC','u1','u1',${ts}, 'MADE_UP'`),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(`${base}, revision`, `'e9','s9','Name','UTC','u1','u1',${ts}, 0`),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('events RESTRICTS deleting an administrator who owns one', () => {
    const db = createTestDatabase();
    try {
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','a@x.com','a@x.com','A','h')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
           VALUES ('e1','slug','Name','UTC','u1','u1',
                   '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        )
        .run();

      // Attribution must not be lost silently, and the event must not vanish
      // with its author.
      expect(() => db.raw.prepare('DELETE FROM admin_users WHERE id = ?').run('u1')).toThrow(
        /FOREIGN KEY/i,
      );
      const still = db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      expect(still.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('0008 applies on top of a populated 0001-0007 schema', () => {
    const db = createTestDatabase({ through: '0007_events.sql' });
    try {
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','A@x.com','a@x.com','A','pbkdf2-sha256$1$c2E=$aGE=')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO attendees (id, participant_number, first_name, last_name, email, phone)
           VALUES ('a1', 1, 'Ana', 'Lopez', 'ana@example.com', '555')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO audit_logs (id, actor_admin_id, action, entity_type, request_id, created_at)
           VALUES ('l1','u1','ADMIN_LOGIN_SUCCEEDED','ADMIN_SESSION','r1','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
           VALUES ('e1','existing','Existing','UTC','u1','u1',
                   '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        )
        .run();

      expect(tableNames(db.raw)).not.toContain('event_prizes');
      db.raw.exec(readMigration('0008_event_prizes.sql'));
      expect(tableNames(db.raw)).toContain('event_prizes');

      const counts = (table: string) =>
        (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(counts('attendees')).toBe(1);
      expect(counts('admin_users')).toBe(1);
      expect(counts('audit_logs')).toBe(1);
      expect(counts('events')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('event_prizes declares its indexes and a partial unique position', () => {
    const db = createTestDatabase();
    try {
      const indexes = indexNames(db.raw, 'event_prizes').join(' ');
      for (const expected of [
        'idx_event_prizes_event_id',
        'idx_event_prizes_event_status',
        'idx_event_prizes_event_sort',
        'idx_event_prizes_status',
        'idx_event_prizes_archived_at',
        'idx_event_prizes_updated_at',
        'idx_event_prizes_event_position',
      ]) {
        expect(indexes, expected).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it('event_prizes enforces its constraints', () => {
    const db = createTestDatabase();
    try {
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','a@x.com','a@x.com','A','h')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
           VALUES ('e1','ev','Event','UTC','u1','u1',
                   '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        )
        .run();

      const TS = `'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'`;
      const base =
        'id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at';
      const insert = (columns: string, values: string) =>
        db.raw.prepare(`INSERT INTO event_prizes (${columns}) VALUES (${values})`).run();

      expect(() => insert(base, `'p1','e1','Prize',1,0,'u1','u1',${TS}`)).not.toThrow();

      expect(() => insert(base, `'','e1','Prize',1,1,'u1','u1',${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'p3','e1','   ',1,1,'u1','u1',${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'p4','e1','Prize',0,1,'u1','u1',${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'p5','e1','Prize',1,-1,'u1','u1',${TS}`)).toThrow(/CHECK/i);
      expect(() =>
        insert(`${base}, revision`, `'p6','e1','Prize',1,1,'u1','u1',${TS},0`),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(`${base}, status`, `'p7','e1','Prize',1,1,'u1','u1',${TS},'GONE'`),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(base, `'p8','e1','Prize',1,1,'u1','u1','2026-01-01 00:00:00','2026-01-01T00:00:00.000Z'`),
      ).toThrow(/CHECK/i);

      // Archived status and its timestamp cannot disagree.
      expect(() =>
        insert(`${base}, status`, `'p9','e1','Prize',1,1,'u1','u1',${TS},'ARCHIVED'`),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(
          `${base}, archived_at`,
          `'p10','e1','Prize',1,1,'u1','u1',${TS},'2026-01-01T00:00:00.000Z'`,
        ),
      ).toThrow(/CHECK/i);

      // Unknown event or admin.
      expect(() => insert(base, `'p11','ghost','Prize',1,1,'u1','u1',${TS}`)).toThrow(
        /FOREIGN KEY/i,
      );
      expect(() => insert(base, `'p12','e1','Prize',1,1,'ghost','u1',${TS}`)).toThrow(
        /FOREIGN KEY/i,
      );

      // Position is unique among live prizes.
      expect(() => insert(base, `'p13','e1','Other',1,0,'u1','u1',${TS}`)).toThrow(/UNIQUE/i);

      // Quantity is bounded at BOTH ends.
      expect(() => insert(base, `'p14','e1','Prize',1001,1,'u1','u1',${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'p15','e1','Prize',1000,1,'u1','u1',${TS}`)).not.toThrow();

      // An empty event id is not a real owner.
      expect(() => insert(base, `'p16','','Prize',1,2,'u1','u1',${TS}`)).toThrow(/FOREIGN KEY/i);

      // Position is bounded above too: nothing may exceed the range the
      // reorder reserves for staging, so a value written outside the
      // application cannot land beyond it.
      expect(() => insert(base, `'p18','e1','Prize',1,1000101,'u1','u1',${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'p19','e1','Prize',1,1000100,'u1','u1',${TS}`)).not.toThrow();

      // The name ceiling matches the shared limit.
      const longName = 'x'.repeat(121);
      expect(() => insert(base, `'p17','e1','${longName}',1,3,'u1','u1',${TS}`)).toThrow(/CHECK/i);

      // Defaults: a row that says nothing about status or revision is a live
      // prize at revision 1, with no archive timestamp.
      const seeded = db.raw
        .prepare('SELECT status, revision, archived_at FROM event_prizes WHERE id = ?')
        .get('p1') as { status: string; revision: number; archived_at: string | null };
      expect(seeded).toEqual({ status: 'ACTIVE', revision: 1, archived_at: null });
    } finally {
      db.close();
    }
  });

  it('event_prizes RESTRICTS deleting an event or an owning admin', () => {
    const db = createTestDatabase();
    try {
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','a@x.com','a@x.com','A','h')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
           VALUES ('e1','ev','Event','UTC','u1','u1',
                   '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
           VALUES ('p1','e1','Prize',1,0,'u1','u1',
                   '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        )
        .run();

      // Prizes must never be orphaned, and their author must not vanish.
      expect(() => db.raw.prepare('DELETE FROM events WHERE id = ?').run('e1')).toThrow(
        /FOREIGN KEY/i,
      );
      expect(() => db.raw.prepare('DELETE FROM admin_users WHERE id = ?').run('u1')).toThrow(
        /FOREIGN KEY/i,
      );

      const still = db.raw
        .prepare('SELECT COUNT(*) AS n FROM event_prizes')
        .get() as { n: number };
      expect(still.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('an archived prize frees its position for a live one', () => {
    const db = createTestDatabase();
    try {
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u1','a@x.com','a@x.com','A','h')`,
        )
        .run();
      db.raw
        .prepare(
          `INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
           VALUES ('e1','ev','Event','UTC','u1','u1',
                   '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      const TS = `'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'`;

      db.raw.exec(
        `INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, status, archived_at, created_by, updated_by, created_at, updated_at)
         VALUES ('p1','e1','Archived',1,0,'ARCHIVED','2026-01-01T00:00:00.000Z','u1','u1',${TS})`,
      );
      // The partial index excludes archived rows, so position 0 is free.
      expect(() =>
        db.raw.exec(
          `INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
           VALUES ('p2','e1','Live',1,0,'u1','u1',${TS})`,
        ),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('0009 applies on top of a populated 0001-0008 schema', () => {
    const db = createTestDatabase({ through: '0008_event_prizes.sql' });
    try {
      const now = `'2026-01-01T00:00:00.000Z'`;
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','A@x.com','a@x.com','A','pbkdf2-sha256$1$c2E=$aGE=');
        INSERT INTO attendees (id, participant_number, first_name, last_name, email, phone)
        VALUES ('a1', 1, 'Ana', 'Lopez', 'ana@example.com', '555');
        INSERT INTO audit_logs (id, actor_admin_id, action, entity_type, request_id, created_at)
        VALUES ('l1','u1','ADMIN_LOGIN_SUCCEEDED','ADMIN_SESSION','r1',${now});
        INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','existing','Existing','UTC','u1','u1',${now},${now});
        INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
        VALUES ('p1','e1','A prize',1,0,'u1','u1',${now},${now});
      `);

      expect(tableNames(db.raw)).not.toContain('event_form_drafts');
      db.raw.exec(readMigration('0009_event_form_drafts.sql'));

      for (const table of [
        'event_form_drafts',
        'form_steps',
        'form_questions',
        'form_question_options',
      ]) {
        expect(tableNames(db.raw), table).toContain(table);
      }

      const counts = (table: string) =>
        (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      for (const table of ['attendees', 'admin_users', 'audit_logs', 'events', 'event_prizes']) {
        expect(counts(table), table).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it('the form tables declare their indexes and unique constraints', () => {
    const db = createTestDatabase();
    try {
      const questionIndexes = indexNames(db.raw, 'form_questions').join(' ');
      for (const expected of [
        'idx_form_questions_owner',
        'idx_form_questions_step',
        'idx_form_questions_active',
        'idx_form_questions_key',
        'idx_form_questions_position',
        'idx_form_questions_system_field',
      ]) {
        expect(questionIndexes, expected).toContain(expected);
      }
      expect(indexNames(db.raw, 'form_steps').join(' ')).toContain('idx_form_steps_position');
      expect(indexNames(db.raw, 'form_question_options').join(' ')).toContain(
        'idx_form_options_value',
      );
    } finally {
      db.close();
    }
  });

  it('one draft per event, and only ever for an event that exists', () => {
    const db = createTestDatabase();
    try {
      const now = `'2026-01-01T00:00:00.000Z'`;
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','u1','u1',${now},${now});
        INSERT INTO event_form_drafts (id, event_id, updated_by, created_at, updated_at)
        VALUES ('d1','e1','u1',${now},${now});
      `);

      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO event_form_drafts (id, event_id, updated_by, created_at, updated_at)
             VALUES ('d2','e1','u1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/UNIQUE/i);

      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO event_form_drafts (id, event_id, updated_by, created_at, updated_at)
             VALUES ('d3','ghost','u1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/i);

      // The event is protected by the draft it carries.
      expect(() => db.raw.prepare("DELETE FROM events WHERE id = 'e1'").run()).toThrow(
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });

  it('form_questions enforces its constraints', () => {
    const db = createTestDatabase();
    try {
      const now = `'2026-01-01T00:00:00.000Z'`;
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','u1','u1',${now},${now});
        INSERT INTO event_form_drafts (id, event_id, updated_by, created_at, updated_at)
        VALUES ('d1','e1','u1',${now},${now});
        INSERT INTO form_steps (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
        VALUES ('s1','DRAFT','d1','Step',0,${now},${now});
      `);

      const TS = `'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'`;
      const base =
        'id, form_owner_type, form_owner_id, step_id, key, type, label, sort_order, created_at, updated_at';
      const insert = (columns: string, values: string) =>
        db.raw.prepare(`INSERT INTO form_questions (${columns}) VALUES (${values})`).run();

      expect(() => insert(base, `'q1','DRAFT','d1','s1','name','SHORT_TEXT','Name',0,${TS}`)).not.toThrow();

      // A one-character key is legitimate; the pattern must not demand two.
      expect(() => insert(base, `'q2','DRAFT','d1','s1','a','SHORT_TEXT','A',1,${TS}`)).not.toThrow();

      expect(() => insert(base, `'q3','DRAFT','d1','s1','1bad','SHORT_TEXT','X',2,${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'q4','DRAFT','d1','s1','Has Space','SHORT_TEXT','X',3,${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'q5','DRAFT','d1','s1','MiXeD','SHORT_TEXT','X',4,${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'q6','GHOST','d1','s1','ok','SHORT_TEXT','X',5,${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'q7','DRAFT','d1','s1','ok2','SIGNATURE','X',6,${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'q8','DRAFT','d1','s1','ok3','SHORT_TEXT','   ',7,${TS}`)).toThrow(/CHECK/i);
      expect(() => insert(base, `'q9','DRAFT','d1','s1','ok4','SHORT_TEXT','X',-1,${TS}`)).toThrow(/CHECK/i);
      expect(() =>
        insert(`${base}, system_field`, `'q10','DRAFT','d1','s1','ok5','SHORT_TEXT','X',8,${TS},'SSN'`),
      ).toThrow(/CHECK/i);
      expect(() =>
        insert(`${base}, required`, `'q11','DRAFT','d1','s1','ok6','INFORMATION','Read',9,${TS},1`),
      ).toThrow(/CHECK/i);

      // A step that does not exist cannot hold a question.
      expect(() => insert(base, `'q12','DRAFT','d1','ghost','ok7','SHORT_TEXT','X',10,${TS}`)).toThrow(
        /FOREIGN KEY/i,
      );

      // Position is unique within a step; a key is unique within a form.
      expect(() => insert(base, `'q13','DRAFT','d1','s1','ok8','SHORT_TEXT','X',0,${TS}`)).toThrow(/UNIQUE/i);
      expect(() => insert(base, `'q14','DRAFT','d1','s1','name','SHORT_TEXT','X',11,${TS}`)).toThrow(/UNIQUE/i);

      // A system field may appear once; 'NONE' is exempt because it is the default.
      expect(() =>
        insert(`${base}, system_field`, `'q15','DRAFT','d1','s1','email','EMAIL','E',12,${TS},'EMAIL'`),
      ).not.toThrow();
      expect(() =>
        insert(`${base}, system_field`, `'q16','DRAFT','d1','s1','email2','EMAIL','E',13,${TS},'EMAIL'`),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('an option belongs to a question that must outlive it', () => {
    const db = createTestDatabase();
    try {
      const now = `'2026-01-01T00:00:00.000Z'`;
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','u1','u1',${now},${now});
        INSERT INTO event_form_drafts (id, event_id, updated_by, created_at, updated_at)
        VALUES ('d1','e1','u1',${now},${now});
        INSERT INTO form_steps (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
        VALUES ('s1','DRAFT','d1','Step',0,${now},${now});
        INSERT INTO form_questions (id, form_owner_type, form_owner_id, step_id, key, type, label, sort_order, created_at, updated_at)
        VALUES ('q1','DRAFT','d1','s1','pick','SINGLE_SELECT','Pick',0,${now},${now});
        INSERT INTO form_question_options (id, question_id, value, label, sort_order, created_at, updated_at)
        VALUES ('o1','q1','yes','Yes',0,${now},${now});
      `);

      const insert = (id: string, value: string, order: number) =>
        db.raw
          .prepare(
            `INSERT INTO form_question_options (id, question_id, value, label, sort_order, created_at, updated_at)
             VALUES (?, 'q1', ?, 'L', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(id, value, order);

      expect(() => insert('o2', 'yes', 1)).toThrow(/UNIQUE/i);
      expect(() => insert('o3', 'no', 0)).toThrow(/UNIQUE/i);
      expect(() => insert('o4', 'Yes', 2)).toThrow(/CHECK/i);
      expect(() => insert('o5', 'has space', 3)).toThrow(/CHECK/i);
      expect(() => insert('o6', 'yes-please', 4)).not.toThrow();

      // Deleting a question with options is refused; the options go first.
      expect(() => db.raw.prepare("DELETE FROM form_questions WHERE id = 'q1'").run()).toThrow(
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });

  it('0010 applies on top of a populated 0001-0009 schema', () => {
    const db = createTestDatabase({ through: '0009_event_form_drafts.sql' });
    try {
      const now = `'2026-01-01T00:00:00.000Z'`;
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','A@x.com','a@x.com','A','pbkdf2-sha256$1$c2E=$aGE=');
        INSERT INTO attendees (id, participant_number, first_name, last_name, email, phone)
        VALUES ('a1', 1, 'Ana', 'Lopez', 'ana@example.com', '555');
        INSERT INTO audit_logs (id, actor_admin_id, action, entity_type, request_id, created_at)
        VALUES ('l1','u1','ADMIN_LOGIN_SUCCEEDED','ADMIN_SESSION','r1',${now});
        INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','existing','Existing','UTC','u1','u1',${now},${now});
        INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
        VALUES ('p1','e1','A prize',1,0,'u1','u1',${now},${now});
        INSERT INTO event_form_drafts (id, event_id, updated_by, created_at, updated_at)
        VALUES ('d1','e1','u1',${now},${now});
        INSERT INTO form_steps (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
        VALUES ('s1','DRAFT','d1','Step',0,${now},${now});
      `);

      expect(tableNames(db.raw)).not.toContain('event_form_versions');
      db.raw.exec(readMigration('0010_event_form_versions.sql'));
      expect(tableNames(db.raw)).toContain('event_form_versions');

      const counts = (table: string) =>
        (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      for (const table of [
        'attendees',
        'admin_users',
        'audit_logs',
        'events',
        'event_prizes',
        'event_form_drafts',
        'form_steps',
      ]) {
        expect(counts(table), table).toBe(1);
      }

      // The new column lands on the existing row as NULL, not as a default.
      const pointer = db.raw
        .prepare('SELECT published_form_version_id FROM events WHERE id = ?')
        .get('e1') as { published_form_version_id: string | null };
      expect(pointer.published_form_version_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('event_form_versions declares its indexes and constraints', () => {
    const db = createTestDatabase();
    try {
      const indexes = indexNames(db.raw, 'event_form_versions').join(' ');
      for (const expected of [
        'idx_form_versions_event',
        'idx_form_versions_event_version',
        'idx_form_versions_published_at',
      ]) {
        expect(indexes, expected).toContain(expected);
      }
      expect(indexNames(db.raw, 'events').join(' ')).toContain(
        'idx_events_published_form_version',
      );

      const now = `'2026-01-01T00:00:00.000Z'`;
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','u1','u1',${now},${now});
        INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
        VALUES ('e2','ev2','Other','UTC','u1','u1',${now},${now});
      `);

      const TS = `'2026-01-01T00:00:00.000Z'`;
      // The source revision doubles as the row's distinguishing value now that
      // 0011 makes (event_id, source_draft_revision) unique too.
      const insert = (id: string, eventId: string, number: number, extra = '') =>
        db.raw
          .prepare(
            `INSERT INTO event_form_versions
               (id, event_id, version_number, source_draft_revision, published_by,
                published_at, schema_snapshot, created_at)
             VALUES (?, ?, ?, ?, 'u1', ${TS}, ${extra || `'{}'`}, ${TS})`,
          )
          .run(id, eventId, number, number);

      expect(() => insert('v1', 'e1', 1)).not.toThrow();

      // One version number per event; a different event may reuse it.
      expect(() => insert('v2', 'e1', 1)).toThrow(/UNIQUE/i);
      expect(() => insert('v3', 'e2', 1)).not.toThrow();

      expect(() => insert('v4', 'e1', 0)).toThrow(/CHECK/i);
      expect(() => insert('v5', 'ghost', 2)).toThrow(/FOREIGN KEY/i);
      expect(() => insert('', 'e1', 2)).toThrow(/CHECK/i);
      expect(() => insert('v6', 'e1', 2, `''`)).toThrow(/CHECK/i);

      // One version per draft revision, per event.
      expect(() => insert('v20', 'e1', 20)).not.toThrow();
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO event_form_versions
               (id, event_id, version_number, source_draft_revision, published_by,
                published_at, schema_snapshot, created_at)
             VALUES ('v21','e1',21,20,'u1',${TS},'{}',${TS})`,
          )
          .run(),
      ).toThrow(/UNIQUE/i);

      // A publisher who no longer exists cannot be forgotten either.
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO event_form_versions
               (id, event_id, version_number, source_draft_revision, published_by,
                published_at, schema_snapshot, created_at)
             VALUES ('v7','e1',3,30,'ghost',${TS},'{}',${TS})`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/i);

      // Pointing at a version protects both it and its event.
      db.raw.prepare("UPDATE events SET published_form_version_id = 'v1' WHERE id = 'e1'").run();
      expect(() =>
        db.raw.prepare("DELETE FROM event_form_versions WHERE id = 'v1'").run(),
      ).toThrow(/FOREIGN KEY/i);
      expect(() => db.raw.prepare("DELETE FROM events WHERE id = 'e1'").run()).toThrow(
        /FOREIGN KEY/i,
      );
      expect(() => db.raw.prepare("DELETE FROM admin_users WHERE id = 'u1'").run()).toThrow(
        /FOREIGN KEY/i,
      );

      // A pointer to a version of ANOTHER event is not something SQLite can
      // refuse — see the migration's comment. The service owns that rule.
      expect(() =>
        db.raw.prepare("UPDATE events SET published_form_version_id = 'v3' WHERE id = 'e1'").run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('VERSION rows live in the same tables as DRAFT rows', () => {
    const db = createTestDatabase();
    try {
      const now = `'2026-01-01T00:00:00.000Z'`;
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','u1','u1',${now},${now});
        INSERT INTO event_form_versions
          (id, event_id, version_number, source_draft_revision, published_by,
           published_at, schema_snapshot, created_at)
        VALUES ('v1','e1',1,1,'u1',${now},'{}',${now});
        INSERT INTO form_steps (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
        VALUES ('vs1','VERSION','v1','Frozen',0,${now},${now});
        INSERT INTO form_questions
          (id, form_owner_type, form_owner_id, step_id, key, type, label, sort_order, created_at, updated_at)
        VALUES ('vq1','VERSION','v1','vs1','email','EMAIL','Email',0,${now},${now});
      `);

      const owners = db.raw
        .prepare('SELECT DISTINCT form_owner_type AS t FROM form_steps')
        .all() as Array<{ t: string }>;
      expect(owners.map((row) => row.t)).toEqual(['VERSION']);

      // A DRAFT and a VERSION may hold the same answer key: they are separate
      // forms, and the key is unique per owner rather than globally.
      db.raw.exec(`
        INSERT INTO event_form_drafts (id, event_id, updated_by, created_at, updated_at)
        VALUES ('d1','e1','u1',${now},${now});
        INSERT INTO form_steps (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
        VALUES ('ds1','DRAFT','d1','Draft step',0,${now},${now});
      `);
      expect(() =>
        db.raw
          .prepare(
            `INSERT INTO form_questions
               (id, form_owner_type, form_owner_id, step_id, key, type, label, sort_order, created_at, updated_at)
             VALUES ('dq1','DRAFT','d1','ds1','email','EMAIL','Email',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('every migration file is replayable in isolation order', () => {
    // Guards against a migration being added out of order or with a name that
    // sorts before an earlier one.
    const files = migrationFiles();
    expect(files[0]).toBe('0001_init.sql');
    expect(files.at(-1)).toBe('0017_results_and_archiving.sql');

    const fresh = new DatabaseSync(':memory:');
    try {
      fresh.exec('PRAGMA foreign_keys = OFF;');
      for (const file of files) {
        expect(() => fresh.exec(readMigration(file))).not.toThrow();
      }
    } finally {
      fresh.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('0014 — public submission idempotency', () => {
  const NOW = `'2026-01-01T00:00:00.000Z'`;

  /** An event, a version, a participant — everything an entry needs. */
  function seeded() {
    const db = createTestDatabase();
    db.raw.exec(`
      INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
      VALUES ('u1','a@x.com','a@x.com','A','h');
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e1','ev','Event','UTC','OPEN','u1','u1',${NOW},${NOW});
      INSERT INTO event_form_versions (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
      VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('p1','a@b.com','a@b.com','Ana','Lopez',${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('p2','c@d.com','c@d.com','Bea','Ruiz',${NOW},${NOW});
    `);
    return db;
  }

  const insertEntry = (
    id: string,
    participantId: string,
    submissionId: string | null,
  ) =>
    `INSERT INTO event_entries
       (id, event_id, participant_id, form_version_id, status, submission_id, submitted_at, created_at, updated_at)
     VALUES ('${id}','e1','${participantId}','v1','SUBMITTED',${
       submissionId === null ? 'NULL' : `'${submissionId}'`
     },${NOW},${NOW},${NOW})`;

  it('adds the column and the partial unique index', () => {
    const db = seeded();
    try {
      const columns = (
        db.raw.prepare('PRAGMA table_info(event_entries)').all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(columns).toContain('submission_id');
      expect(indexNames(db.raw, 'event_entries')).toContain('ux_event_entries_submission_id');
    } finally {
      db.close();
    }
  });

  it('refuses a duplicate key', () => {
    const db = seeded();
    try {
      db.raw.exec(insertEntry('en1', 'p1', 'sub-1'));
      expect(() => db.raw.exec(insertEntry('en2', 'p2', 'sub-1'))).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('allows many entries with no key at all', () => {
    // Administrative entries and every row predating this migration carry NULL.
    // A non-partial index would make the second one collide.
    const db = seeded();
    try {
      db.raw.exec(insertEntry('en1', 'p1', null));
      expect(() => db.raw.exec(insertEntry('en2', 'p2', null))).not.toThrow();
      const row = db.raw
        .prepare('SELECT COUNT(*) AS n FROM event_entries WHERE submission_id IS NULL')
        .get() as { n: number };
      expect(row.n).toBe(2);
    } finally {
      db.close();
    }
  });

  it('preserves historical entries when upgrading a populated database', () => {
    // Applied through 0013 first, with rows in place, then 0014 on top.
    const db = createTestDatabase({ through: '0013_eligibility_constraints.sql' });
    try {
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','OPEN','u1','u1',${NOW},${NOW});
        INSERT INTO event_form_versions (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
        VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
        INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
        VALUES ('p1','a@b.com','a@b.com','Ana','Lopez',${NOW},${NOW});
        INSERT INTO event_entries (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
        VALUES ('old','e1','p1','v1','SUBMITTED',${NOW},${NOW},${NOW});
      `);

      db.raw.exec(readMigration('0014_public_submission.sql'));

      const row = db.raw
        .prepare("SELECT id, submission_id FROM event_entries WHERE id = 'old'")
        .get() as { id: string; submission_id: string | null };
      expect(row.id).toBe('old');
      expect(row.submission_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('refuses to rewrite a key once it is set', () => {
    // An entry may be re-judged; its idempotency handle may never move.
    const db = seeded();
    try {
      db.raw.exec(insertEntry('en1', 'p1', 'sub-1'));
      expect(() =>
        db.raw.exec("UPDATE event_entries SET submission_id = 'sub-2' WHERE id = 'en1'"),
      ).toThrow(/submission_id cannot be changed/);
    } finally {
      db.close();
    }
  });

  it('refuses to write a key onto a historical row', () => {
    // `IS NOT` rather than `<>`: `NULL <> 'x'` is NULL, not true, so a `<>`
    // trigger would silently permit exactly this.
    const db = seeded();
    try {
      db.raw.exec(insertEntry('en1', 'p1', null));
      expect(() =>
        db.raw.exec("UPDATE event_entries SET submission_id = 'sub-1' WHERE id = 'en1'"),
      ).toThrow(/submission_id cannot be changed/);
    } finally {
      db.close();
    }
  });

  it('still allows an entry to be re-judged', () => {
    const db = seeded();
    try {
      db.raw.exec(insertEntry('en1', 'p1', 'sub-1'));
      expect(() =>
        db.raw.exec(
          `UPDATE event_entries
             SET status = 'INELIGIBLE', overall_eligible = 0, eligibility_reason = 'AGE_REQUIREMENT_NOT_MET'
           WHERE id = 'en1'`,
        ),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('0012 — participants, entries and answers', () => {
  const NOW = `'2026-01-01T00:00:00.000Z'`;

  /** A schema with an event, a published version and one VERSION question. */
  function seeded() {
    const db = createTestDatabase();
    db.raw.exec(`
      INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
      VALUES ('u1','a@x.com','a@x.com','A','h');
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e1','ev','Event','UTC','OPEN','u1','u1',${NOW},${NOW});
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e2','ev2','Other','UTC','OPEN','u1','u1',${NOW},${NOW});
      INSERT INTO event_form_versions
        (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
      VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
      INSERT INTO form_steps (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
      VALUES ('s1','VERSION','v1','Step',0,${NOW},${NOW});
      INSERT INTO form_questions
        (id, form_owner_type, form_owner_id, step_id, key, system_field, type, label, sort_order, created_at, updated_at)
      VALUES ('q1','VERSION','v1','s1','email','EMAIL','EMAIL','Email',0,${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
      INSERT INTO event_entries
        (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
      VALUES ('en1','e1','pa1','v1','SUBMITTED',${NOW},${NOW},${NOW});
    `);
    return db;
  }

  it('applies on top of a populated 0001-0011 schema without disturbing it', () => {
    const db = createTestDatabase({ through: '0011_form_version_source_revision.sql' });
    try {
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','A@x.com','a@x.com','A','pbkdf2-sha256$1$c2E=$aGE=');
        INSERT INTO attendees (id, participant_number, first_name, last_name, email, phone)
        VALUES ('a1', 1, 'Ana', 'Lopez', 'ana@example.com', '555');
        INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','existing','Existing','UTC','u1','u1',${NOW},${NOW});
        INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
        VALUES ('p1','e1','A prize',1,0,'u1','u1',${NOW},${NOW});
        INSERT INTO event_form_drafts (id, event_id, updated_by, created_at, updated_at)
        VALUES ('d1','e1','u1',${NOW},${NOW});
        INSERT INTO event_form_versions
          (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
        VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
      `);

      for (const table of ['participants', 'event_entries', 'event_entry_answers']) {
        expect(tableNames(db.raw), table).not.toContain(table);
      }
      db.raw.exec(readMigration('0012_participants_and_entries.sql'));
      for (const table of ['participants', 'event_entries', 'event_entry_answers']) {
        expect(tableNames(db.raw), table).toContain(table);
      }

      const counts = (table: string) =>
        (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      for (const table of [
        'attendees',
        'admin_users',
        'events',
        'event_prizes',
        'event_form_drafts',
        'event_form_versions',
      ]) {
        expect(counts(table), table).toBe(1);
      }
      // The legacy lead-capture table is a different thing and is untouched.
      expect(counts('participants')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('declares its indexes', () => {
    const db = createTestDatabase();
    try {
      expect(indexNames(db.raw, 'participants').join(' ')).toContain(
        'idx_participants_normalized_email',
      );
      const entryIndexes = indexNames(db.raw, 'event_entries').join(' ');
      for (const expected of [
        'idx_event_entries_event_participant',
        'idx_event_entries_event',
        'idx_event_entries_participant',
        'idx_event_entries_version',
      ]) {
        expect(entryIndexes, expected).toContain(expected);
      }
      expect(indexNames(db.raw, 'event_entry_answers').join(' ')).toContain(
        'idx_entry_answers_entry_question',
      );
    } finally {
      db.close();
    }
  });

  it('refuses a malformed participant', () => {
    const db = seeded();
    try {
      const insert = (columns: string, values: string) =>
        db.raw.exec(`INSERT INTO participants (${columns}) VALUES (${values})`);

      const base = 'id, email, normalized_email, first_name, last_name, created_at, updated_at';
      // An empty email is a silent trapdoor: an identity nobody can ever reach.
      expect(() => insert(base, `'x','','a@b.com','A','B',${NOW},${NOW}`)).toThrow();
      expect(() => insert(base, `'x','a@b.com','','A','B',${NOW},${NOW}`)).toThrow();
      // Whitespace-only names would produce a participant with no name at all.
      expect(() => insert(base, `'x','a@b.com','a@b.com','   ','B',${NOW},${NOW}`)).toThrow();
      expect(() => insert(base, `'x','a@b.com','a@b.com','A','',${NOW},${NOW}`)).toThrow();
      // The canonical column must actually be canonical.
      expect(() => insert(base, `'x','A@B.com','A@B.com','A','B',${NOW},${NOW}`)).toThrow();
      expect(() => insert(base, `'x','a@b.com','a b@c.com','A','B',${NOW},${NOW}`)).toThrow();
      // A naive timestamp sorts inconsistently against every ISO one.
      expect(() =>
        insert(base, `'x','a@b.com','a@b.com','A','B','2026-01-01 00:00:00',${NOW}`),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses a date of birth that is not a civil date', () => {
    const db = seeded();
    try {
      const insert = (dob: string) =>
        db.raw.exec(
          `INSERT INTO participants
             (id, email, normalized_email, first_name, last_name, date_of_birth, created_at, updated_at)
           VALUES ('x','a@b.com','a@b.com','A','B',${dob},${NOW},${NOW})`,
        );

      expect(() => insert(`'1990-1-1'`)).toThrow();
      expect(() => insert(`'1990/01/01'`)).toThrow();
      expect(() => insert(`'1990-01-01T00:00:00.000Z'`)).toThrow();
      // A real day is accepted, and so is no answer at all.
      expect(() => insert(`'1990-01-01'`)).not.toThrow();
      expect(() =>
        db.raw.exec(
          `INSERT INTO participants
             (id, email, normalized_email, first_name, last_name, created_at, updated_at)
           VALUES ('y','b@b.com','b@b.com','A','B',${NOW},${NOW})`,
        ),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('one identity per email address', () => {
    const db = seeded();
    try {
      expect(() =>
        db.raw.exec(
          `INSERT INTO participants
             (id, email, normalized_email, first_name, last_name, created_at, updated_at)
           VALUES ('pa2','Ana@X.com','a@x.com','Ana','Other',${NOW},${NOW})`,
        ),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('an entry needs a real event, participant and version', () => {
    const db = seeded();
    try {
      const insert = (id: string, eventId: string, participantId: string, versionId: string) =>
        db.raw.exec(
          `INSERT INTO event_entries
             (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
           VALUES ('${id}','${eventId}','${participantId}','${versionId}','SUBMITTED',${NOW},${NOW},${NOW})`,
        );

      // Posted against e2 so the unique index on (event_id, participant_id)
      // cannot fire first and mask the foreign key being tested.
      expect(() => insert('x', 'missing', 'pa1', 'v1')).toThrow(/FOREIGN KEY/i);
      expect(() => insert('x', 'e2', 'missing', 'v1')).toThrow(/FOREIGN KEY/i);
      expect(() => insert('x', 'e2', 'pa1', 'missing')).toThrow(/FOREIGN KEY/i);

      // A version belonging to ANOTHER event is accepted by SQLite — no
      // composite foreign key can express the rule — which is exactly why the
      // service resolves it instead of trusting it.
      expect(() => insert('x', 'e2', 'pa1', 'v1')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('one entry per identity per event, and no more', () => {
    const db = seeded();
    try {
      expect(() =>
        db.raw.exec(
          `INSERT INTO event_entries
             (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
           VALUES ('en2','e1','pa1','v1','SUBMITTED',${NOW},${NOW},${NOW})`,
        ),
      ).toThrow(/UNIQUE/i);

      // The same identity in a DIFFERENT event is the whole point of separating
      // identity from participation.
      db.raw.exec(`
        INSERT INTO event_form_versions
          (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
        VALUES ('v2','e2',1,1,'u1',${NOW},'{}',${NOW});
      `);
      expect(() =>
        db.raw.exec(
          `INSERT INTO event_entries
             (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
           VALUES ('en2','e2','pa1','v2','SUBMITTED',${NOW},${NOW},${NOW})`,
        ),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses an impossible entry state', () => {
    const db = seeded();
    try {
      const insert = (column: string, value: string) =>
        db.raw.exec(
          `INSERT INTO event_entries
             (id, event_id, participant_id, form_version_id, status, ${column}, submitted_at, created_at, updated_at)
           VALUES ('x','e2','pa1','v1','SUBMITTED',${value},${NOW},${NOW},${NOW})`,
        );

      // A status the state machine does not model, including the draw outcomes
      // this phase deliberately does not introduce.
      expect(() =>
        db.raw.exec(
          `INSERT INTO event_entries
             (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
           VALUES ('x','e2','pa1','v1','WINNER',${NOW},${NOW},${NOW})`,
        ),
      ).toThrow();

      expect(() => insert('calculated_age', '-1')).toThrow();
      expect(() => insert('calculated_age', '200')).toThrow();
      expect(() => insert('age_eligible', '2')).toThrow();
      expect(() => insert('overall_eligible', `'yes'`)).toThrow();
      // The eligibility columns are legitimately absent until the next phase.
      expect(() => insert('calculated_age', 'NULL')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('an event or a version with entries cannot be deleted', () => {
    const db = seeded();
    try {
      expect(() => db.raw.exec(`DELETE FROM events WHERE id = 'e1'`)).toThrow(/FOREIGN KEY/i);
      expect(() => db.raw.exec(`DELETE FROM participants WHERE id = 'pa1'`)).toThrow(
        /FOREIGN KEY/i,
      );
      expect(() => db.raw.exec(`DELETE FROM event_form_versions WHERE id = 'v1'`)).toThrow(
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });

  it('an answer needs a real entry and a real question', () => {
    const db = seeded();
    try {
      const insert = (id: string, entryId: string, questionId: string) =>
        db.raw.exec(
          `INSERT INTO event_entry_answers
             (id, event_entry_id, question_id, question_key, question_label_snapshot,
              answer_type, answer_value, created_at)
           VALUES ('${id}','${entryId}','${questionId}','email','Email','EMAIL','"a@b.com"',${NOW})`,
        );

      expect(() => insert('x', 'missing', 'q1')).toThrow(/FOREIGN KEY/i);
      expect(() => insert('x', 'en1', 'missing')).toThrow(/FOREIGN KEY/i);
      expect(() => insert('an1', 'en1', 'q1')).not.toThrow();

      // A question answers once per entry. Two rows would make "what did they
      // say?" a question with two answers.
      expect(() => insert('an2', 'en1', 'q1')).toThrow(/UNIQUE/i);

      // And an answered entry cannot be deleted out from under its answers.
      expect(() => db.raw.exec(`DELETE FROM event_entries WHERE id = 'en1'`)).toThrow(
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });

  it('refuses a malformed answer row', () => {
    const db = seeded();
    try {
      const insert = (
        key: string,
        label: string,
        type: string,
        value: string,
        at: string = NOW,
      ) =>
        db.raw.exec(
          `INSERT INTO event_entry_answers
             (id, event_entry_id, question_id, question_key, question_label_snapshot,
              answer_type, answer_value, created_at)
           VALUES ('x','en1','q1',${key},${label},${type},${value},${at})`,
        );

      expect(() => insert(`''`, `'Email'`, `'EMAIL'`, `'"a"'`)).toThrow();
      // The key must be the same snake_case shape a question key has.
      expect(() => insert(`'Email'`, `'Email'`, `'EMAIL'`, `'"a"'`)).toThrow();
      expect(() => insert(`'1email'`, `'Email'`, `'EMAIL'`, `'"a"'`)).toThrow();
      expect(() => insert(`'e mail'`, `'Email'`, `'EMAIL'`, `'"a"'`)).toThrow();
      expect(() => insert(`'email'`, `'   '`, `'EMAIL'`, `'"a"'`)).toThrow();
      // A type the domain does not have, and the one type that cannot be
      // answered at all.
      expect(() => insert(`'email'`, `'Email'`, `'NONSENSE'`, `'"a"'`)).toThrow();
      expect(() => insert(`'email'`, `'Email'`, `'INFORMATION'`, `'"a"'`)).toThrow();
      expect(() => insert(`'email'`, `'Email'`, `'EMAIL'`, `'"a"'`, `'2026-01-01'`)).toThrow();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('0013 — eligibility invariants', () => {
  const NOW = `'2026-01-01T00:00:00.000Z'`;

  function seeded() {
    const db = createTestDatabase();
    db.raw.exec(`
      INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
      VALUES ('u1','a@x.com','a@x.com','A','h');
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e1','ev','Event','UTC','OPEN','u1','u1',${NOW},${NOW});
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e2','ev2','Other','UTC','OPEN','u1','u1',${NOW},${NOW});
      INSERT INTO event_form_versions
        (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
      VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa2','B@x.com','b@x.com','Bob','Smith',${NOW},${NOW});
    `);
    return db;
  }

  const DECISION_COLUMNS =
    'status, calculated_age, age_eligible, overall_eligible, eligibility_reason';

  function insert(db: TestDatabase, values: string, id = 'en1') {
    db.raw.exec(
      `INSERT INTO event_entries
         (id, event_id, participant_id, form_version_id, submitted_at, created_at, updated_at,
          ${DECISION_COLUMNS})
       VALUES ('${id}','e1','pa1','v1',${NOW},${NOW},${NOW}, ${values})`,
    );
  }

  it('applies on top of a populated schema without touching what is there', () => {
    const db = createTestDatabase({ through: '0012_participants_and_entries.sql' });
    try {
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','u1','u1',${NOW},${NOW});
        INSERT INTO event_form_versions
          (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
        VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
        INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
        VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
        INSERT INTO event_entries
          (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
        VALUES ('old','e1','pa1','v1','SUBMITTED',${NOW},${NOW},${NOW});
      `);

      db.raw.exec(readMigration('0013_eligibility_constraints.sql'));

      // A phase 7 row: recorded before eligibility existed, never judged, and
      // left exactly as it was. Rewriting it would invent a decision nobody
      // took about somebody nobody assessed.
      const row = db.raw
        .prepare('SELECT status, overall_eligible AS o FROM event_entries WHERE id = ?')
        .get('old') as { status: string; o: number | null };
      expect(row.status).toBe('SUBMITTED');
      expect(row.o).toBeNull();
    } finally {
      db.close();
    }
  });

  it('accepts a coherent decision, in both directions', () => {
    const db = seeded();
    try {
      expect(() => insert(db, `'ELIGIBLE', 21, 1, 1, 'ELIGIBLE'`)).not.toThrow();
      db.raw.exec("DELETE FROM event_entries WHERE id = 'en1'");
      expect(() =>
        insert(db, `'INELIGIBLE', 20, 0, 0, 'AGE_REQUIREMENT_NOT_MET'`),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('accepts an event with no age rule, where nothing was judged', () => {
    const db = seeded();
    try {
      expect(() => insert(db, `'ELIGIBLE', 30, NULL, 1, 'ELIGIBLE'`)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses a verdict that contradicts itself', () => {
    const db = seeded();
    try {
      // Says eligible, is not.
      expect(() => insert(db, `'ELIGIBLE', 21, 1, 0, 'ELIGIBLE'`)).toThrow(/incoherent/);
      // Says ineligible, is not.
      expect(() =>
        insert(db, `'INELIGIBLE', 20, 0, 1, 'AGE_REQUIREMENT_NOT_MET'`),
      ).toThrow(/incoherent/);
      // Excluded without saying why.
      expect(() => insert(db, `'INELIGIBLE', 20, 0, 0, NULL`)).toThrow(/incoherent/);
      // Judged an age it never recorded.
      expect(() => insert(db, `'ELIGIBLE', NULL, 1, 1, 'ELIGIBLE'`)).toThrow(/incoherent/);
      // Decided, but carrying no verdict at all.
      expect(() => insert(db, `'ELIGIBLE', 21, 1, NULL, 'ELIGIBLE'`)).toThrow(/incoherent/);
    } finally {
      db.close();
    }
  });

  it('an entry may be re-judged but never re-homed', () => {
    const db = seeded();
    try {
      insert(db, `'ELIGIBLE', 21, 1, 1, 'ELIGIBLE'`);

      // Re-judging is legitimate: a later phase corrects a decision.
      expect(() =>
        db.raw.exec(
          `UPDATE event_entries
              SET status = 'INELIGIBLE', overall_eligible = 0,
                  eligibility_reason = 'DISQUALIFIED_BY_RULE'
            WHERE id = 'en1'`,
        ),
      ).not.toThrow();

      // Moving it is not. The event, the identity and the version are what make
      // its answers mean anything.
      for (const [column, value] of [
        ['event_id', "'e2'"],
        ['participant_id', "'pa2'"],
        ['submitted_at', "'2020-01-01T00:00:00.000Z'"],
      ] as const) {
        expect(
          () => db.raw.exec(`UPDATE event_entries SET ${column} = ${value} WHERE id = 'en1'`),
          column,
        ).toThrow(/re-homed/);
      }
    } finally {
      db.close();
    }
  });

  it('an update cannot produce a state the insert would have refused', () => {
    const db = seeded();
    try {
      insert(db, `'ELIGIBLE', 21, 1, 1, 'ELIGIBLE'`);
      expect(() =>
        db.raw.exec("UPDATE event_entries SET overall_eligible = 0 WHERE id = 'en1'"),
      ).toThrow(/incoherent/);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('0013 — the edges the triggers must get right', () => {
  const NOW = `'2026-01-01T00:00:00.000Z'`;

  function seeded() {
    const db = createTestDatabase();
    db.raw.exec(`
      INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
      VALUES ('u1','a@x.com','a@x.com','A','h');
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e1','ev','Event','UTC','OPEN','u1','u1',${NOW},${NOW});
      INSERT INTO event_form_versions
        (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
      VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa2','B@x.com','b@x.com','Bea','Ruiz',${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa3','C@x.com','c@x.com','Cleo','Diaz',${NOW},${NOW});
    `);
    return db;
  }

  /**
   * One entry per identity per event is a phase 7 constraint that still holds,
   * so each attempt uses its own participant rather than fighting it.
   */
  let nextParticipant = 0;
  const PARTICIPANTS = ['pa1', 'pa2', 'pa3'];

  function attempt(db: TestDatabase, values: string, id = 'x1') {
    const participant = PARTICIPANTS[nextParticipant % PARTICIPANTS.length];
    nextParticipant += 1;
    db.raw.exec(
      `INSERT INTO event_entries
         (id, event_id, participant_id, form_version_id, submitted_at, created_at, updated_at,
          status, calculated_age, age_eligible, overall_eligible, eligibility_reason)
       VALUES ('${id}','e1','${participant}','v1',${NOW},${NOW},${NOW}, ${values})`,
    );
  }

  beforeEach(() => {
    nextParticipant = 0;
  });

  it('accepts age 0 and age 130, judged either way', () => {
    const db = seeded();
    try {
      expect(() => attempt(db, `'ELIGIBLE', 0, 1, 1, 'ELIGIBLE'`, 'a')).not.toThrow();
      expect(() => attempt(db, `'ELIGIBLE', 130, 1, 1, 'ELIGIBLE'`, 'b')).not.toThrow();
      expect(() =>
        attempt(db, `'INELIGIBLE', 0, 0, 0, 'AGE_REQUIREMENT_NOT_MET'`, 'c'),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('leaves 131 to the column CHECK, which refuses it', () => {
    const db = seeded();
    try {
      // The plausibility ceiling belongs to the column, not the trigger: a
      // trigger that also enforced it would duplicate a rule that can drift.
      expect(() => attempt(db, `'ELIGIBLE', 131, 1, 1, 'ELIGIBLE'`)).toThrow(/CHECK/i);
      expect(() => attempt(db, `'ELIGIBLE', -1, 1, 1, 'ELIGIBLE'`)).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('accepts a decision where no age rule applied', () => {
    const db = seeded();
    try {
      // `age_eligible` NULL with an age recorded, and with none at all.
      expect(() => attempt(db, `'ELIGIBLE', 30, NULL, 1, 'ELIGIBLE'`, 'a')).not.toThrow();
      expect(() => attempt(db, `'ELIGIBLE', NULL, NULL, 1, 'ELIGIBLE'`, 'b')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('accepts DISQUALIFIED, which phase 10 writes', () => {
    // 0013's eligibility triggers have never objected to this status, and still
    // do not. What CHANGED in 0015 is that a disqualified row must now also
    // carry its administrative disposition — who removed the entry, when, why,
    // and what status to return it to — so the insert below supplies them.
    // Without that, 0015's coherence trigger refuses the row, which is the
    // whole point of it: a disqualification nobody can explain or undo is not a
    // decision.
    const db = seeded();
    try {
      const NOW = `'2026-01-01T00:00:00.000Z'`;
      expect(() =>
        db.raw.exec(
          `INSERT INTO event_entries
             (id, event_id, participant_id, form_version_id, status,
              calculated_age, age_eligible, overall_eligible, eligibility_reason,
              disqualified_at, disqualified_by_admin_id, disqualification_reason,
              pre_disqualification_status,
              submitted_at, created_at, updated_at)
           VALUES ('x1','e1','pa1','v1','DISQUALIFIED',
                   30, NULL, 0, 'DISQUALIFIED_BY_RULE',
                   ${NOW}, 'u1', 'Entered twice', 'ELIGIBLE',
                   ${NOW}, ${NOW}, ${NOW})`,
        ),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('does not block a historical SUBMITTED row, in either direction', () => {
    const db = seeded();
    try {
      // Written before eligibility existed: no verdict at all. The triggers must
      // let it in and let it stay, or restoring a backup would fail.
      expect(() => attempt(db, `'SUBMITTED', NULL, NULL, NULL, NULL`)).not.toThrow();
      // And touching an unrelated column on it is still allowed.
      expect(() =>
        db.raw.exec(`UPDATE event_entries SET user_agent = 'x' WHERE id = 'x1'`),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('the NULL comparisons in the trigger behave, rather than silently passing', () => {
    const db = seeded();
    try {
      // In SQL, `NULL <> 1` is NULL — falsy — so a trigger written naively
      // would let a decided row through carrying no verdict at all.
      expect(() => attempt(db, `'ELIGIBLE', 21, 1, NULL, 'ELIGIBLE'`, 'a')).toThrow(
        /incoherent/,
      );
      expect(() => attempt(db, `'INELIGIBLE', 21, 0, NULL, 'AGE_REQUIREMENT_NOT_MET'`, 'b')).toThrow(
        /incoherent/,
      );
    } finally {
      db.close();
    }
  });

  it('the migration fails loudly if a trigger cannot be created', () => {
    // Applying it twice is the closest reproducible stand-in for "the engine
    // refused it": the point is that a failure is an error, never a no-op.
    const db = createTestDatabase();
    try {
      expect(() => db.raw.exec(readMigration('0013_eligibility_constraints.sql'))).toThrow(
        /already exists/i,
      );
    } finally {
      db.close();
    }
  });

  it('declares exactly the triggers it claims to', () => {
    const db = createTestDatabase();
    try {
      const triggers = (
        db.raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(triggers).toEqual(
        expect.arrayContaining([
          'trg_event_entries_decision_insert',
          'trg_event_entries_decision_update',
          'trg_event_entries_immutable_identity',
        ]),
      );
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('0016 — the draw', () => {
  const NOW = `'2026-01-01T00:00:00.000Z'`;

  /** An event at DRAW_READY, with a prize and two entries. */
  function seeded() {
    const db = createTestDatabase();
    db.raw.exec(`
      INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
      VALUES ('u1','a@x.com','a@x.com','A','h');
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e1','ev','Event','UTC','DRAW_READY','u1','u1',${NOW},${NOW});
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e2','ev2','Other','UTC','DRAW_READY','u1','u1',${NOW},${NOW});
      INSERT INTO event_form_versions
        (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
      VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
      INSERT INTO event_prizes
        (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
      VALUES ('pz1','e1','Vape',2,0,'u1','u1',${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa2','B@x.com','b@x.com','Bea','Ruiz',${NOW},${NOW});
      INSERT INTO event_entries
        (id, event_id, participant_id, form_version_id, status, overall_eligible,
         submitted_at, created_at, updated_at)
      VALUES ('en1','e1','pa1','v1','ELIGIBLE',1,${NOW},${NOW},${NOW});
      INSERT INTO event_entries
        (id, event_id, participant_id, form_version_id, status, overall_eligible,
         submitted_at, created_at, updated_at)
      VALUES ('en2','e1','pa2','v1','ELIGIBLE',1,${NOW},${NOW},${NOW});
    `);
    return db;
  }

  const drawRow = (id: string, eventId: string, counts = '1, 2, 1') =>
    `INSERT INTO draws
       (id, event_id, completed_at, executed_by_admin_id, candidate_count,
        prize_unit_count, assignment_count, algorithm_version, candidate_set_hash,
        candidate_population_revision, created_at)
     VALUES ('${id}','${eventId}',${NOW},'u1', ${counts},
             'CRYPTO_FISHER_YATES_V1','abc',0,${NOW})`;

  const assignment = (id: string, entryId: string, unitIndex = 1) =>
    `INSERT INTO draw_assignments
       (id, draw_id, event_id, prize_id, entry_id, prize_unit_index, draw_order,
        prize_name_snapshot, assigned_at)
     VALUES ('${id}','d1','e1','pz1','${entryId}',${unitIndex},0,'Vape',${NOW})`;

  it('adds the population counter, defaulting to zero', () => {
    const db = seeded();
    try {
      const row = db.raw
        .prepare('SELECT participant_population_revision AS r FROM events WHERE id = ?')
        .get('e1') as { r: number };
      expect(row.r).toBe(0);
    } finally {
      db.close();
    }
  });

  it('accepts a coherent draw', () => {
    const db = seeded();
    try {
      expect(() => db.raw.exec(drawRow('d1', 'e1'))).not.toThrow();
      expect(() => db.raw.exec(assignment('a1', 'en1'))).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses a SECOND draw for the same event', () => {
    const db = seeded();
    try {
      db.raw.exec(drawRow('d1', 'e1'));
      // The no-reroll guarantee. Not a service check that could be forgotten:
      // a constraint a second attempt cannot get past.
      expect(() => db.raw.exec(drawRow('d2', 'e1'))).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('allows a different event its own draw', () => {
    const db = seeded();
    try {
      db.raw.exec(drawRow('d1', 'e1'));
      expect(() => db.raw.exec(drawRow('d2', 'e2'))).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses one winner taking two prizes in one draw', () => {
    const db = seeded();
    try {
      db.raw.exec(drawRow('d1', 'e1'));
      db.raw.exec(assignment('a1', 'en1', 1));
      // This is what stops one person walking off with everything.
      expect(() => db.raw.exec(assignment('a2', 'en1', 2))).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('refuses one prize unit having two winners', () => {
    const db = seeded();
    try {
      db.raw.exec(drawRow('d1', 'e1'));
      db.raw.exec(assignment('a1', 'en1', 1));
      // Two rows for one physical thing would mean two people were both told
      // they had won it.
      expect(() => db.raw.exec(assignment('a2', 'en2', 1))).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('allows the units of a multi-quantity prize to go to different people', () => {
    const db = seeded();
    try {
      db.raw.exec(drawRow('d1', 'e1'));
      db.raw.exec(assignment('a1', 'en1', 1));
      expect(() => db.raw.exec(assignment('a2', 'en2', 2))).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses counts that describe an impossible draw', () => {
    const db = seeded();
    try {
      // More winners than candidates.
      expect(() => db.raw.exec(drawRow('d1', 'e1', '1, 5, 3'))).toThrow(/CHECK/i);
      // More winners than prize units.
      expect(() => db.raw.exec(drawRow('d2', 'e1', '5, 1, 3'))).toThrow(/CHECK/i);
      // A draw with nothing in it at all.
      expect(() => db.raw.exec(drawRow('d3', 'e1', '0, 0, 0'))).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('refuses a draw with no algorithm or no candidate hash', () => {
    const db = seeded();
    try {
      expect(() =>
        db.raw.exec(
          `INSERT INTO draws (id, event_id, completed_at, candidate_count,
             prize_unit_count, assignment_count, algorithm_version,
             candidate_set_hash, candidate_population_revision, created_at)
           VALUES ('d1','e1',${NOW},1,1,1,'','abc',0,${NOW})`,
        ),
      ).toThrow(/CHECK/i);
      expect(() =>
        db.raw.exec(
          `INSERT INTO draws (id, event_id, completed_at, candidate_count,
             prize_unit_count, assignment_count, algorithm_version,
             candidate_set_hash, candidate_population_revision, created_at)
           VALUES ('d2','e1',${NOW},1,1,1,'V1','',0,${NOW})`,
        ),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('refuses a non-canonical timestamp', () => {
    const db = seeded();
    try {
      expect(() =>
        db.raw.exec(
          `INSERT INTO draws (id, event_id, completed_at, candidate_count,
             prize_unit_count, assignment_count, algorithm_version,
             candidate_set_hash, candidate_population_revision, created_at)
           VALUES ('d1','e1','2026-01-01 00:00:00',1,1,1,'V1','abc',0,${NOW})`,
        ),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('refuses a blank prize name snapshot', () => {
    const db = seeded();
    try {
      db.raw.exec(drawRow('d1', 'e1'));
      expect(() =>
        db.raw.exec(
          `INSERT INTO draw_assignments
             (id, draw_id, event_id, prize_id, entry_id, prize_unit_index,
              draw_order, prize_name_snapshot, assigned_at)
           VALUES ('a1','d1','e1','pz1','en1',1,0,'   ',${NOW})`,
        ),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('refuses a unit index below 1', () => {
    const db = seeded();
    try {
      db.raw.exec(drawRow('d1', 'e1'));
      expect(() => db.raw.exec(assignment('a1', 'en1', 0))).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('refuses to delete anything a draw depends on', () => {
    const db = seeded();
    try {
      db.raw.exec(drawRow('d1', 'e1'));
      db.raw.exec(assignment('a1', 'en1'));

      // A prize somebody won, the participation that won it, the draw itself
      // and the event it belonged to are the EVIDENCE. Nothing may remove any
      // of them as a side effect of tidying up.
      for (const sql of [
        `DELETE FROM event_prizes WHERE id = 'pz1'`,
        `DELETE FROM event_entries WHERE id = 'en1'`,
        `DELETE FROM draws WHERE id = 'd1'`,
        `DELETE FROM events WHERE id = 'e1'`,
      ]) {
        expect(() => db.raw.exec(sql), sql).toThrow(/FOREIGN KEY/i);
      }
    } finally {
      db.close();
    }
  });

  it('lets an administrator be deleted without erasing the draw', () => {
    const db = seeded();
    try {
      // A SECOND administrator, who runs the draw and owns nothing else. The
      // seed's `u1` created the event and its prizes, and those columns are
      // RESTRICT — so deleting it would fail for a reason that has nothing to
      // do with what this test is about.
      db.raw.exec(
        `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
         VALUES ('u2','b@x.com','b@x.com','B','h')`,
      );
      db.raw.exec(drawRow('d1', 'e1').replace("'u1'", "'u2'"));

      // ON DELETE SET NULL, and no coherence rule requires the actor: removing
      // an administrator must not erase the record that a draw happened. The
      // authoritative attribution survives in `audit_logs`.
      db.raw.exec(`DELETE FROM admin_users WHERE id = 'u2'`);
      const row = db.raw
        .prepare('SELECT executed_by_admin_id AS a, id FROM draws WHERE id = ?')
        .get('d1') as { a: string | null; id: string };
      expect(row.id).toBe('d1');
      expect(row.a).toBeNull();
    } finally {
      db.close();
    }
  });

  it('declares the indexes it claims to', () => {
    const db = createTestDatabase();
    try {
      expect(indexNames(db.raw, 'draws')).toContain('ux_draws_event');
      const assignmentIndexes = indexNames(db.raw, 'draw_assignments');
      expect(assignmentIndexes).toContain('ux_draw_assignments_winner');
      expect(assignmentIndexes).toContain('ux_draw_assignments_unit');
    } finally {
      db.close();
    }
  });

  it('is not replayable onto a database that already has it', () => {
    const db = createTestDatabase();
    try {
      expect(() => db.raw.exec(readMigration('0016_draws_and_assignments.sql'))).toThrow(
        /duplicate column|already exists/i,
      );
    } finally {
      db.close();
    }
  });

  it('applies onto a POPULATED 0015 database without losing a row', () => {
    // The realistic upgrade: an existing deployment with participants already
    // administered. A migration that rebuilt a table would be the moment their
    // history disappeared.
    const db = createTestDatabase({ through: '0015_participant_administration.sql' });
    try {
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','CLOSED','u1','u1',${NOW},${NOW});
        INSERT INTO event_form_versions
          (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
        VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
        INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
        VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
        INSERT INTO event_entries
          (id, event_id, participant_id, form_version_id, status, overall_eligible,
           pre_disqualification_status, disqualified_at, disqualification_reason,
           submitted_at, created_at, updated_at)
        VALUES ('en1','e1','pa1','v1','DISQUALIFIED',1,'ELIGIBLE',${NOW},'Duplicate',${NOW},${NOW},${NOW});
      `);

      expect(() => db.raw.exec(readMigration('0016_draws_and_assignments.sql'))).not.toThrow();

      const entry = db.raw
        .prepare(
          `SELECT status, overall_eligible AS oe, pre_disqualification_status AS pre,
                  disqualification_reason AS reason
             FROM event_entries WHERE id = 'en1'`,
        )
        .get() as Record<string, unknown>;
      expect(entry).toMatchObject({
        status: 'DISQUALIFIED',
        oe: 1,
        pre: 'ELIGIBLE',
        reason: 'Duplicate',
      });

      const event = db.raw
        .prepare('SELECT participant_population_revision AS r, status FROM events WHERE id = ?')
        .get('e1') as { r: number; status: string };
      expect(event).toEqual({ r: 0, status: 'CLOSED' });
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('0016 — one event, throughout', () => {
  const NOW = `'2026-01-01T00:00:00.000Z'`;

  /** Two events, each with a prize, an entry and a draw of its own. */
  function seeded() {
    const db = createTestDatabase();
    db.raw.exec(`
      INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
      VALUES ('u1','a@x.com','a@x.com','A','h');
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e1','ev1','One','UTC','DRAW_READY','u1','u1',${NOW},${NOW});
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e2','ev2','Two','UTC','DRAW_READY','u1','u1',${NOW},${NOW});
      INSERT INTO event_form_versions
        (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
      VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
      INSERT INTO event_form_versions
        (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
      VALUES ('v2','e2',1,1,'u1',${NOW},'{}',${NOW});
      INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
      VALUES ('pz1','e1','Vape',2,0,'u1','u1',${NOW},${NOW});
      INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
      VALUES ('pz2','e2','Grinder',2,0,'u1','u1',${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa2','B@x.com','b@x.com','Bea','Ruiz',${NOW},${NOW});
      INSERT INTO event_entries (id, event_id, participant_id, form_version_id, status, overall_eligible, submitted_at, created_at, updated_at)
      VALUES ('en1','e1','pa1','v1','ELIGIBLE',1,${NOW},${NOW},${NOW});
      INSERT INTO event_entries (id, event_id, participant_id, form_version_id, status, overall_eligible, submitted_at, created_at, updated_at)
      VALUES ('en2','e2','pa2','v2','ELIGIBLE',1,${NOW},${NOW},${NOW});
      INSERT INTO draws (id, event_id, completed_at, candidate_count, prize_unit_count,
                         assignment_count, algorithm_version, candidate_set_hash,
                         candidate_population_revision, created_at)
      VALUES ('d1','e1',${NOW},1,2,1,'V1','abc',0,${NOW});
    `);
    return db;
  }

  const assign = (drawId, eventId, prizeId, entryId) =>
    `INSERT INTO draw_assignments
       (id, draw_id, event_id, prize_id, entry_id, prize_unit_index, draw_order,
        prize_name_snapshot, assigned_at)
     VALUES ('a1','${drawId}','${eventId}','${prizeId}','${entryId}',1,0,'Vape',${NOW})`;

  it('accepts an assignment whose four references agree', () => {
    const db = seeded();
    try {
      expect(() => db.raw.exec(assign('d1', 'e1', 'pz1', 'en1'))).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses a prize from another event', () => {
    const db = seeded();
    try {
      // Every single reference exists. Only their AGREEMENT is wrong, which is
      // what three separate foreign keys cannot see and a composite one can.
      expect(() => db.raw.exec(assign('d1', 'e1', 'pz2', 'en1'))).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('refuses an entry from another event', () => {
    const db = seeded();
    try {
      expect(() => db.raw.exec(assign('d1', 'e1', 'pz1', 'en2'))).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('refuses a draw from another event', () => {
    const db = seeded();
    try {
      db.raw.exec(
        `INSERT INTO draws (id, event_id, completed_at, candidate_count, prize_unit_count,
                            assignment_count, algorithm_version, candidate_set_hash,
                            candidate_population_revision, created_at)
         VALUES ('d2','e2',${NOW},1,2,1,'V1','abc',0,${NOW})`,
      );
      expect(() => db.raw.exec(assign('d2', 'e1', 'pz1', 'en1'))).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('declares the composite parent keys the foreign keys need', () => {
    const db = createTestDatabase();
    try {
      expect(indexNames(db.raw, 'draws')).toContain('ux_draws_id_event');
      expect(indexNames(db.raw, 'event_prizes')).toContain('ux_event_prizes_id_event');
      expect(indexNames(db.raw, 'event_entries')).toContain('ux_event_entries_id_event');
    } finally {
      db.close();
    }
  });

  it('adds the parent keys to a POPULATED database without losing a row', () => {
    // The composite indexes are created on tables that already hold data, so
    // an upgrade has to survive real rows.
    const db = createTestDatabase({ through: '0015_participant_administration.sql' });
    try {
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','CLOSED','u1','u1',${NOW},${NOW});
        INSERT INTO event_form_versions
          (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
        VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
        INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
        VALUES ('pz1','e1','Vape',2,0,'u1','u1',${NOW},${NOW});
        INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
        VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
        INSERT INTO event_entries (id, event_id, participant_id, form_version_id, status, overall_eligible, submitted_at, created_at, updated_at)
        VALUES ('en1','e1','pa1','v1','ELIGIBLE',1,${NOW},${NOW},${NOW});
      `);

      expect(() => db.raw.exec(readMigration('0016_draws_and_assignments.sql'))).not.toThrow();
      const counts = db.raw
        .prepare(
          `SELECT (SELECT COUNT(*) FROM event_prizes) AS prizes,
                  (SELECT COUNT(*) FROM event_entries) AS entries`,
        )
        .get();
      expect(counts).toEqual({ prizes: 1, entries: 1 });
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('0017 — publishing a result', () => {
  const NOW = `'2026-01-01T00:00:00.000Z'`;

  /** Two events, each drawn, so cross-event mixing can be attempted. */
  function seeded() {
    const db = createTestDatabase();
    db.raw.exec(`
      INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
      VALUES ('u1','a@x.com','a@x.com','A','h');
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e1','ev1','One','UTC','DRAW_COMPLETED','u1','u1',${NOW},${NOW});
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('e2','ev2','Two','UTC','DRAW_COMPLETED','u1','u1',${NOW},${NOW});
      INSERT INTO event_form_versions
        (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
      VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
      INSERT INTO event_form_versions
        (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
      VALUES ('v2','e2',1,1,'u1',${NOW},'{}',${NOW});
      INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
      VALUES ('pz1','e1','Vape',2,0,'u1','u1',${NOW},${NOW});
      INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
      VALUES ('pz2','e2','Grinder',2,0,'u1','u1',${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('pa2','B@x.com','b@x.com','Bea','Ruiz',${NOW},${NOW});
      INSERT INTO event_entries (id, event_id, participant_id, form_version_id, status, overall_eligible, submitted_at, created_at, updated_at)
      VALUES ('en1','e1','pa1','v1','ELIGIBLE',1,${NOW},${NOW},${NOW});
      INSERT INTO event_entries (id, event_id, participant_id, form_version_id, status, overall_eligible, submitted_at, created_at, updated_at)
      VALUES ('en2','e2','pa2','v2','ELIGIBLE',1,${NOW},${NOW},${NOW});
      INSERT INTO draws (id, event_id, completed_at, candidate_count, prize_unit_count,
                         assignment_count, algorithm_version, candidate_set_hash,
                         candidate_population_revision, created_at)
      VALUES ('d1','e1',${NOW},1,2,1,'V1','abc',0,${NOW});
      INSERT INTO draws (id, event_id, completed_at, candidate_count, prize_unit_count,
                         assignment_count, algorithm_version, candidate_set_hash,
                         candidate_population_revision, created_at)
      VALUES ('d2','e2',${NOW},1,2,1,'V1','abc',0,${NOW});
      INSERT INTO draw_assignments
        (id, draw_id, event_id, prize_id, entry_id, prize_unit_index, draw_order, prize_name_snapshot, assigned_at)
      VALUES ('as1','d1','e1','pz1','en1',1,0,'Vape',${NOW});
      INSERT INTO draw_assignments
        (id, draw_id, event_id, prize_id, entry_id, prize_unit_index, draw_order, prize_name_snapshot, assigned_at)
      VALUES ('as2','d2','e2','pz2','en2',1,0,'Grinder',${NOW});
    `);
    return db;
  }

  const publication = (id, eventId, drawId, winners = 1) =>
    `INSERT INTO result_publications
       (id, event_id, draw_id, published_at, published_by_admin_id, winner_count, created_at)
     VALUES ('${id}','${eventId}','${drawId}',${NOW},'u1',${winners},${NOW})`;

  const item = (id, publicationId, drawId, assignmentId, order = 0, name = 'Ana L.') =>
    `INSERT INTO result_publication_items
       (id, publication_id, draw_id, assignment_id, draw_order,
        winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
     VALUES ('${id}','${publicationId}','${drawId}','${assignmentId}',${order},
             '${name}','Vape',1,${NOW})`;

  it('accepts a coherent publication and its item', () => {
    const db = seeded();
    try {
      expect(() => db.raw.exec(publication('p1', 'e1', 'd1'))).not.toThrow();
      expect(() => db.raw.exec(item('i1', 'p1', 'd1', 'as1'))).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses a SECOND publication for the same event', () => {
    const db = seeded();
    try {
      db.raw.exec(publication('p1', 'e1', 'd1'));
      expect(() => db.raw.exec(publication('p2', 'e1', 'd1'))).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('refuses a second publication of the same draw', () => {
    const db = seeded();
    try {
      db.raw.exec(publication('p1', 'e1', 'd1'));
      // A different event claiming the same draw: caught by the draw index and,
      // failing that, by the composite key.
      expect(() => db.raw.exec(publication('p2', 'e2', 'd1'))).toThrow(
        /UNIQUE|FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });

  it('refuses a publication whose draw belongs to another event', () => {
    const db = seeded();
    try {
      // Every reference exists. Only their agreement is wrong.
      expect(() => db.raw.exec(publication('p1', 'e1', 'd2'))).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('refuses an item whose assignment belongs to another draw', () => {
    const db = seeded();
    try {
      db.raw.exec(publication('p1', 'e1', 'd1'));
      expect(() => db.raw.exec(item('i1', 'p1', 'd1', 'as2'))).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('refuses a publication with no winners', () => {
    const db = seeded();
    try {
      expect(() => db.raw.exec(publication('p1', 'e1', 'd1', 0))).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('refuses a blank identifier, name or prize', () => {
    const db = seeded();
    try {
      db.raw.exec(publication('p1', 'e1', 'd1'));
      // A blank public name would be a permanent placeholder in a permanent
      // record.
      expect(() => db.raw.exec(item('i1', 'p1', 'd1', 'as1', 0, '   '))).toThrow(/CHECK/i);
      expect(() =>
        db.raw.exec(
          `INSERT INTO result_publication_items
             (id, publication_id, draw_id, assignment_id, draw_order,
              winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
           VALUES ('i2','p1','d1','as1',0,'Ana L.','  ',1,${NOW})`,
        ),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('refuses an impossible unit index or position', () => {
    const db = seeded();
    try {
      db.raw.exec(publication('p1', 'e1', 'd1'));
      expect(() =>
        db.raw.exec(
          `INSERT INTO result_publication_items
             (id, publication_id, draw_id, assignment_id, draw_order,
              winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
           VALUES ('i1','p1','d1','as1',0,'Ana L.','Vape',0,${NOW})`,
        ),
      ).toThrow(/CHECK/i);
      expect(() =>
        db.raw.exec(
          `INSERT INTO result_publication_items
             (id, publication_id, draw_id, assignment_id, draw_order,
              winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
           VALUES ('i2','p1','d1','as1',-1,'Ana L.','Vape',1,${NOW})`,
        ),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('refuses two items for one assignment, or two in one position', () => {
    const db = seeded();
    try {
      db.raw.exec(publication('p1', 'e1', 'd1'));
      db.raw.exec(item('i1', 'p1', 'd1', 'as1', 0));
      // The same winner announced twice.
      expect(() => db.raw.exec(item('i2', 'p1', 'd1', 'as1', 1))).toThrow(/UNIQUE/i);
      // Two winners claiming one position: the public order would be ambiguous.
      expect(() => db.raw.exec(item('i3', 'p1', 'd1', 'as1', 0))).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('refuses a non-canonical timestamp', () => {
    const db = seeded();
    try {
      expect(() =>
        db.raw.exec(
          `INSERT INTO result_publications
             (id, event_id, draw_id, published_at, winner_count, created_at)
           VALUES ('p1','e1','d1','2026-01-01 00:00:00',1,${NOW})`,
        ),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it('refuses to delete anything a publication depends on', () => {
    const db = seeded();
    try {
      db.raw.exec(publication('p1', 'e1', 'd1'));
      db.raw.exec(item('i1', 'p1', 'd1', 'as1'));

      for (const sql of [
        `DELETE FROM result_publications WHERE id = 'p1'`,
        `DELETE FROM draw_assignments WHERE id = 'as1'`,
        `DELETE FROM draws WHERE id = 'd1'`,
        `DELETE FROM events WHERE id = 'e1'`,
      ]) {
        expect(() => db.raw.exec(sql), sql).toThrow(/FOREIGN KEY/i);
      }
    } finally {
      db.close();
    }
  });

  it('lets an administrator be deleted without erasing the publication', () => {
    const db = seeded();
    try {
      db.raw.exec(
        `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
         VALUES ('u2','b@x.com','b@x.com','B','h')`,
      );
      db.raw.exec(publication('p1', 'e1', 'd1').replace("'u1'", "'u2'"));

      // ON DELETE SET NULL, and no rule requires the actor: removing an account
      // must not erase the record that results were published.
      db.raw.exec(`DELETE FROM admin_users WHERE id = 'u2'`);
      const row = db.raw
        .prepare('SELECT id, published_by_admin_id AS a FROM result_publications')
        .get();
      expect(row).toEqual({ id: 'p1', a: null });
    } finally {
      db.close();
    }
  });

  it('declares the indexes and parent keys it claims to', () => {
    const db = createTestDatabase();
    try {
      expect(indexNames(db.raw, 'result_publications')).toEqual(
        expect.arrayContaining([
          'ux_result_publications_event',
          'ux_result_publications_draw',
          'ux_result_publications_id_draw',
        ]),
      );
      expect(indexNames(db.raw, 'result_publication_items')).toEqual(
        expect.arrayContaining(['ux_result_items_assignment', 'ux_result_items_order']),
      );
      expect(indexNames(db.raw, 'draw_assignments')).toContain('ux_draw_assignments_id_draw');
    } finally {
      db.close();
    }
  });

  it('is the last migration, and is not replayable', () => {
    const files = migrationFiles();
    expect(files.at(-1)).toBe('0017_results_and_archiving.sql');

    const db = createTestDatabase();
    try {
      expect(() => db.raw.exec(readMigration('0017_results_and_archiving.sql'))).toThrow(
        /already exists/i,
      );
    } finally {
      db.close();
    }
  });

  it('applies onto a POPULATED 0016 database without losing a row', () => {
    // The realistic upgrade: a deployment that has already drawn an event.
    const db = createTestDatabase({ through: '0016_draws_and_assignments.sql' });
    try {
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','DRAW_COMPLETED','u1','u1',${NOW},${NOW});
        INSERT INTO event_form_versions
          (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
        VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
        INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
        VALUES ('pz1','e1','Vape',2,0,'u1','u1',${NOW},${NOW});
        INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
        VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
        INSERT INTO event_entries
          (id, event_id, participant_id, form_version_id, status, overall_eligible,
           submission_id, pre_disqualification_status, submitted_at, created_at, updated_at)
        VALUES ('en1','e1','pa1','v1','ELIGIBLE',1,'sub-1',NULL,${NOW},${NOW},${NOW});
        INSERT INTO form_steps
          (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
        VALUES ('st1','VERSION','v1','About you',0,${NOW},${NOW});
        INSERT INTO form_questions
          (id, form_owner_type, form_owner_id, step_id, key, system_field, type,
           label, required, sort_order, created_at, updated_at)
        VALUES ('q1','VERSION','v1','st1','email','EMAIL','EMAIL','Email',1,0,${NOW},${NOW});
        INSERT INTO event_entry_answers
          (id, event_entry_id, question_id, question_key, question_label_snapshot,
           answer_type, answer_value, created_at)
        VALUES ('an1','en1','q1','email','Email','EMAIL','ana@x.com',${NOW});
        INSERT INTO draws (id, event_id, completed_at, candidate_count, prize_unit_count,
                           assignment_count, algorithm_version, candidate_set_hash,
                           candidate_population_revision, created_at)
        VALUES ('d1','e1',${NOW},1,2,1,'V1','abc',0,${NOW});
        INSERT INTO draw_assignments
          (id, draw_id, event_id, prize_id, entry_id, prize_unit_index, draw_order, prize_name_snapshot, assigned_at)
        VALUES ('as1','d1','e1','pz1','en1',1,0,'Vape',${NOW});
      `);

      expect(() => db.raw.exec(readMigration('0017_results_and_archiving.sql'))).not.toThrow();

      const counts = db.raw
        .prepare(
          `SELECT (SELECT COUNT(*) FROM events) AS events,
                  (SELECT COUNT(*) FROM event_prizes) AS prizes,
                  (SELECT COUNT(*) FROM event_form_versions) AS versions,
                  (SELECT COUNT(*) FROM participants) AS participants,
                  (SELECT COUNT(*) FROM event_entries) AS entries,
                  (SELECT COUNT(*) FROM event_entry_answers) AS answers,
                  (SELECT COUNT(*) FROM draws) AS draws,
                  (SELECT COUNT(*) FROM draw_assignments) AS assignments`,
        )
        .get();
      expect(counts).toEqual({
        events: 1,
        prizes: 1,
        versions: 1,
        participants: 1,
        entries: 1,
        answers: 1,
        draws: 1,
        assignments: 1,
      });

      // The historical detail survives, not just the row counts.
      const entry = db.raw
        .prepare(
          `SELECT status, overall_eligible AS oe, submission_id AS sub
             FROM event_entries WHERE id = 'en1'`,
        )
        .get();
      expect(entry).toEqual({ status: 'ELIGIBLE', oe: 1, sub: 'sub-1' });
      const assignment = db.raw
        .prepare("SELECT prize_name_snapshot AS name FROM draw_assignments WHERE id = 'as1'")
        .get();
      expect(assignment).toEqual({ name: 'Vape' });

      // ...and the new table works on the upgraded database.
      expect(() =>
        db.raw.exec(
          `INSERT INTO result_publications
             (id, event_id, draw_id, published_at, winner_count, created_at)
           VALUES ('p1','e1','d1',${NOW},1,${NOW})`,
        ),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('0017 — one winner per position', () => {
  const NOW = `'2026-01-01T00:00:00.000Z'`;

  it('refuses two DIFFERENT assignments claiming the same place in the draw', () => {
    // The assignment index cannot catch this one: the two rows name different
    // assignments, and only the position collides. Without its own index the
    // public order would be ambiguous, and the order is the only thing that
    // says which prize was drawn first.
    const db = createTestDatabase();
    try {
      db.raw.exec(`
        INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
        VALUES ('u1','a@x.com','a@x.com','A','h');
        INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
        VALUES ('e1','ev','Event','UTC','DRAW_COMPLETED','u1','u1',${NOW},${NOW});
        INSERT INTO event_form_versions
          (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
        VALUES ('v1','e1',1,1,'u1',${NOW},'{}',${NOW});
        INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
        VALUES ('pz1','e1','Vape',2,0,'u1','u1',${NOW},${NOW});
        INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
        VALUES ('pa1','A@x.com','a@x.com','Ana','Lopez',${NOW},${NOW});
        INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
        VALUES ('pa2','B@x.com','b@x.com','Bea','Ruiz',${NOW},${NOW});
        INSERT INTO event_entries (id, event_id, participant_id, form_version_id, status, overall_eligible, submitted_at, created_at, updated_at)
        VALUES ('en1','e1','pa1','v1','ELIGIBLE',1,${NOW},${NOW},${NOW});
        INSERT INTO event_entries (id, event_id, participant_id, form_version_id, status, overall_eligible, submitted_at, created_at, updated_at)
        VALUES ('en2','e1','pa2','v1','ELIGIBLE',1,${NOW},${NOW},${NOW});
        INSERT INTO draws (id, event_id, completed_at, candidate_count, prize_unit_count,
                           assignment_count, algorithm_version, candidate_set_hash,
                           candidate_population_revision, created_at)
        VALUES ('d1','e1',${NOW},2,2,2,'V1','abc',0,${NOW});
        INSERT INTO draw_assignments
          (id, draw_id, event_id, prize_id, entry_id, prize_unit_index, draw_order, prize_name_snapshot, assigned_at)
        VALUES ('as1','d1','e1','pz1','en1',1,0,'Vape',${NOW});
        INSERT INTO draw_assignments
          (id, draw_id, event_id, prize_id, entry_id, prize_unit_index, draw_order, prize_name_snapshot, assigned_at)
        VALUES ('as2','d1','e1','pz1','en2',2,1,'Vape',${NOW});
        INSERT INTO result_publications
          (id, event_id, draw_id, published_at, published_by_admin_id, winner_count, created_at)
        VALUES ('p1','e1','d1',${NOW},'u1',2,${NOW});
        INSERT INTO result_publication_items
          (id, publication_id, draw_id, assignment_id, draw_order,
           winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
        VALUES ('i1','p1','d1','as1',0,'Ana L.','Vape',1,${NOW});
      `);

      expect(() =>
        db.raw.exec(
          `INSERT INTO result_publication_items
             (id, publication_id, draw_id, assignment_id, draw_order,
              winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
           VALUES ('i2','p1','d1','as2',0,'Bea R.','Vape',2,${NOW})`,
        ),
      ).toThrow(/UNIQUE/i);

      // ...and the same two rows at DIFFERENT positions are fine.
      expect(() =>
        db.raw.exec(
          `INSERT INTO result_publication_items
             (id, publication_id, draw_id, assignment_id, draw_order,
              winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
           VALUES ('i3','p1','d1','as2',1,'Bea R.','Vape',2,${NOW})`,
        ),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
