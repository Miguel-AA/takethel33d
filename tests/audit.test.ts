// @vitest-environment node
//
// AuditRepository and AuditService against the real migrated schema.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../functions/_shared/auditRepository';
import { AuditService } from '../functions/_shared/auditService';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { normalizeEmail } from '../shared/schemas';
import { newId } from '../functions/_shared/ids';
import { nowIso } from '../functions/_shared/time';
import { setLogSink } from '../functions/_shared/logger';
import { REDACTED } from '../functions/_shared/redact';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { RequestContext } from '../functions/_shared/requestContext';
import type { AuditAction, AuditEntityType } from '../shared/types';

let db: TestDatabase;
let repository: AuditRepository;
let service: AuditService;
let logLines: string[] = [];

const REQUEST: RequestContext = {
  requestId: 'req-abc123',
  ipHash: 'b'.repeat(64),
  userAgent: 'vitest/1.0',
  origin: null,
  method: 'POST',
  pathname: '/api/manager/login',
};

async function seedAdmin(email = 'ada@example.com'): Promise<string> {
  const result = await new AdminRepository(db.d1).create({
    email,
    normalizedEmail: normalizeEmail(email),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword('a-strong-admin-password'),
  });
  if (result.kind !== 'created') throw new Error('seed failed');
  return result.admin.id;
}

/** Inserts a row directly, for listing/filtering fixtures. */
async function insert(overrides: Partial<{
  id: string;
  actorAdminId: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  eventId: string | null;
  createdAt: string;
  metadata: string | null;
}> = {}) {
  const id = overrides.id ?? newId();
  await repository.append({
    id,
    actorAdminId: overrides.actorAdminId ?? null,
    action: overrides.action ?? 'ADMIN_LOGIN_SUCCEEDED',
    entityType: overrides.entityType ?? 'ADMIN_SESSION',
    entityId: overrides.entityId ?? null,
    eventId: overrides.eventId ?? null,
    previousData: null,
    newData: null,
    metadata: overrides.metadata ?? null,
    ipHash: 'c'.repeat(64),
    userAgent: 'vitest',
    requestId: 'req-fixture',
    createdAt: overrides.createdAt ?? nowIso(),
  });
  return id;
}

beforeEach(() => {
  db = createTestDatabase();
  repository = new AuditRepository(db.d1);
  service = new AuditService(db.d1);
  logLines = [];
  setLogSink((_level, line) => logLines.push(line));
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

describe('AuditRepository', () => {
  it('appends and reads back an entry', async () => {
    const adminId = await seedAdmin();
    const id = await insert({ actorAdminId: adminId, entityId: 'session-1' });

    const found = await repository.findById(id);
    expect(found).not.toBeNull();
    expect(found?.actorAdminId).toBe(adminId);
    expect(found?.action).toBe('ADMIN_LOGIN_SUCCEEDED');
    // The actor is joined for display.
    expect(found?.actorEmail).toBe('ada@example.com');
    expect(found?.actorDisplayName).toBe('Ada Lovelace');
  });

  it('returns null for an unknown id', async () => {
    expect(await repository.findById(newId())).toBeNull();
  });

  it('stores an entry with a null actor (pre-authentication events)', async () => {
    const id = await insert({ actorAdminId: null, action: 'ADMIN_LOGIN_FAILED' });
    const found = await repository.findById(id);
    expect(found?.actorAdminId).toBeNull();
    expect(found?.actorEmail).toBeNull();
  });

  it('rejects a non-canonical timestamp at the write boundary', async () => {
    await expect(insert({ createdAt: '2026-01-01 10:00:00' })).rejects.toThrow(/ISO-8601/);
  });

  it('exposes no update or delete method', () => {
    const surface = Object.getOwnPropertyNames(AuditRepository.prototype);
    expect(surface).not.toContain('update');
    expect(surface).not.toContain('delete');
    expect(surface).not.toContain('remove');
    // The surface is asserted exactly, so adding a method is a deliberate act.
    // `appendStatementIfChanged` was added in phase 3 for atomic event
    // mutations; like the others it only ever INSERTS.
    expect(surface.sort()).toEqual(
      [
        'append',
        'appendStatement',
        'appendStatementIfChanged',
        'constructor',
        'findById',
        'list',
      ].sort(),
    );
  });

  it('orders newest first and paginates', async () => {
    for (let i = 0; i < 5; i++) {
      await insert({ createdAt: `2026-01-0${i + 1}T00:00:00.000Z` });
    }

    const first = await repository.list({
      page: 1,
      pageSize: 2,
      actorAdminId: null,
      action: null,
      entityType: null,
      entityId: null,
      eventId: null,
      from: null,
      to: null,
    });
    expect(first.total).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(first.items[0].createdAt).toBe('2026-01-05T00:00:00.000Z');
    expect(first.items[1].createdAt).toBe('2026-01-04T00:00:00.000Z');

    const second = await repository.list({
      page: 2,
      pageSize: 2,
      actorAdminId: null,
      action: null,
      entityType: null,
      entityId: null,
      eventId: null,
      from: null,
      to: null,
    });
    expect(second.items[0].createdAt).toBe('2026-01-03T00:00:00.000Z');
  });

  const baseQuery = {
    page: 1,
    pageSize: 50,
    actorAdminId: null,
    action: null,
    entityType: null,
    entityId: null,
    eventId: null,
    from: null,
    to: null,
  };

  it('filters by actor, action, entity and event', async () => {
    const adminId = await seedAdmin();
    const eventId = newId();
    const entityId = newId();

    await insert({ actorAdminId: adminId, action: 'ADMIN_LOGIN_SUCCEEDED' });
    await insert({ actorAdminId: null, action: 'ADMIN_LOGIN_FAILED', entityType: 'SYSTEM' });
    await insert({ action: 'DRAW_STARTED', entityType: 'DRAW', entityId, eventId });

    expect((await repository.list({ ...baseQuery, actorAdminId: adminId })).total).toBe(1);
    expect((await repository.list({ ...baseQuery, action: 'ADMIN_LOGIN_FAILED' })).total).toBe(1);
    expect((await repository.list({ ...baseQuery, entityType: 'SYSTEM' })).total).toBe(1);
    expect((await repository.list({ ...baseQuery, entityId })).total).toBe(1);
    expect((await repository.list({ ...baseQuery, eventId })).total).toBe(1);
  });

  it('filters by date range using string comparison', async () => {
    await insert({ createdAt: '2026-01-01T00:00:00.000Z' });
    await insert({ createdAt: '2026-06-15T12:00:00.000Z' });
    await insert({ createdAt: '2026-12-31T23:59:59.999Z' });

    const mid = await repository.list({
      ...baseQuery,
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.999Z',
    });
    expect(mid.total).toBe(1);
    expect(mid.items[0].createdAt).toBe('2026-06-15T12:00:00.000Z');
  });

  it('round-trips JSON columns', async () => {
    const id = newId();
    await repository.append({
      id,
      actorAdminId: null,
      action: 'EVENT_UPDATED',
      entityType: 'EVENT',
      entityId: null,
      eventId: null,
      previousData: JSON.stringify({ name: 'before' }),
      newData: JSON.stringify({ name: 'after' }),
      metadata: JSON.stringify({ note: 'renamed' }),
      ipHash: null,
      userAgent: null,
      requestId: 'req-json',
      createdAt: nowIso(),
    });

    const found = await repository.findById(id);
    expect(found?.previousData).toEqual({ name: 'before' });
    expect(found?.newData).toEqual({ name: 'after' });
    expect(found?.metadata).toEqual({ note: 'renamed' });
  });

  it('degrades a corrupt JSON column to null instead of failing the read', async () => {
    const id = await insert();
    db.raw.prepare('UPDATE audit_logs SET metadata = ? WHERE id = ?').run('{broken', id);

    const found = await repository.findById(id);
    expect(found).not.toBeNull();
    expect(found?.metadata).toBeNull();
  });

  it('keeps history when the actor is deleted, orphaning the row', async () => {
    const adminId = await seedAdmin();
    const id = await insert({ actorAdminId: adminId });

    db.raw.prepare('DELETE FROM admin_users WHERE id = ?').run(adminId);

    // ON DELETE SET NULL, never CASCADE: the record of what they did survives.
    const found = await repository.findById(id);
    expect(found).not.toBeNull();
    expect(found?.actorAdminId).toBeNull();
    expect(found?.action).toBe('ADMIN_LOGIN_SUCCEEDED');
  });

  it('rejects an actor id that does not exist', async () => {
    await expect(insert({ actorAdminId: 'ghost' })).rejects.toThrow(/FOREIGN KEY/i);
  });
});

describe('AuditService', () => {
  it('records an entry with actor, request context and timestamp', async () => {
    const adminId = await seedAdmin();
    const result = await service.record({
      action: 'ADMIN_LOGIN_SUCCEEDED',
      entityType: 'ADMIN_SESSION',
      entityId: 'session-9',
      actor: { id: adminId, email: 'ada@example.com', displayName: 'Ada Lovelace' },
      requestContext: REQUEST,
      metadata: { sessionId: 'session-9' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entry = await service.findById(result.id);
    expect(entry?.actorAdminId).toBe(adminId);
    expect(entry?.requestId).toBe('req-abc123');
    expect(entry?.ipHash).toBe('b'.repeat(64));
    expect(entry?.userAgent).toBe('vitest/1.0');
    expect(entry?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('redacts secrets in metadata and payloads', async () => {
    const result = await service.record({
      action: 'ADMIN_LOGIN_SUCCEEDED',
      entityType: 'ADMIN_SESSION',
      requestContext: REQUEST,
      previousData: { password_hash: 'pbkdf2-sha256$100000$abc$def', email: 'a@b.com' },
      newData: { token: 'plain-token-value', nested: { cookie: 'session=abc' } },
      metadata: { password: 'hunter2', keep: 'visible' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = JSON.stringify(
      db.raw.prepare('SELECT * FROM audit_logs WHERE id = ?').get(result.id),
    );
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('plain-token-value');
    expect(raw).not.toContain('pbkdf2');
    expect(raw).not.toContain('session=abc');
    expect(raw).toContain(REDACTED);
    expect(raw).toContain('visible');
  });

  it('rejects an unknown action or entity type', async () => {
    const badAction = await service.record({
      action: 'NOT_A_REAL_ACTION' as AuditAction,
      entityType: 'SYSTEM',
      requestContext: REQUEST,
    });
    expect(badAction).toEqual({ ok: false, reason: 'invalid_action' });

    const badEntity = await service.record({
      action: 'ADMIN_LOGOUT',
      entityType: 'NOT_A_REAL_ENTITY' as AuditEntityType,
      requestContext: REQUEST,
    });
    expect(badEntity).toEqual({ ok: false, reason: 'invalid_entity_type' });
  });

  it('drops an oversized payload but still records the event', async () => {
    const result = await service.record({
      action: 'EVENT_UPDATED',
      entityType: 'EVENT',
      requestContext: REQUEST,
      newData: { blob: 'x'.repeat(80_000) },
      metadata: { note: 'kept' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = await service.findById(result.id);
    // Losing a detail beats losing the event.
    expect(entry?.newData).toBeNull();
    expect(entry?.metadata).toEqual({ note: 'kept' });
    expect(logLines.join(' ')).toContain('audit payload dropped');
  });

  it('is BEST-EFFORT: a write failure never throws and is logged', async () => {
    const failing = new AuditService(db.d1, {
      append: vi.fn(async () => {
        throw new Error('d1 unavailable');
      }),
    } as unknown as AuditRepository);

    const result = await failing.record({
      action: 'ADMIN_LOGOUT',
      entityType: 'ADMIN_SESSION',
      requestContext: REQUEST,
    });

    expect(result).toEqual({ ok: false, reason: 'write_failed' });
    const logged = logLines.join(' ');
    expect(logged).toContain('audit write failed');
    expect(logged).toContain('req-abc123');
    // The log line must not leak the underlying payload or a stack trace.
    expect(logged).not.toContain('at ');
  });

  it('statementFor returns a statement for CRITICAL atomic writes', async () => {
    const statement = service.statementFor({
      action: 'DRAW_COMPLETED',
      entityType: 'DRAW',
      requestContext: REQUEST,
    });
    expect(statement).toBeDefined();

    // Executing it persists the row, so it can be batched with an operation.
    await statement.run();
    const count = db.raw
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'DRAW_COMPLETED'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('statementFor throws on an unknown action rather than writing junk', () => {
    expect(() =>
      service.statementFor({
        action: 'MADE_UP' as AuditAction,
        entityType: 'SYSTEM',
        requestContext: REQUEST,
      }),
    ).toThrow(/Unknown audit action/);
  });

  it('never persists a raw IP', async () => {
    const result = await service.record({
      action: 'ADMIN_LOGIN_FAILED',
      entityType: 'SYSTEM',
      requestContext: REQUEST,
      metadata: { ip: '203.0.113.7', clientIp: '203.0.113.7' },
    });
    expect(result.ok).toBe(true);

    const dump = JSON.stringify(db.raw.prepare('SELECT * FROM audit_logs').all());
    expect(dump).not.toContain('203.0.113.7');
    expect(dump).toContain('b'.repeat(64));
  });
});
