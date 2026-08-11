// @vitest-environment node
//
// Regressions for defects found by attacking the phase 10 implementation, plus
// the attacks that did not find one and must keep not finding one.
//
// The measured behaviour is recorded beside each fix, because "this used to
// commit a disqualification into a completed draw" is the only thing that makes
// the assertion below mean anything a year from now.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ParticipantAdministrationService } from '../functions/_shared/participantAdministrationService';
import { EventEntryRepository } from '../functions/_shared/eventEntryRepository';
import { EventRepository } from '../functions/_shared/eventRepository';
import { AuditService } from '../functions/_shared/auditService';
import { setLogSink } from '../functions/_shared/logger';
import {
  EVENT_STATUSES_ALLOWING_PARTICIPANT_ADMINISTRATION,
  isDrawEligible,
} from '../shared/participantAdministration';
import { EVENT_STATUSES } from '../shared/eventLifecycle';
import {
  answersFor,
  createHarness,
  dobForAge,
  seedPublicEvent,
  DOB_QUESTION,
  type PublicHarness,
} from './helpers/publicFlow';
import type { Event, EventEntry, EventFormVersion } from '../shared/types';

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

async function enter(
  event: Event,
  version: EventFormVersion,
  overrides: Record<string, unknown> = {},
): Promise<EventEntry> {
  const result = await harness.registration.register(
    event.id,
    answersFor(version, overrides),
    harness.actor(),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value.entry;
}

const count = (sql: string) => (harness.db.raw.prepare(sql).get() as { n: number }).n;
const disqualifications = () =>
  count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_DISQUALIFIED'");

/** A database whose `batch` runs `interfere()` once, immediately before commit. */
function interposing(interfere: () => void): D1Database {
  let fired = false;
  return {
    prepare: (sql: string) => harness.db.d1.prepare(sql),
    exec: (sql: string) => harness.db.d1.exec(sql),
    batch: async (statements: unknown[]) => {
      if (!fired) {
        fired = true;
        interfere();
      }
      return harness.db.d1.batch(statements as never);
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// DEFECT 1 — the lifecycle was checked before the batch, not inside it
// ---------------------------------------------------------------------------

describe('lifecycle is re-asserted at commit time', () => {
  it('a disqualification cannot slip into an event that reached DRAW_COMPLETED', async () => {
    // MEASURED BEFORE THE FIX: the event moved to DRAW_COMPLETED between the
    // permission check and the commit, and the mutation succeeded anyway —
    // entry DISQUALIFIED, revision bumped to 2, audit row written. A draw had
    // already read that population.
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    const raced = new ParticipantAdministrationService(
      interposing(() => {
        harness.db.raw
          .prepare("UPDATE events SET status = 'DRAW_COMPLETED' WHERE id = ?")
          .run(event.id);
      }),
    );

    const result = await raced.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'Slipped through' },
      actor(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('EVENT_PARTICIPANTS_NOT_EDITABLE');

    // Nothing at all was written: the whole batch rolled back.
    const stored = harness.db.raw
      .prepare('SELECT status, revision FROM event_entries WHERE id = ?')
      .get(entry.id) as { status: string; revision: number };
    expect(stored).toEqual({ status: 'ELIGIBLE', revision: 1 });
    expect(disqualifications()).toBe(0);
  });

  it('a reinstatement cannot slip in either', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);
    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'x' }, actor());

    const raced = new ParticipantAdministrationService(
      interposing(() => {
        harness.db.raw
          .prepare("UPDATE events SET status = 'ARCHIVED' WHERE id = ?")
          .run(event.id);
      }),
    );

    const result = await raced.reinstate(event.id, entry.id, { expectedRevision: 2 }, actor());

    expect(result.ok).toBe(false);
    const stored = harness.db.raw
      .prepare('SELECT status, revision FROM event_entries WHERE id = ?')
      .get(entry.id) as { status: string; revision: number };
    // Still disqualified, still at the revision the disqualification produced.
    expect(stored).toEqual({ status: 'DISQUALIFIED', revision: 2 });
    expect(
      count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_REINSTATED'"),
    ).toBe(0);
  });

  it('the guard modifies nothing while the event is still administrable', async () => {
    // It must be inert in the ordinary case, or every successful mutation would
    // be reported as a phantom conflict.
    const { event } = await seedPublicEvent(harness);
    const before = harness.db.raw
      .prepare('SELECT status, revision, updated_at FROM events WHERE id = ?')
      .get(event.id);

    await harness.db.d1.batch([
      new EventRepository(harness.db.d1).abortUnlessParticipantsAdministrableStatement(
        event.id,
        EVENT_STATUSES_ALLOWING_PARTICIPANT_ADMINISTRATION,
      ),
    ]);

    expect(
      harness.db.raw
        .prepare('SELECT status, revision, updated_at FROM events WHERE id = ?')
        .get(event.id),
    ).toEqual(before);
  });

  it('the guard and the shared rule cannot disagree', async () => {
    // The permitted set is passed in rather than hardcoded in SQL, so there is
    // exactly one answer to "may this event's population change?".
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    // The revision only ever goes forward — the trigger refuses to let it walk
    // back — so each iteration carries the value the last one produced.
    let revision = 1;

    for (const status of EVENT_STATUSES) {
      harness.db.raw.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, event.id);

      const result = await service.disqualify(
        event.id,
        entry.id,
        { expectedRevision: revision, reason: 'Testing every state' },
        actor(),
      );

      const permitted = EVENT_STATUSES_ALLOWING_PARTICIPANT_ADMINISTRATION.includes(status);
      expect(result.ok, status).toBe(permitted);

      if (result.ok) {
        revision += 1;
        // Undo through the service, so the round trip is exercised too.
        const back = await service.reinstate(
          event.id,
          entry.id,
          { expectedRevision: revision },
          actor(),
        );
        expect(back.ok, `reinstate after ${status}`).toBe(true);
        revision += 1;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2 — the actor FK and the coherence invariant contradicted each other
// ---------------------------------------------------------------------------

describe('removing an administrator', () => {
  it('does not make a disqualified entry unwritable', async () => {
    // MEASURED BEFORE THE FIX: the trigger demanded `disqualified_by_admin_id`
    // on every DISQUALIFIED row, so the foreign key's ON DELETE SET NULL fired
    // the trigger and aborted — an account could never be removed once it had
    // disqualified anybody.
    //
    // The invariant is now precise about what it is FOR: a disqualification
    // must be interpretable and undoable (when, why, what it replaced). WHO is
    // attribution, and attribution that became unknown because the account was
    // deleted is a fact rather than an incoherence.
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);
    await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'Entered twice' },
      actor(),
    );

    // Exactly the write the foreign key performs when the account is removed.
    expect(() =>
      harness.db.raw
        .prepare('UPDATE event_entries SET disqualified_by_admin_id = NULL WHERE id = ?')
        .run(entry.id),
    ).not.toThrow();

    const stored = harness.db.raw
      .prepare(
        `SELECT status, disqualified_at, disqualification_reason, pre_disqualification_status
           FROM event_entries WHERE id = ?`,
      )
      .get(entry.id) as Record<string, unknown>;

    // The disposition is still interpretable and still undoable.
    expect(stored.status).toBe('DISQUALIFIED');
    expect(stored.disqualified_at).not.toBeNull();
    expect(stored.disqualification_reason).toBe('Entered twice');
    expect(stored.pre_disqualification_status).toBe('ELIGIBLE');
  });

  it('leaves the entry reinstatable, to the right status', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);
    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'x' }, actor());
    harness.db.raw
      .prepare('UPDATE event_entries SET disqualified_by_admin_id = NULL WHERE id = ?')
      .run(entry.id);

    const back = await service.reinstate(event.id, entry.id, { expectedRevision: 2 }, actor());
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error('unreachable');
    expect(back.value.entry.status).toBe('ELIGIBLE');
  });

  it('keeps the authoritative attribution in the audit trail', async () => {
    // Which is append-only and never deleted, so "who did this" survives even
    // when the entry can no longer say so.
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);
    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'x' }, actor());

    const row = harness.db.raw
      .prepare(
        "SELECT actor_admin_id FROM audit_logs WHERE action = 'EVENT_ENTRY_DISQUALIFIED'",
      )
      .get() as { actor_admin_id: string };
    expect(row.actor_admin_id).toBe(harness.admin.id);
  });

  it('still refuses a stray actor on an entry that is NOT disqualified', async () => {
    // Relaxing the requirement in one direction must not relax it in the other:
    // an orphan actor on a live entry would make it look disqualified to
    // anything reading the columns rather than the status.
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    expect(() =>
      harness.db.raw
        .prepare('UPDATE event_entries SET disqualified_by_admin_id = ? WHERE id = ?')
        .run(harness.admin.id, entry.id),
    ).toThrow(/incoherent administrative disposition/);
  });
});

// ---------------------------------------------------------------------------
// The coherence trigger, attacked one orphan column at a time
// ---------------------------------------------------------------------------

describe('disposition coherence', () => {
  it('refuses every partial disposition', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);
    const NOW = '2026-01-01T00:00:00.000Z';

    const hostile: Array<[string, string]> = [
      ['a timestamp with no disqualification', `disqualified_at='${NOW}'`],
      ['a reason with no disqualification', `disqualification_reason='x'`],
      ['a previous status with no disqualification', `pre_disqualification_status='ELIGIBLE'`],
      [
        'disqualified with no timestamp',
        `status='DISQUALIFIED', disqualification_reason='x', pre_disqualification_status='ELIGIBLE'`,
      ],
      [
        'disqualified with no reason',
        `status='DISQUALIFIED', disqualified_at='${NOW}', pre_disqualification_status='ELIGIBLE'`,
      ],
      [
        'disqualified with nothing to return to',
        `status='DISQUALIFIED', disqualified_at='${NOW}', disqualification_reason='x'`,
      ],
      [
        'a previous status of DISQUALIFIED',
        `status='DISQUALIFIED', disqualified_at='${NOW}', disqualification_reason='x', pre_disqualification_status='DISQUALIFIED'`,
      ],
      [
        'an empty reason',
        `status='DISQUALIFIED', disqualified_at='${NOW}', disqualification_reason='   ', pre_disqualification_status='ELIGIBLE'`,
      ],
      [
        'an over-long reason',
        `status='DISQUALIFIED', disqualified_at='${NOW}', disqualification_reason='${'x'.repeat(501)}', pre_disqualification_status='ELIGIBLE'`,
      ],
      [
        'a malformed timestamp',
        `status='DISQUALIFIED', disqualified_at='yesterday', disqualification_reason='x', pre_disqualification_status='ELIGIBLE'`,
      ],
      ['revision zero', 'revision=0'],
      ['revision going backwards', 'revision=0'],
    ];

    for (const [name, set] of hostile) {
      expect(
        () => harness.db.raw.exec(`UPDATE event_entries SET ${set} WHERE id = '${entry.id}'`),
        name,
      ).toThrow();
    }

    // And nothing slipped through along the way.
    const stored = harness.db.raw
      .prepare('SELECT status, revision FROM event_entries WHERE id = ?')
      .get(entry.id) as { status: string; revision: number };
    expect(stored).toEqual({ status: 'ELIGIBLE', revision: 1 });
  });

  it('refuses every partial shape on INSERT too', async () => {
    // The UPDATE path is the one the application exercises, so it is easy for
    // the INSERT trigger to be written once and never really tested. A restored
    // backup or a bad migration arrives through INSERT.
    const { event, version } = await seedPublicEvent(harness);
    const NOW = "'2026-01-01T00:00:00.000Z'";
    const ADMIN = `'${harness.admin.id}'`;

    harness.db.raw.exec(`
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('p-new','new@x.com','new@x.com','New','Person',${NOW},${NOW});
    `);

    const insert = (id: string, status: string, disposition: string) =>
      harness.db.raw.exec(`
        INSERT INTO event_entries
          (id, event_id, participant_id, form_version_id, status,
           overall_eligible, eligibility_reason,
           ${disposition ? `${disposition.split('=')[0].trim()},` : ''}
           submitted_at, created_at, updated_at)
        VALUES ('${id}','${event.id}','p-new','${version.id}','${status}',
                1, 'ELIGIBLE',
                ${disposition ? `${disposition.split('=').slice(1).join('=')},` : ''}
                ${NOW}, ${NOW}, ${NOW})
      `);

    const hostile: Array<[string, string, string]> = [
      ['a timestamp with no disqualification', 'ELIGIBLE', `disqualified_at=${NOW}`],
      ['a reason with no disqualification', 'ELIGIBLE', `disqualification_reason='x'`],
      ['an actor with no disqualification', 'ELIGIBLE', `disqualified_by_admin_id=${ADMIN}`],
      [
        'a previous status with no disqualification',
        'ELIGIBLE',
        `pre_disqualification_status='ELIGIBLE'`,
      ],
      ['disqualified with nothing at all', 'DISQUALIFIED', ''],
      ['disqualified with only a timestamp', 'DISQUALIFIED', `disqualified_at=${NOW}`],
      ['disqualified with only a reason', 'DISQUALIFIED', `disqualification_reason='x'`],
      [
        'disqualified with only a previous status',
        'DISQUALIFIED',
        `pre_disqualification_status='ELIGIBLE'`,
      ],
    ];

    for (const [name, status, disposition] of hostile) {
      expect(() => insert(`en-${name.replace(/\W/g, '')}`, status, disposition), name).toThrow(
        /incoherent administrative disposition/,
      );
    }

    // Nothing was written by any of them.
    expect(
      count(`SELECT COUNT(*) AS n FROM event_entries WHERE participant_id = 'p-new'`),
    ).toBe(0);
  });

  it('accepts a COMPLETE disposition on INSERT — the trigger is not a blanket ban', async () => {
    // Restoring a backup of a legitimately disqualified entry must work.
    const { event, version } = await seedPublicEvent(harness);
    const NOW = "'2026-01-01T00:00:00.000Z'";

    harness.db.raw.exec(`
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('p-restored','restored@x.com','restored@x.com','Restored','Person',${NOW},${NOW});
    `);

    expect(() =>
      harness.db.raw.exec(`
        INSERT INTO event_entries
          (id, event_id, participant_id, form_version_id, status,
           overall_eligible, eligibility_reason,
           disqualified_at, disqualified_by_admin_id, disqualification_reason,
           pre_disqualification_status,
           submitted_at, created_at, updated_at)
        VALUES ('en-restored','${event.id}','p-restored','${version.id}','DISQUALIFIED',
                1, 'ELIGIBLE',
                ${NOW}, '${harness.admin.id}', 'Restored from backup', 'ELIGIBLE',
                ${NOW}, ${NOW}, ${NOW})
      `),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Audit atomicity
// ---------------------------------------------------------------------------

describe('the mutation and its audit row commit together', () => {
  it('a failing audit write rolls the disposition back', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    // An audit service whose statement is guaranteed to fail inside the batch.
    const broken = new AuditService(harness.db.d1);
    broken.statementFor = () =>
      harness.db.d1
        .prepare('INSERT INTO audit_logs (id, action, entity_type, created_at) VALUES (?, ?, ?, ?)')
        .bind(null, null, null, null);

    const sabotaged = new ParticipantAdministrationService(harness.db.d1, { audit: broken });
    const result = await sabotaged.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'Will not survive' },
      actor(),
    );

    expect(result.ok).toBe(false);
    // An administrative act that happened without a record of who performed it
    // is exactly what the audit table exists to prevent.
    const stored = harness.db.raw
      .prepare('SELECT status, revision FROM event_entries WHERE id = ?')
      .get(entry.id) as { status: string; revision: number };
    expect(stored).toEqual({ status: 'ELIGIBLE', revision: 1 });
    expect(disqualifications()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The verdict, under every combination that could disturb it
// ---------------------------------------------------------------------------

describe('the historical verdict survives everything', () => {
  it('is unchanged by a disqualify/reinstate cycle even as the event moves', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const entry = await enter(event, version, { date_of_birth: dobForAge(20) });
    expect(entry.status).toBe('INELIGIBLE');

    const verdictOf = () =>
      harness.db.raw
        .prepare(
          `SELECT calculated_age, age_eligible, overall_eligible, eligibility_reason,
                  form_version_id, submitted_at
             FROM event_entries WHERE id = ?`,
        )
        .get(entry.id);
    const answersOf = () =>
      harness.db.raw
        .prepare('SELECT * FROM event_entry_answers WHERE event_entry_id = ? ORDER BY id')
        .all(entry.id);

    const verdict = verdictOf();
    const answers = answersOf();

    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'x' }, actor());

    // Everything that could tempt a re-evaluation changes in between.
    harness.db.raw
      .prepare("UPDATE events SET minimum_age = NULL, timezone = 'Asia/Tokyo' WHERE id = ?")
      .run(event.id);
    await harness.events.transition(event.id, 'close', harness.actor());

    const back = await service.reinstate(event.id, entry.id, { expectedRevision: 2 }, actor());
    if (!back.ok) throw new Error(JSON.stringify(back.failure));

    // Never qualified, so it returns to INELIGIBLE — not to ELIGIBLE, which is
    // what re-running the (now absent) age rule would have produced.
    expect(back.value.entry.status).toBe('INELIGIBLE');
    expect(verdictOf()).toEqual(verdict);
    expect(answersOf()).toEqual(answers);
  });

  it('phase 8 can still correct a verdict — the seam was not removed', async () => {
    // A blanket "verdict is immutable" trigger would have been tempting and
    // would have deleted a certified capability that belongs to another phase.
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);
    const repository = new EventEntryRepository(harness.db.d1);

    await harness.db.d1.batch([
      repository.applyEligibilityStatement(entry.id, {
        status: 'INELIGIBLE',
        calculatedAge: 17,
        ageEligible: false,
        overallEligible: false,
        eligibilityReason: 'AGE_REQUIREMENT_NOT_MET',
        at: '2026-02-01T00:00:00.000Z',
      }),
    ]);

    const stored = await repository.findByEventAndId(event.id, entry.id);
    expect(stored?.status).toBe('INELIGIBLE');
    expect(stored?.calculatedAge).toBe(17);
    // And phase 10 never calls it: the disposition statements name no verdict
    // column, which the tests above assert directly.
  });
});

// ---------------------------------------------------------------------------
// A corrupt row is refused, never guessed at
// ---------------------------------------------------------------------------

describe('a DISQUALIFIED row with nothing to restore', () => {
  it('is refused with a typed error rather than a guess or a 500', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    // Written past the trigger, as a bad migration or a console session could.
    harness.db.raw.exec('DROP TRIGGER trg_event_entries_disposition_update');
    harness.db.raw
      .prepare(
        `UPDATE event_entries
            SET status = 'DISQUALIFIED', disqualified_at = '2026-01-01T00:00:00.000Z',
                disqualification_reason = 'orphaned', pre_disqualification_status = NULL
          WHERE id = ?`,
      )
      .run(entry.id);

    const result = await service.reinstate(event.id, entry.id, { expectedRevision: 1 }, actor());

    expect(result).toEqual({ ok: false, failure: { code: 'ENTRY_NO_RESTORABLE_STATUS' } });
    // And the detail still renders, reporting no available actions rather than
    // throwing.
    const detail = await service.detail(event.id, entry.id);
    if (!detail.ok) throw new Error('unreachable');
    expect(detail.value.participant.entry.disposition).toBeNull();
    expect(detail.value.participant.actions.available).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Draw population, stated once
// ---------------------------------------------------------------------------

describe('the draw population', () => {
  it('is the same predicate in the summary and in the shared rule', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });

    const qualified = await enter(event, version, {
      email: 'a@x.com',
      date_of_birth: dobForAge(30),
    });
    await enter(event, version, { email: 'b@x.com', date_of_birth: dobForAge(30) });
    await enter(event, version, { email: 'c@x.com', date_of_birth: dobForAge(20) });

    await service.disqualify(
      event.id,
      qualified.id,
      { expectedRevision: 1, reason: 'x' },
      actor(),
    );

    const summary = await service.summary(event.id);
    if (!summary.ok) throw new Error('unreachable');

    const entries = harness.db.raw
      .prepare('SELECT status, overall_eligible FROM event_entries WHERE event_id = ?')
      .all(event.id) as Array<{ status: string; overall_eligible: number | null }>;

    const byRule = entries.filter((row) =>
      isDrawEligible({
        status: row.status as never,
        overallEligible: row.overall_eligible === null ? null : row.overall_eligible === 1,
      }),
    ).length;

    // The number on screen and the population a draw would take are the same
    // rule, not two that agree by coincidence.
    expect(summary.value.summary.drawEligible).toBe(byRule);
    expect(summary.value.summary.drawEligible).toBe(1);
    // The disqualified entry still counts as having qualified.
    expect(summary.value.summary.eligible).toBe(2);
  });
});
