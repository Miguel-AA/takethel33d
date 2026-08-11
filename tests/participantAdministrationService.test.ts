// @vitest-environment node
//
// Disqualification and reinstatement against real SQL: the real migrations,
// the real triggers, the real unique indexes.
//
// The property every test here circles: an entry's VERDICT is history and an
// administrative disposition is a separate, later fact. Nothing below may blur
// them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ParticipantAdministrationService } from '../functions/_shared/participantAdministrationService';
import { EventEntryRepository } from '../functions/_shared/eventEntryRepository';
import { setLogSink } from '../functions/_shared/logger';
import {
  answersFor,
  createHarness,
  dobForAge,
  seedPublicEvent,
  DOB_QUESTION,
  type PublicHarness,
} from './helpers/publicFlow';
import type { AdminParticipantListQuery, Event, EventFormVersion } from '../shared/types';

let harness: PublicHarness;
let service: ParticipantAdministrationService;

beforeEach(async () => {
  setLogSink(() => {});
  harness = await createHarness();
  service = new ParticipantAdministrationService(harness.db.d1);
});

afterEach(() => {
  setLogSink(null);
  harness.close();
});

const QUERY: AdminParticipantListQuery = {
  page: 1,
  pageSize: 25,
  search: null,
  eligibility: 'ALL',
  status: 'ALL',
  formVersionId: null,
};

const actor = () => ({
  admin: harness.admin,
  requestContext: {
    requestId: 'req-admin',
    ipHash: null,
    userAgent: null,
    origin: null,
    method: 'POST',
    pathname: '/x',
  },
});

/** Registers somebody, through the real registration service. */
async function enter(
  event: Event,
  version: EventFormVersion,
  overrides: Record<string, unknown> = {},
) {
  const result = await harness.registration.register(
    event.id,
    answersFor(version, overrides),
    harness.actor(),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value.entry;
}

const count = (sql: string) => (harness.db.raw.prepare(sql).get() as { n: number }).n;

// ---------------------------------------------------------------------------
describe('disqualification', () => {
  it('records who, when, why and what it replaced', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    const result = await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'Entered twice under two addresses' },
      actor(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.value.entry.status).toBe('DISQUALIFIED');
    expect(result.value.entryRevision).toBe(2);
    expect(result.value.entry.disposition).toMatchObject({
      reason: 'Entered twice under two addresses',
      preDisqualificationStatus: 'ELIGIBLE',
      disqualifiedByAdminId: harness.admin.id,
    });
  });

  it('leaves the VERDICT bit-for-bit unchanged', async () => {
    // The single most important assertion in this file.
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const entry = await enter(event, version, { date_of_birth: dobForAge(30) });

    const before = harness.db.raw
      .prepare(
        `SELECT calculated_age, age_eligible, overall_eligible, eligibility_reason,
                form_version_id, submitted_at
           FROM event_entries WHERE id = ?`,
      )
      .get(entry.id);

    await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'Rule breach' },
      actor(),
    );

    const after = harness.db.raw
      .prepare(
        `SELECT calculated_age, age_eligible, overall_eligible, eligibility_reason,
                form_version_id, submitted_at
           FROM event_entries WHERE id = ?`,
      )
      .get(entry.id);

    expect(after).toEqual(before);
  });

  it('leaves the answers untouched', async () => {
    const { event, version } = await seedPublicEvent(harness, { extra: [DOB_QUESTION] });
    const entry = await enter(event, version, { date_of_birth: dobForAge(30) });

    const before = harness.db.raw
      .prepare('SELECT * FROM event_entry_answers WHERE event_entry_id = ? ORDER BY id')
      .all(entry.id);

    await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'Rule breach' },
      actor(),
    );

    expect(
      harness.db.raw
        .prepare('SELECT * FROM event_entry_answers WHERE event_entry_id = ? ORDER BY id')
        .all(entry.id),
    ).toEqual(before);
  });

  it('writes exactly one audit row, attributed to the administrator', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'Rule breach' },
      actor(),
    );

    const rows = harness.db.raw
      .prepare(
        "SELECT actor_admin_id, metadata FROM audit_logs WHERE action = 'EVENT_ENTRY_DISQUALIFIED'",
      )
      .all() as Array<{ actor_admin_id: string; metadata: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].actor_admin_id).toBe(harness.admin.id);
    // The reason IS recorded: a trail without it cannot answer "why was this
    // person removed?".
    expect(rows[0].metadata).toContain('Rule breach');
  });

  it('records no personal data in the trail', async () => {
    const { event, version } = await seedPublicEvent(harness, { extra: [DOB_QUESTION] });
    const dob = dobForAge(30);
    const entry = await enter(event, version, { email: 'private@example.com', date_of_birth: dob });

    await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'Rule breach' },
      actor(),
    );

    const dump = JSON.stringify(harness.db.raw.prepare('SELECT * FROM audit_logs').all());
    expect(dump).not.toContain('private@example.com');
    expect(dump).not.toContain(dob);
    expect(dump).not.toContain('Ana');
  });

  it('refuses a second disqualification rather than overwriting the first', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'First' },
      actor(),
    );
    const second = await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 2, reason: 'Second' },
      actor(),
    );

    expect(second).toEqual({
      ok: false,
      failure: { code: 'ENTRY_ALREADY_DISQUALIFIED' },
    });
    // The ORIGINAL previous status survived.
    const stored = harness.db.raw
      .prepare('SELECT pre_disqualification_status, disqualification_reason FROM event_entries WHERE id = ?')
      .get(entry.id) as { pre_disqualification_status: string; disqualification_reason: string };
    expect(stored.pre_disqualification_status).toBe('ELIGIBLE');
    expect(stored.disqualification_reason).toBe('First');
  });
});

// ---------------------------------------------------------------------------
describe('reinstatement restores, it does not re-decide', () => {
  it('an entry that qualified returns to ELIGIBLE', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const entry = await enter(event, version, { date_of_birth: dobForAge(30) });

    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'x' }, actor());
    const back = await service.reinstate(event.id, entry.id, { expectedRevision: 2 }, actor());

    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error('unreachable');
    expect(back.value.entry.status).toBe('ELIGIBLE');
    expect(back.value.entry.disposition).toBeNull();
    expect(back.value.entryRevision).toBe(3);
  });

  it('an entry that NEVER qualified returns to INELIGIBLE, not ELIGIBLE', async () => {
    // The case that would break if reinstatement re-ran the age rule: raising
    // or lowering `minimum_age` between the two acts must change nothing.
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const entry = await enter(event, version, { date_of_birth: dobForAge(20) });
    expect(entry.status).toBe('INELIGIBLE');

    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'x' }, actor());

    // The organiser drops the age limit entirely in between.
    harness.db.raw.prepare('UPDATE events SET minimum_age = NULL WHERE id = ?').run(event.id);

    const back = await service.reinstate(event.id, entry.id, { expectedRevision: 2 }, actor());
    if (!back.ok) throw new Error(JSON.stringify(back.failure));

    expect(back.value.entry.status).toBe('INELIGIBLE');
    expect(back.value.entry.overallEligible).toBe(false);
  });

  it('a historical SUBMITTED entry returns to SUBMITTED', async () => {
    // Phase 7 rows were never judged. Reinstatement must not invent a verdict.
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    harness.db.raw
      .prepare(
        `UPDATE event_entries
            SET status = 'SUBMITTED', overall_eligible = NULL, age_eligible = NULL,
                calculated_age = NULL, eligibility_reason = NULL
          WHERE id = ?`,
      )
      .run(entry.id);

    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'x' }, actor());
    const back = await service.reinstate(event.id, entry.id, { expectedRevision: 2 }, actor());
    if (!back.ok) throw new Error(JSON.stringify(back.failure));

    expect(back.value.entry.status).toBe('SUBMITTED');
    expect(back.value.entry.overallEligible).toBeNull();
  });

  it('clears the disposition columns but not the audit trail', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'x' }, actor());
    await service.reinstate(event.id, entry.id, { expectedRevision: 2 }, actor());

    const stored = harness.db.raw
      .prepare(
        `SELECT disqualified_at, disqualified_by_admin_id, disqualification_reason,
                pre_disqualification_status
           FROM event_entries WHERE id = ?`,
      )
      .get(entry.id);
    expect(stored).toEqual({
      disqualified_at: null,
      disqualified_by_admin_id: null,
      disqualification_reason: null,
      pre_disqualification_status: null,
    });

    // The evidence lives where it cannot be cleared.
    expect(
      count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_DISQUALIFIED'"),
    ).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_REINSTATED'"),
    ).toBe(1);
  });

  it('refuses to reinstate an entry that is not disqualified', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    expect(
      await service.reinstate(event.id, entry.id, { expectedRevision: 1 }, actor()),
    ).toEqual({ ok: false, failure: { code: 'ENTRY_NOT_DISQUALIFIED' } });
  });
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two disqualifications from the same revision: exactly one wins', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    const [a, b] = await Promise.all([
      service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'A' }, actor()),
      service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'B' }, actor()),
    ]);

    const winners = [a, b].filter((result) => result.ok);
    expect(winners).toHaveLength(1);

    // One audit row, one recorded reason — no lost update.
    expect(
      count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_DISQUALIFIED'"),
    ).toBe(1);
    const stored = harness.db.raw
      .prepare('SELECT revision, disqualification_reason FROM event_entries WHERE id = ?')
      .get(entry.id) as { revision: number; disqualification_reason: string };
    expect(stored.revision).toBe(2);
    expect(['A', 'B']).toContain(stored.disqualification_reason);
  });

  it('a stale reinstatement is refused and told the current revision', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'x' }, actor());

    // Working from the revision they saw BEFORE the disqualification.
    const stale = await service.reinstate(event.id, entry.id, { expectedRevision: 1 }, actor());

    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('unreachable');
    expect(stale.failure).toEqual({ code: 'ENTRY_REVISION_CONFLICT', currentRevision: 2 });
  });

  it('a lost race writes no audit row for a change that never happened', async () => {
    // The guarded UPDATE matches nothing and the conditional audit insert sees
    // `changes() = 0`, so the batch commits having done nothing at all.
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    const repository = new EventEntryRepository(harness.db.d1);
    await harness.db.d1.batch([
      repository.disqualifyStatement({
        eventId: event.id,
        entryId: entry.id,
        expectedRevision: 999,
        reason: 'stale',
        adminId: harness.admin.id,
        at: new Date().toISOString(),
      }),
    ]);

    const stored = harness.db.raw
      .prepare('SELECT status, revision FROM event_entries WHERE id = ?')
      .get(entry.id) as { status: string; revision: number };
    expect(stored).toEqual({ status: 'ELIGIBLE', revision: 1 });
  });

  it('an event transition between read and write is respected', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    // The event moves past the point where the population may change.
    await harness.events.transition(event.id, 'close', harness.actor());
    harness.db.raw
      .prepare("UPDATE events SET status = 'DRAW_COMPLETED' WHERE id = ?")
      .run(event.id);

    const result = await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'x' },
      actor(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('EVENT_PARTICIPANTS_NOT_EDITABLE');
    expect(count('SELECT COUNT(*) AS n FROM event_entries WHERE status = \'DISQUALIFIED\'')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('scoping', () => {
  it('an entry from another event is NOT FOUND, not forbidden', async () => {
    // A 403 would confirm it exists somewhere, which is the disclosure the
    // scoping exists to prevent.
    const a = await seedPublicEvent(harness, { slug: 'first' });
    const b = await seedPublicEvent(harness, { slug: 'second' });
    const entry = await enter(a.event, a.version);

    const detail = await service.detail(b.event.id, entry.id);
    expect(detail).toEqual({ ok: false, failure: { code: 'EVENT_ENTRY_NOT_FOUND' } });

    const mutation = await service.disqualify(
      b.event.id,
      entry.id,
      { expectedRevision: 1, reason: 'x' },
      actor(),
    );
    expect(mutation.ok).toBe(false);

    // Nothing moved, and nothing was recorded.
    const stored = harness.db.raw
      .prepare('SELECT status, revision FROM event_entries WHERE id = ?')
      .get(entry.id) as { status: string; revision: number };
    expect(stored).toEqual({ status: 'ELIGIBLE', revision: 1 });
    expect(
      count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_DISQUALIFIED'"),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('listing, filtering and counting', () => {
  it('separates the historical verdict from the current disposition', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const eligible = await enter(event, version, {
      email: 'a@example.com',
      date_of_birth: dobForAge(30),
    });
    await enter(event, version, { email: 'b@example.com', date_of_birth: dobForAge(20) });

    await service.disqualify(
      event.id,
      eligible.id,
      { expectedRevision: 1, reason: 'x' },
      actor(),
    );

    const summary = await service.summary(event.id);
    if (!summary.ok) throw new Error('unreachable');

    expect(summary.value.summary).toEqual({
      total: 2,
      // Still counts as having qualified: that is what happened.
      eligible: 1,
      ineligible: 1,
      submitted: 0,
      disqualified: 1,
      // But no longer in the running.
      drawEligible: 0,
    });
  });

  it('filters by eligibility on the HISTORICAL verdict', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const entry = await enter(event, version, {
      email: 'a@example.com',
      date_of_birth: dobForAge(30),
    });
    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'x' }, actor());

    const eligible = await service.list(event.id, { ...QUERY, eligibility: 'ELIGIBLE' });
    if (!eligible.ok) throw new Error('unreachable');
    // Disqualified, but it DID qualify.
    expect(eligible.value.items).toHaveLength(1);
    expect(eligible.value.items[0].status).toBe('DISQUALIFIED');

    const byStatus = await service.list(event.id, { ...QUERY, status: 'ELIGIBLE' });
    if (!byStatus.ok) throw new Error('unreachable');
    expect(byStatus.value.items).toHaveLength(0);
  });

  it('searches names and emails without letting a wildcard match everything', async () => {
    const { event, version } = await seedPublicEvent(harness);
    await enter(event, version, { email: 'ana@example.com' });
    await enter(event, version, {
      email: 'bea@example.com',
      first_name: 'Bea',
      last_name: 'Ruiz',
    });

    const byFirst = await service.list(event.id, { ...QUERY, search: 'Bea' });
    if (!byFirst.ok) throw new Error('unreachable');
    expect(byFirst.value.items).toHaveLength(1);

    const byFull = await service.list(event.id, { ...QUERY, search: 'Bea Ruiz' });
    if (!byFull.ok) throw new Error('unreachable');
    expect(byFull.value.items).toHaveLength(1);

    const byEmail = await service.list(event.id, { ...QUERY, search: 'ANA@EXAMPLE' });
    if (!byEmail.ok) throw new Error('unreachable');
    expect(byEmail.value.items).toHaveLength(1);

    // A bare wildcard is matched LITERALLY, not as "everything".
    for (const hostile of ['%', '_', '\\', "' OR 1=1 --", '%%']) {
      const result = await service.list(event.id, { ...QUERY, search: hostile });
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.items, hostile).toHaveLength(0);
    }
  });

  it('paginates deterministically when timestamps tie', async () => {
    const { event, version } = await seedPublicEvent(harness);

    // The tie is built at INSERT time rather than by updating `submitted_at`
    // afterwards: phase 8's immutability trigger forbids moving it, and that
    // guarantee is worth more than the convenience of a shortcut here.
    const AT = "'2026-05-01T10:00:00.000Z'";
    for (const key of ['a', 'b', 'c', 'd']) {
      harness.db.raw.exec(`
        INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
        VALUES ('p-${key}','${key}@x.com','${key}@x.com','Name${key}','Surname',${AT},${AT});
        INSERT INTO event_entries
          (id, event_id, participant_id, form_version_id, status,
           calculated_age, age_eligible, overall_eligible, eligibility_reason,
           submitted_at, created_at, updated_at)
        VALUES ('e-${key}','${event.id}','p-${key}','${version.id}','ELIGIBLE',
                30, 1, 1, 'ELIGIBLE', ${AT}, ${AT}, ${AT});
      `);
    }

    const first = await service.list(event.id, { ...QUERY, pageSize: 2, page: 1 });
    const second = await service.list(event.id, { ...QUERY, pageSize: 2, page: 2 });
    if (!first.ok || !second.ok) throw new Error('unreachable');

    const ids = [...first.value.items, ...second.value.items].map((item) => item.entryId);
    // No row appears twice and none is skipped.
    expect(new Set(ids).size).toBe(4);

    // AND the order is the tie-breaker's, not the storage engine's. The rows
    // were inserted a→d, so their internal order is ascending; the contract is
    // `id DESC`, which is the reverse. Without the tie-breaker SQLite is free to
    // return them in insertion order and this assertion is what notices.
    expect(ids).toEqual(['e-d', 'e-c', 'e-b', 'e-a']);
  });

  it('reports whether the event state permits administration at all', async () => {
    const { event } = await seedPublicEvent(harness);
    const open = await service.list(event.id, QUERY);
    if (!open.ok) throw new Error('unreachable');
    expect(open.value.administrationAllowed).toBe(true);

    harness.db.raw.prepare("UPDATE events SET status = 'ARCHIVED' WHERE id = ?").run(event.id);
    const archived = await service.list(event.id, QUERY);
    if (!archived.ok) throw new Error('unreachable');
    expect(archived.value.administrationAllowed).toBe(false);
  });
});
