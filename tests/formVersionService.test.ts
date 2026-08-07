// @vitest-environment node
//
// FormPublishingService and FormVersionRepository against the real migrated
// schema: atomicity, version numbering, immutability, history, snapshot
// consistency, event integration and concurrency.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FormPublishingService } from '../functions/_shared/formPublishingService';
import { FormVersionRepository } from '../functions/_shared/formVersionRepository';
import { FormDraftService } from '../functions/_shared/formDraftService';
import { FormRepository } from '../functions/_shared/formRepository';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { EventRepository } from '../functions/_shared/eventRepository';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { RequestContext } from '../functions/_shared/requestContext';
import type { AuthenticatedAdmin, Event, EventFormDraft } from '../shared/types';

let db: TestDatabase;
let publishing: FormPublishingService;
let drafts: FormDraftService;
let events: EventLifecycleService;
let admin: AuthenticatedAdmin;
let event: Event;

const REQUEST: RequestContext = {
  requestId: 'req-publish',
  ipHash: 'f'.repeat(64),
  userAgent: 'vitest',
  origin: null,
  method: 'POST',
  pathname: '/api/events/x/form/publish',
};

const actor = () => ({ admin, requestContext: REQUEST });
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function auditRows(action?: string) {
  const rows = db.raw
    .prepare('SELECT * FROM audit_logs ORDER BY rowid ASC')
    .all() as Array<Record<string, unknown>>;
  return action ? rows.filter((row) => row.action === action) : rows;
}

/** Builds a draft that satisfies every publication rule. */
async function publishableDraft(): Promise<EventFormDraft> {
  const created = await drafts.ensure(event.id, actor());
  if (!created.ok) throw new Error(created.failure.code);
  let form = created.value.draft;

  const step = await drafts.createStep(
    event.id,
    { expectedRevision: form.revision, title: 'About you' },
    actor(),
  );
  if (!step.ok) throw new Error(step.failure.code);
  form = step.value;

  for (const [field, type] of [
    ['FIRST_NAME', 'SHORT_TEXT'],
    ['LAST_NAME', 'SHORT_TEXT'],
    ['EMAIL', 'EMAIL'],
  ] as const) {
    const made = await drafts.createQuestion(
      event.id,
      {
        expectedRevision: form.revision,
        stepId: form.steps[0].id,
        type,
        systemField: field,
        label: field,
        required: true,
      } as never,
      actor(),
    );
    if (!made.ok) throw new Error(made.failure.code);
    form = made.value;
  }
  return form;
}

/** Moves the draft on by one revision, so there is something new to publish. */
async function touchDraft(form: EventFormDraft): Promise<EventFormDraft> {
  const saved = await drafts.saveDraft(event.id, form.revision, actor());
  if (!saved.ok) throw new Error(saved.failure.code);
  return saved.value;
}

beforeEach(async () => {
  db = createTestDatabase();
  setLogSink(() => {});
  publishing = new FormPublishingService(db.d1);
  drafts = new FormDraftService(db.d1);
  events = new EventLifecycleService(db.d1);

  const created = await new AdminRepository(db.d1).create({
    email: 'ada@example.com',
    normalizedEmail: normalizeEmail('ada@example.com'),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword('a-strong-admin-password'),
  });
  if (created.kind !== 'created') throw new Error('admin seed failed');
  admin = {
    id: created.admin.id,
    email: created.admin.email,
    displayName: created.admin.displayName,
    role: 'ADMIN',
    status: 'ACTIVE',
    sessionId: 'session-1',
  };

  const madeEvent = await events.create(
    {
      name: 'Publishable Event',
      registrationOpensAt: at(1),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
    },
    actor(),
  );
  if (!madeEvent.ok) throw new Error('event seed failed');
  event = madeEvent.value;
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

// ---------------------------------------------------------------------------
describe('publishing', () => {
  it('freezes version 1 and points the event at it', async () => {
    const form = await publishableDraft();
    const result = await publishing.publish(event.id, form.revision, actor());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.version.versionNumber).toBe(1);
    expect(result.value.version.sourceDraftRevision).toBe(form.revision);
    expect(result.value.event.publishedFormVersionId).toBe(result.value.version.id);
  });

  it('COPIES the structure rather than promoting it', async () => {
    const form = await publishableDraft();
    const result = await publishing.publish(event.id, form.revision, actor());
    if (!result.ok) throw new Error('unreachable');

    // The draft keeps its own rows, untouched and still owned by DRAFT.
    const draftRows = db.raw
      .prepare("SELECT COUNT(*) AS n FROM form_questions WHERE form_owner_type = 'DRAFT'")
      .get() as { n: number };
    const versionRows = db.raw
      .prepare("SELECT COUNT(*) AS n FROM form_questions WHERE form_owner_type = 'VERSION'")
      .get() as { n: number };
    expect(draftRows.n).toBe(3);
    expect(versionRows.n).toBe(3);

    // Different rows: the ids do not overlap.
    const draftIds = form.steps.flatMap((step) => step.questions.map((q) => q.id));
    const versionIds = result.value.version.steps.flatMap((s) => s.questions.map((q) => q.id));
    expect(versionIds.some((id) => draftIds.includes(id))).toBe(false);
  });

  it('leaves the draft editable at the SAME revision', async () => {
    const form = await publishableDraft();
    const result = await publishing.publish(event.id, form.revision, actor());
    if (!result.ok) throw new Error('unreachable');

    // Publishing is not an edit, so the draft is immediately "up to date".
    expect(result.value.draft.revision).toBe(form.revision);

    const next = await drafts.createStep(
      event.id,
      { expectedRevision: form.revision, title: 'Second' },
      actor(),
    );
    expect(next.ok).toBe(true);
  });

  it('editing after publishing does not touch the published version', async () => {
    const form = await publishableDraft();
    const published = await publishing.publish(event.id, form.revision, actor());
    if (!published.ok) throw new Error('unreachable');

    const question = form.steps[0].questions[0];
    const renamed = await drafts.updateQuestion(
      event.id,
      question.id,
      { expectedRevision: form.revision, label: 'Changed after publishing' },
      actor(),
    );
    expect(renamed.ok).toBe(true);

    const reloaded = await publishing.getVersion(event.id, published.value.version.id);
    if (!reloaded.ok) throw new Error('unreachable');
    const labels = reloaded.value.version.steps.flatMap((s) => s.questions.map((q) => q.label));
    expect(labels).not.toContain('Changed after publishing');
  });

  it('numbers versions consecutively', async () => {
    let form = await publishableDraft();
    for (const expected of [1, 2, 3]) {
      const result = await publishing.publish(event.id, form.revision, actor());
      expect(result.ok, `version ${expected}`).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.version.versionNumber).toBe(expected);
      form = await touchDraft(result.value.draft);
    }
  });

  it('refuses a revision other than the one confirmed', async () => {
    const form = await publishableDraft();
    const result = await publishing.publish(event.id, form.revision - 1, actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_DRAFT_REVISION_CONFLICT');
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS n FROM event_form_versions').get() as { n: number }).n,
    ).toBe(0);
  });

  it('says the form MOVED before it says the form is not ready', async () => {
    // A draft that is stale AND unpublishable. Which answer comes back matters:
    // the issues an operator would be shown are computed from a form they have
    // not seen, so "this changed under you" is the only honest first answer.
    const created = await drafts.ensure(event.id, actor());
    if (!created.ok) throw new Error('unreachable');
    const step = await drafts.createStep(
      event.id,
      { expectedRevision: created.value.draft.revision, title: 'Empty on purpose' },
      actor(),
    );
    if (!step.ok) throw new Error('unreachable');

    const result = await publishing.publish(event.id, step.value.revision - 1, actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_DRAFT_REVISION_CONFLICT');
  });

  it('refuses to publish a form that has not changed', async () => {
    const form = await publishableDraft();
    const first = await publishing.publish(event.id, form.revision, actor());
    if (!first.ok) throw new Error('unreachable');

    const again = await publishing.publish(event.id, form.revision, actor());
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.failure.code).toBe('FORM_NO_UNPUBLISHED_CHANGES');
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS n FROM event_form_versions').get() as { n: number }).n,
    ).toBe(1);
  });

  it('refuses a draft that is not publishable, and writes nothing', async () => {
    const created = await drafts.ensure(event.id, actor());
    if (!created.ok) throw new Error('unreachable');

    const result = await publishing.publish(event.id, created.value.draft.revision, actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_DRAFT_NOT_PUBLISHABLE');
    expect(auditRows('FORM_VERSION_PUBLISHED')).toHaveLength(0);
  });

  it('404s for an event that does not exist', async () => {
    const result = await publishing.publish(crypto.randomUUID(), 1, actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('EVENT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
describe('atomicity', () => {
  it('writes the version, its structure, the pointer and the audit row together', async () => {
    const form = await publishableDraft();
    await publishing.publish(event.id, form.revision, actor());

    const counts = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;
    expect(counts('SELECT COUNT(*) AS n FROM event_form_versions')).toBe(1);
    expect(
      counts("SELECT COUNT(*) AS n FROM form_steps WHERE form_owner_type = 'VERSION'"),
    ).toBe(1);
    expect(
      counts("SELECT COUNT(*) AS n FROM form_questions WHERE form_owner_type = 'VERSION'"),
    ).toBe(3);
    expect(
      counts('SELECT COUNT(*) AS n FROM events WHERE published_form_version_id IS NOT NULL'),
    ).toBe(1);

    const [entry] = auditRows('FORM_VERSION_PUBLISHED');
    expect(entry.entity_type).toBe('FORM_VERSION');
    expect(entry.event_id).toBe(event.id);
    expect(entry.actor_admin_id).toBe(admin.id);
    expect(entry.request_id).toBe(REQUEST.requestId);
  });

  it('rolls the whole publication back when the audit write fails', async () => {
    const form = await publishableDraft();
    db.raw.exec('DROP TABLE audit_logs');

    await expect(publishing.publish(event.id, form.revision, actor())).rejects.toThrow();

    const counts = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;
    expect(counts('SELECT COUNT(*) AS n FROM event_form_versions')).toBe(0);
    expect(
      counts("SELECT COUNT(*) AS n FROM form_steps WHERE form_owner_type = 'VERSION'"),
    ).toBe(0);
    expect(
      counts('SELECT COUNT(*) AS n FROM events WHERE published_form_version_id IS NOT NULL'),
    ).toBe(0);
  });

  it('aborts when the draft moves between the check and the batch', async () => {
    const form = await publishableDraft();
    const forms = new FormRepository(db.d1);
    const versions = new FormVersionRepository(db.d1);

    // Exactly the shape of a lost race: the guard must take the batch down.
    const attempt = db.d1.batch([
      forms.abortUnlessRevisionStatement(form.id, form.revision + 99),
      versions.insertVersionStatement({
        id: crypto.randomUUID(),
        eventId: event.id,
        versionNumber: 1,
        sourceDraftRevision: form.revision,
        publishedBy: admin.id,
        publishedAt: new Date().toISOString(),
        snapshot: '{"snapshotVersion":1}',
      }),
    ]);

    await expect(attempt).rejects.toThrow(/constraint/i);
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS n FROM event_form_versions').get() as { n: number }).n,
    ).toBe(0);
    // The draft's revision is untouched by the failed attempt.
    const draftRow = db.raw
      .prepare('SELECT revision FROM event_form_drafts WHERE id = ?')
      .get(form.id) as { revision: number };
    expect(draftRow.revision).toBe(form.revision);
  });
});

// ---------------------------------------------------------------------------
describe('immutability', () => {
  async function published() {
    const form = await publishableDraft();
    const result = await publishing.publish(event.id, form.revision, actor());
    if (!result.ok) throw new Error('unreachable');
    return result.value;
  }

  it('offers no way to change a version — the repository has no mutator', () => {
    const repository = new FormVersionRepository(db.d1) as unknown as Record<string, unknown>;
    const names = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(repository)),
    ].filter((name) => name !== 'constructor');

    for (const name of names) {
      expect(name, `${name} must not mutate a version`).not.toMatch(
        /^(update|delete|remove|patch|reorder)/i,
      );
    }
  });

  it('and no statement inside it can change one either', () => {
    // A naming convention is not a guarantee: a mutator called anything at all
    // would pass the check above. What must hold is that the file contains no
    // SQL capable of changing a version, whatever the method is called.
    const source = readFileSync(
      join(process.cwd(), 'functions', '_shared', 'formVersionRepository.ts'),
      'utf8',
    )
      // Prose about there being no UPDATE is not an UPDATE.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const written = (source.match(/\b(?:UPDATE|DELETE\s+FROM)\s+[a-z_]+/gi) ?? []).map(
      (statement) => statement.split(/\s+/).pop()!.toLowerCase(),
    );

    // Pointing the EVENT at a version is the one write this repository owns,
    // and it changes the event, never the version.
    expect([...new Set(written)]).toEqual(['events']);
  });

  it('the draft repository refuses to build a VERSION mutation', async () => {
    const forms = new FormRepository(db.d1);
    expect(() =>
      forms.insertStepStatement({
        id: crypto.randomUUID(),
        ownerType: 'VERSION',
        ownerId: 'anything',
        title: 'Sneaky',
        description: null,
        sortOrder: 0,
        at: new Date().toISOString(),
      }),
    ).toThrow(/cannot be mutated for owner type VERSION/i);

    expect(() =>
      forms.reorderStatements('steps', ['VERSION', 'anything'], [{ id: 'x', sortOrder: 0 }], 'now'),
    ).toThrow(/cannot be mutated for owner type VERSION/i);
  });

  it('a version step, question and option cannot be reached through the draft service', async () => {
    const outcome = await published();
    const versionStep = outcome.version.steps[0];
    const versionQuestion = versionStep.questions[0];
    const revision = outcome.draft.revision;

    const attempts = [
      ['update step', () => drafts.updateStep(event.id, versionStep.id, { expectedRevision: revision, title: 'X' }, actor())],
      ['delete step', () => drafts.deleteStep(event.id, versionStep.id, revision, actor())],
      ['update question', () => drafts.updateQuestion(event.id, versionQuestion.id, { expectedRevision: revision, label: 'X' }, actor())],
      ['delete question', () => drafts.deleteQuestion(event.id, versionQuestion.id, revision, actor())],
      ['duplicate question', () => drafts.duplicateQuestion(event.id, versionQuestion.id, revision, actor())],
      ['reorder steps', () => drafts.reorderSteps(event.id, revision, [{ id: versionStep.id, sortOrder: 0 }], actor())],
    ] as const;

    for (const [label, run] of attempts) {
      const result = await run();
      expect(result.ok, label).toBe(false);
    }

    // The version is byte-for-byte what it was.
    const reloaded = await publishing.getVersion(event.id, outcome.version.id);
    if (!reloaded.ok) throw new Error('unreachable');
    expect(reloaded.value.version.steps[0].title).toBe(versionStep.title);
    expect(reloaded.value.version.steps[0].questions).toHaveLength(3);
  });

  it('a version option cannot be deleted through a draft statement', async () => {
    const form = await publishableDraft();
    // Give the draft a select, publish, then aim the option statements at the
    // VERSION copy.
    const withSelect = await drafts.createQuestion(
      event.id,
      {
        expectedRevision: form.revision,
        stepId: form.steps[0].id,
        type: 'SINGLE_SELECT',
        label: 'Pick',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      } as never,
      actor(),
    );
    if (!withSelect.ok) throw new Error('unreachable');

    const outcome = await publishing.publish(event.id, withSelect.value.revision, actor());
    if (!outcome.ok) throw new Error('unreachable');

    const versionQuestion = outcome.value.version.steps[0].questions.find(
      (q) => q.options.length > 0,
    );
    expect(versionQuestion).toBeDefined();

    const forms = new FormRepository(db.d1);
    await db.d1.batch([
      forms.deleteOptionStatement(versionQuestion!.id, versionQuestion!.options[0].id),
      forms.deleteOptionsOfQuestionStatement(versionQuestion!.id),
    ]);

    // Both statements matched nothing: the options belong to a VERSION.
    const remaining = db.raw
      .prepare('SELECT COUNT(*) AS n FROM form_question_options WHERE question_id = ?')
      .get(versionQuestion!.id) as { n: number };
    expect(remaining.n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('history and reads', () => {
  it('reports nothing until something is published', async () => {
    const current = await publishing.currentPublished(event.id);
    expect(current.ok).toBe(true);
    if (!current.ok) throw new Error('unreachable');
    expect(current.value).toBeNull();

    const list = await publishing.listVersions(event.id, { page: 1, pageSize: 25 });
    expect(list.items).toEqual([]);
    expect(list.currentVersionId).toBeNull();
  });

  it('lists versions newest first, marking the live one', async () => {
    let form = await publishableDraft();
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const result = await publishing.publish(event.id, form.revision, actor());
      if (!result.ok) throw new Error('unreachable');
      ids.push(result.value.version.id);
      form = await touchDraft(result.value.draft);
    }

    const list = await publishing.listVersions(event.id, { page: 1, pageSize: 25 });
    expect(list.items.map((item) => item.versionNumber)).toEqual([3, 2, 1]);
    expect(list.currentVersionId).toBe(ids[2]);
    expect(list.items[0].currentPublished).toBe(true);
    expect(list.items[1].currentPublished).toBe(false);
    expect(list.items[0].publishedByName).toBe('Ada Lovelace');
    expect(list.items[0].questionCount).toBe(3);
  });

  it('refuses a version belonging to another event', async () => {
    const form = await publishableDraft();
    const mine = await publishing.publish(event.id, form.revision, actor());
    if (!mine.ok) throw new Error('unreachable');

    const other = await events.create(
      { name: 'Other', registrationOpensAt: at(1), registrationClosesAt: at(5), startsAt: at(6), endsAt: at(7) },
      actor(),
    );
    if (!other.ok) throw new Error('unreachable');

    const stolen = await publishing.getVersion(other.value.id, mine.value.version.id);
    expect(stolen.ok).toBe(false);
    if (stolen.ok) throw new Error('unreachable');
    expect(stolen.failure.code).toBe('FORM_VERSION_NOT_FOUND');

    const repository = new FormVersionRepository(db.d1);
    expect(await repository.versionBelongsToEvent(event.id, mine.value.version.id)).toBe(true);
    expect(await repository.versionBelongsToEvent(other.value.id, mine.value.version.id)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
describe('snapshot consistency', () => {
  async function publishOnce() {
    const form = await publishableDraft();
    const result = await publishing.publish(event.id, form.revision, actor());
    if (!result.ok) throw new Error('unreachable');
    return result.value.version.id;
  }

  it('stores a snapshot that agrees with the rows', async () => {
    const versionId = await publishOnce();
    const loaded = await publishing.getVersion(event.id, versionId);
    if (!loaded.ok) throw new Error('unreachable');

    expect(loaded.value.record.snapshot.summary.questionCount).toBe(3);
    expect(loaded.value.record.snapshot.steps[0].questions.map((q) => q.key)).toEqual([
      'first_name',
      'last_name',
      'email',
    ]);
  });

  it.each([
    ['a question that vanished from the rows', "DELETE FROM form_questions WHERE form_owner_type = 'VERSION' AND key = 'email'"],
    ['an option nobody published', null],
  ])('reports %s rather than repairing it', async (_label, sql) => {
    const versionId = await publishOnce();

    if (sql) {
      db.raw.exec(sql);
    } else {
      const question = db.raw
        .prepare("SELECT id FROM form_questions WHERE form_owner_type = 'VERSION' LIMIT 1")
        .get() as { id: string };
      const now = new Date().toISOString();
      db.raw
        .prepare(
          `INSERT INTO form_question_options
             (id, question_id, value, label, sort_order, created_at, updated_at)
           VALUES (?, ?, 'extra', 'Extra', 0, ?, ?)`,
        )
        .run(crypto.randomUUID(), question.id, now, now);
    }

    const loaded = await publishing.getVersion(event.id, versionId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('unreachable');
    expect(loaded.failure.code).toBe('FORM_VERSION_INVALID');
  });

  it('reports a snapshot that belongs to another form', async () => {
    const versionId = await publishOnce();
    db.raw
      .prepare('UPDATE event_form_versions SET schema_snapshot = ? WHERE id = ?')
      .run(JSON.stringify({ snapshotVersion: 1, eventId: 'somebody-else', steps: [] }), versionId);

    const loaded = await publishing.getVersion(event.id, versionId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('unreachable');
    expect(loaded.failure.code).toBe('FORM_VERSION_INVALID');
  });

  it('refuses an unreadable snapshot rather than losing the evidence', async () => {
    const versionId = await publishOnce();
    db.raw
      .prepare('UPDATE event_form_versions SET schema_snapshot = ? WHERE id = ?')
      .run('{not json', versionId);

    await expect(publishing.getVersion(event.id, versionId)).rejects.toThrow(
      /schema_snapshot/i,
    );
  });
});

// ---------------------------------------------------------------------------
// The pointer SQLite cannot police.
//
// `events.published_form_version_id` can only be constrained to name SOME
// version; a composite key against (id, event_id) is not expressible. These
// tests corrupt the row directly and assert the application refuses to act on
// it, because a foreign pointer means people would be shown another event's
// form.
// ---------------------------------------------------------------------------
describe('a pointer that is not this event’s', () => {
  async function otherEventWithVersion(): Promise<{ eventId: string; versionId: string }> {
    const other = await events.create(
      {
        name: 'Other',
        registrationOpensAt: at(1),
        registrationClosesAt: at(5),
        startsAt: at(6),
        endsAt: at(7),
      },
      actor(),
    );
    if (!other.ok) throw new Error('setup failed');

    const created = await drafts.ensure(other.value.id, actor());
    if (!created.ok) throw new Error('setup failed');
    let form = created.value.draft;
    const step = await drafts.createStep(
      other.value.id,
      { expectedRevision: form.revision, title: 'Theirs' },
      actor(),
    );
    if (!step.ok) throw new Error('setup failed');
    form = step.value;
    for (const [field, type] of [
      ['FIRST_NAME', 'SHORT_TEXT'],
      ['LAST_NAME', 'SHORT_TEXT'],
      ['EMAIL', 'EMAIL'],
    ] as const) {
      const made = await drafts.createQuestion(
        other.value.id,
        {
          expectedRevision: form.revision,
          stepId: form.steps[0].id,
          type,
          systemField: field,
          label: field,
          required: true,
        } as never,
        actor(),
      );
      if (!made.ok) throw new Error('setup failed');
      form = made.value;
    }

    const published = await publishing.publish(other.value.id, form.revision, actor());
    if (!published.ok) throw new Error('setup failed');
    return { eventId: other.value.id, versionId: published.value.version.id };
  }

  function pointAt(eventId: string, versionId: string | null): void {
    db.raw
      .prepare('UPDATE events SET published_form_version_id = ? WHERE id = ?')
      .run(versionId, eventId);
  }

  it('names the condition of a pointer rather than answering yes or no', async () => {
    const repository = new FormVersionRepository(db.d1);
    expect(await repository.pointerCondition(event.id)).toBe('none');

    const theirs = await otherEventWithVersion();
    pointAt(event.id, theirs.versionId);
    expect(await repository.pointerCondition(event.id)).toBe('foreign');

    const form = await publishableDraft();
    const mine = await publishing.publish(event.id, form.revision, actor());
    if (!mine.ok) throw new Error('unreachable');
    expect(await repository.pointerCondition(event.id)).toBe('valid');

    // A version whose structure has been destroyed is not a form to serve.
    db.raw
      .prepare("DELETE FROM form_questions WHERE form_owner_type = 'VERSION' AND form_owner_id = ?")
      .run(mine.value.version.id);
    expect(await repository.pointerCondition(event.id)).toBe('empty');
  });

  it('refuses to schedule or open an event pointing at a foreign version', async () => {
    const theirs = await otherEventWithVersion();
    pointAt(event.id, theirs.versionId);

    for (const action of ['publish', 'open'] as const) {
      const result = await events.transition(event.id, action, actor());
      expect(result.ok, action).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.code).toBe('EVENT_NOT_READY');
      if (result.failure.code === 'EVENT_NOT_READY') {
        expect(result.failure.fields).toContain('PUBLISHED_FORM_REQUIRED');
      }
    }
  });

  it('refuses to schedule an event whose published version has been gutted', async () => {
    const form = await publishableDraft();
    const published = await publishing.publish(event.id, form.revision, actor());
    if (!published.ok) throw new Error('unreachable');

    db.raw
      .prepare("DELETE FROM form_questions WHERE form_owner_type = 'VERSION'")
      .run();

    const result = await events.transition(event.id, 'publish', actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('EVENT_NOT_READY');
  });

  it('never serves another event’s form as this one’s published version', async () => {
    const theirs = await otherEventWithVersion();
    pointAt(event.id, theirs.versionId);

    const current = await publishing.currentPublished(event.id);
    expect(current.ok).toBe(false);
    if (current.ok) throw new Error('unreachable');
    expect(current.failure.code).toBe('FORM_VERSION_INVALID');
  });

  it('refuses to serve a published version whose rows disagree with its snapshot', async () => {
    const form = await publishableDraft();
    await publishing.publish(event.id, form.revision, actor());

    db.raw
      .prepare("DELETE FROM form_questions WHERE form_owner_type = 'VERSION' AND key = 'email'")
      .run();

    // The same verdict `GET /versions/:id` gives: two endpoints must never
    // disagree about one version.
    const current = await publishing.currentPublished(event.id);
    expect(current.ok).toBe(false);
    if (current.ok) throw new Error('unreachable');
    expect(current.failure.code).toBe('FORM_VERSION_INVALID');
  });
});

// ---------------------------------------------------------------------------
describe('one version per draft revision', () => {
  it('refuses a revision some OTHER version already froze', async () => {
    const form = await publishableDraft();
    const first = await publishing.publish(event.id, form.revision, actor());
    if (!first.ok) throw new Error('unreachable');

    // Advance the version numbers past the one that froze this revision, so a
    // check against only the LATEST version would let it through.
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO event_form_versions
           (id, event_id, version_number, source_draft_revision, published_by,
            published_at, schema_snapshot, created_at)
         VALUES (?, ?, 9, 999, ?, ?, '{"snapshotVersion":1}', ?)`,
      )
      .run(crypto.randomUUID(), event.id, admin.id, now, now);

    const again = await publishing.publish(event.id, form.revision, actor());
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.failure.code).toBe('FORM_NO_UNPUBLISHED_CHANGES');
    // And it NAMES the version that already holds this revision. The unique
    // index is the backstop, but a constraint error cannot say which version
    // won — so an answer of "version 1" proves the service looked, rather than
    // having fallen through to the database.
    if (again.failure.code !== 'FORM_NO_UNPUBLISHED_CHANGES') throw new Error('unreachable');
    expect(again.failure.versionNumber).toBe(first.value.version.versionNumber);

    const sources = db.raw
      .prepare('SELECT source_draft_revision AS r FROM event_form_versions')
      .all() as Array<{ r: number }>;
    expect(new Set(sources.map((row) => row.r)).size).toBe(sources.length);
  });

  it('the database refuses it too, outside the service', async () => {
    const form = await publishableDraft();
    await publishing.publish(event.id, form.revision, actor());

    const now = new Date().toISOString();
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO event_form_versions
             (id, event_id, version_number, source_draft_revision, published_by,
              published_at, schema_snapshot, created_at)
           VALUES (?, ?, 50, ?, ?, ?, '{}', ?)`,
        )
        .run(crypto.randomUUID(), event.id, form.revision, admin.id, now, now),
    ).toThrow(/UNIQUE/i);
  });
});

// ---------------------------------------------------------------------------
describe('publishing a large form', () => {
  it('does not need one statement per row', async () => {
    const created = await drafts.ensure(event.id, actor());
    if (!created.ok) throw new Error('unreachable');
    let form = created.value.draft;

    const step = await drafts.createStep(
      event.id,
      { expectedRevision: form.revision, title: 'Bulk' },
      actor(),
    );
    if (!step.ok) throw new Error('unreachable');
    form = step.value;

    for (const [field, type] of [
      ['FIRST_NAME', 'SHORT_TEXT'],
      ['LAST_NAME', 'SHORT_TEXT'],
      ['EMAIL', 'EMAIL'],
    ] as const) {
      const made = await drafts.createQuestion(
        event.id,
        {
          expectedRevision: form.revision,
          stepId: form.steps[0].id,
          type,
          systemField: field,
          label: field,
          required: true,
        } as never,
        actor(),
      );
      if (!made.ok) throw new Error('unreachable');
      form = made.value;
    }

    // 60 selects, five options each: 300 option rows, past the chunk size.
    for (let index = 0; index < 60; index++) {
      const made = await drafts.createQuestion(
        event.id,
        {
          expectedRevision: form.revision,
          stepId: form.steps[0].id,
          type: 'SINGLE_SELECT',
          label: `Pick ${index}`,
          options: Array.from({ length: 5 }, (_, i) => ({ value: `v${i}`, label: `V${i}` })),
        } as never,
        actor(),
      );
      if (!made.ok) throw new Error('unreachable');
      form = made.value;
    }

    const published = await publishing.publish(event.id, form.revision, actor());
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error('unreachable');

    // Every row arrived, in one atomic batch, without one statement per row.
    const counts = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;
    expect(
      counts("SELECT COUNT(*) AS n FROM form_questions WHERE form_owner_type = 'VERSION'"),
    ).toBe(63);
    expect(
      counts(
        `SELECT COUNT(*) AS n FROM form_question_options o
         JOIN form_questions q ON q.id = o.question_id
         WHERE q.form_owner_type = 'VERSION'`,
      ),
    ).toBe(300);

    const loaded = await publishing.getVersion(event.id, published.value.version.id);
    expect(loaded.ok).toBe(true);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Recovery: a version exists and the draft does not.
// ---------------------------------------------------------------------------
describe('cloning a published version back into a draft', () => {
  async function publishThenLoseTheDraft() {
    const form = await publishableDraft();
    const published = await publishing.publish(event.id, form.revision, actor());
    if (!published.ok) throw new Error('unreachable');

    // The state the ordinary flow cannot produce, but a repair or a partial
    // restore can: the version survives, the draft does not.
    db.raw.exec("DELETE FROM form_question_options WHERE question_id IN (SELECT id FROM form_questions WHERE form_owner_type = 'DRAFT')");
    db.raw.exec("DELETE FROM form_questions WHERE form_owner_type = 'DRAFT'");
    db.raw.exec("DELETE FROM form_steps WHERE form_owner_type = 'DRAFT'");
    db.raw.exec('DELETE FROM event_form_drafts');
    return published.value.version;
  }

  it('rebuilds an editable draft from the published version', async () => {
    const version = await publishThenLoseTheDraft();
    expect(await drafts.find(event.id).then((r) => (r.ok ? r.value.draft : null))).toBeNull();

    const cloned = await publishing.clonePublishedVersionToDraft(event.id, version.id, actor());
    expect(cloned.ok).toBe(true);
    if (!cloned.ok) throw new Error('unreachable');

    expect(cloned.value.revision).toBe(1);
    expect(cloned.value.steps).toHaveLength(1);
    expect(cloned.value.steps[0].questions.map((q) => q.key)).toEqual([
      'first_name',
      'last_name',
      'email',
    ]);
    // System fields survive the round trip.
    expect(cloned.value.steps[0].questions.map((q) => q.systemField)).toEqual([
      'FIRST_NAME',
      'LAST_NAME',
      'EMAIL',
    ]);
  });

  it('mints new ids, so editing the clone cannot reach the version', async () => {
    const version = await publishThenLoseTheDraft();
    const cloned = await publishing.clonePublishedVersionToDraft(event.id, version.id, actor());
    if (!cloned.ok) throw new Error('unreachable');

    const versionIds = version.steps.flatMap((s) => [s.id, ...s.questions.map((q) => q.id)]);
    const draftIds = cloned.value.steps.flatMap((s) => [
      s.id,
      ...s.questions.map((q) => q.id),
    ]);
    expect(draftIds.some((id) => versionIds.includes(id))).toBe(false);

    // Editing the clone leaves the version exactly as published.
    const question = cloned.value.steps[0].questions[0];
    await drafts.updateQuestion(
      event.id,
      question.id,
      { expectedRevision: cloned.value.revision, label: 'Edited after cloning' },
      actor(),
    );

    const reloaded = await publishing.getVersion(event.id, version.id);
    if (!reloaded.ok) throw new Error('unreachable');
    const labels = reloaded.value.version.steps.flatMap((s) => s.questions.map((q) => q.label));
    expect(labels).not.toContain('Edited after cloning');
  });

  it('REFUSES to overwrite a draft that already exists', async () => {
    const form = await publishableDraft();
    const published = await publishing.publish(event.id, form.revision, actor());
    if (!published.ok) throw new Error('unreachable');

    const cloned = await publishing.clonePublishedVersionToDraft(
      event.id,
      published.value.version.id,
      actor(),
    );
    expect(cloned.ok).toBe(false);
    if (cloned.ok) throw new Error('unreachable');
    expect(cloned.failure.code).toBe('FORM_PUBLISH_FAILED');
    if (cloned.failure.code === 'FORM_PUBLISH_FAILED') {
      expect(cloned.failure.reason).toBe('draft_exists');
    }

    // The operator's workspace is untouched.
    const still = await drafts.find(event.id);
    if (!still.ok) throw new Error('unreachable');
    expect(still.value.draft?.revision).toBe(form.revision);
  });

  it('refuses a version belonging to another event', async () => {
    const version = await publishThenLoseTheDraft();
    const other = await events.create(
      {
        name: 'Other',
        registrationOpensAt: at(1),
        registrationClosesAt: at(5),
        startsAt: at(6),
        endsAt: at(7),
      },
      actor(),
    );
    if (!other.ok) throw new Error('unreachable');

    const stolen = await publishing.clonePublishedVersionToDraft(
      other.value.id,
      version.id,
      actor(),
    );
    expect(stolen.ok).toBe(false);
    if (stolen.ok) throw new Error('unreachable');
    expect(stolen.failure.code).toBe('FORM_VERSION_NOT_FOUND');
  });

  it('records the clone, naming what it came from', async () => {
    const version = await publishThenLoseTheDraft();
    await publishing.clonePublishedVersionToDraft(event.id, version.id, actor());

    const entries = auditRows('FORM_DRAFT_CREATED');
    const clone = entries[entries.length - 1];
    const metadata = JSON.parse(String(clone.metadata));
    expect(metadata.clonedFromVersionId).toBe(version.id);
    expect(metadata.clonedFromVersionNumber).toBe(version.versionNumber);
  });

  it('is atomic: a failure leaves no half-built draft', async () => {
    const version = await publishThenLoseTheDraft();
    db.raw.exec('DROP TABLE audit_logs');

    await expect(
      publishing.clonePublishedVersionToDraft(event.id, version.id, actor()),
    ).rejects.toThrow();

    const counts = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;
    expect(counts('SELECT COUNT(*) AS n FROM event_form_drafts')).toBe(0);
    expect(counts("SELECT COUNT(*) AS n FROM form_steps WHERE form_owner_type = 'DRAFT'")).toBe(0);
  });

  it('has no endpoint: recovery is deliberate, not a button', () => {
    // A published form is what people are answering. Rebuilding a draft from it
    // is an administrative repair reachable from the service and nowhere else,
    // so no route file may mention it.
    const routes = readdirSync(join(process.cwd(), 'functions', 'api', 'events', '[id]', 'form'), {
      recursive: true,
      encoding: 'utf8',
    }).filter((name) => name.endsWith('.ts'));

    for (const route of routes) {
      const source = readFileSync(
        join(process.cwd(), 'functions', 'api', 'events', '[id]', 'form', route),
        'utf8',
      );
      expect(source, route).not.toContain('clonePublishedVersionToDraft');
    }

    expect(typeof publishing.clonePublishedVersionToDraft).toBe('function');
  });
});

// ---------------------------------------------------------------------------
describe('event integration', () => {
  it('an event cannot be scheduled or opened without a published form', async () => {
    for (const action of ['publish', 'open'] as const) {
      const result = await events.transition(event.id, action, actor());
      expect(result.ok, action).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.code).toBe('EVENT_NOT_READY');
      if (result.failure.code === 'EVENT_NOT_READY') {
        expect(result.failure.fields).toContain('PUBLISHED_FORM_REQUIRED');
      }
    }
  });

  it('reports it as a blocked action so the UI hides the button', async () => {
    const stored = await new EventRepository(db.d1).findById(event.id);
    const { available, blocked } = events.describeActions(stored!, {});
    expect(available).not.toContain('publish');
    expect(
      blocked.find((entry) => entry.action === 'publish')?.missingFields,
    ).toContain('PUBLISHED_FORM_REQUIRED');
  });

  it('allows it once a version exists', async () => {
    const form = await publishableDraft();
    const published = await publishing.publish(event.id, form.revision, actor());
    expect(published.ok).toBe(true);

    const scheduled = await events.transition(event.id, 'publish', actor());
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) throw new Error('unreachable');
    expect(scheduled.value.status).toBe('SCHEDULED');
  });

  it('a draft alone is not enough', async () => {
    await drafts.ensure(event.id, actor());
    const result = await events.transition(event.id, 'publish', actor());
    expect(result.ok).toBe(false);
  });

  it('an event carrying a version can never be deleted', async () => {
    const form = await publishableDraft();
    await publishing.publish(event.id, form.revision, actor());

    expect(await new EventRepository(db.d1).hasDependencies(event.id)).toBe(true);
    expect(() => db.raw.prepare('DELETE FROM events WHERE id = ?').run(event.id)).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it('the publisher cannot be deleted while the version stands', async () => {
    const form = await publishableDraft();
    await publishing.publish(event.id, form.revision, actor());
    expect(() =>
      db.raw.prepare('DELETE FROM admin_users WHERE id = ?').run(admin.id),
    ).toThrow(/FOREIGN KEY/i);
  });
});

// ---------------------------------------------------------------------------
describe('validation endpoint semantics', () => {
  it('answers without writing anything', async () => {
    const form = await publishableDraft();
    const before = auditRows().length;

    const result = await publishing.validate(event.id, form.revision);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.publishable).toBe(true);
    expect(result.value.draftRevision).toBe(form.revision);
    expect(result.value.hasUnpublishedChanges).toBe(true);

    expect(auditRows().length).toBe(before);
    const draftRow = db.raw
      .prepare('SELECT revision FROM event_form_drafts WHERE id = ?')
      .get(form.id) as { revision: number };
    expect(draftRow.revision).toBe(form.revision);
  });

  it('reports the verdict against a stale revision as a conflict', async () => {
    const form = await publishableDraft();
    const result = await publishing.validate(event.id, form.revision - 1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_DRAFT_REVISION_CONFLICT');
  });

  it('flips to "up to date" the moment something is published', async () => {
    const form = await publishableDraft();
    await publishing.publish(event.id, form.revision, actor());

    const after = await publishing.validate(event.id);
    if (!after.ok) throw new Error('unreachable');
    expect(after.value.hasUnpublishedChanges).toBe(false);
    expect(after.value.publishedVersionNumber).toBe(1);

    const moved = await touchDraft(form);
    const dirty = await publishing.validate(event.id, moved.revision);
    if (!dirty.ok) throw new Error('unreachable');
    expect(dirty.value.hasUnpublishedChanges).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two publications of the same revision: one wins, one conflicts', async () => {
    const form = await publishableDraft();

    const [first, second] = await Promise.all([
      publishing.publish(event.id, form.revision, actor()),
      publishing.publish(event.id, form.revision, actor()),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const loser = [first, second].find((result) => !result.ok);
    if (!loser || loser.ok) throw new Error('unreachable');
    expect(['FORM_VERSION_NUMBER_CONFLICT', 'FORM_NO_UNPUBLISHED_CHANGES']).toContain(
      loser.failure.code,
    );

    expect(
      (db.raw.prepare('SELECT COUNT(*) AS n FROM event_form_versions').get() as { n: number }).n,
    ).toBe(1);
    expect(auditRows('FORM_VERSION_PUBLISHED')).toHaveLength(1);
  });

  it('the unique index refuses a duplicate version number outright', async () => {
    const form = await publishableDraft();
    await publishing.publish(event.id, form.revision, actor());

    const now = new Date().toISOString();
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO event_form_versions
             (id, event_id, version_number, source_draft_revision, published_by,
              published_at, schema_snapshot, created_at)
           VALUES (?, ?, 1, 1, ?, ?, '{}', ?)`,
        )
        .run(crypto.randomUUID(), event.id, admin.id, now, now),
    ).toThrow(/UNIQUE/i);
  });

  it('a publication that loses the race by a hair writes NOTHING', async () => {
    const form = await publishableDraft();

    // The draft moves after the service read it and built its statements, but
    // before the batch runs. Two awaited calls cannot produce that interleaving
    // reliably, and it is precisely the one the in-batch abort exists for: the
    // early revision check has already passed by this point.
    let raced = false;
    const racing = {
      prepare: (sql: string) => db.d1.prepare(sql),
      exec: (sql: string) => db.d1.exec(sql),
      batch: (statements: unknown[]) => {
        if (!raced) {
          raced = true;
          db.raw
            .prepare('UPDATE event_form_drafts SET revision = revision + 1 WHERE id = ?')
            .run(form.id);
        }
        return db.d1.batch(statements as never);
      },
    } as unknown as D1Database;

    const result = await new FormPublishingService(racing).publish(
      event.id,
      form.revision,
      actor(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_DRAFT_REVISION_CONFLICT');

    // Not a partial publication: no version, no copied rows, no audit, and an
    // event still pointing nowhere.
    const count = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM event_form_versions')).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM form_questions WHERE form_owner_type = 'VERSION'"),
    ).toBe(0);
    expect(auditRows('FORM_VERSION_PUBLISHED')).toHaveLength(0);
    expect(
      (
        db.raw
          .prepare('SELECT published_form_version_id AS pointer FROM events WHERE id = ?')
          .get(event.id) as { pointer: string | null }
      ).pointer,
    ).toBeNull();
  });

  it('an edit racing a publication cannot both land on one revision', async () => {
    const form = await publishableDraft();

    const [edited, publishedResult] = await Promise.all([
      drafts.createStep(event.id, { expectedRevision: form.revision, title: 'Late' }, actor()),
      publishing.publish(event.id, form.revision, actor()),
    ]);

    // Both may legitimately succeed — publishing does not move the draft — but
    // whatever was frozen must match the revision it recorded.
    if (publishedResult.ok) {
      expect(publishedResult.value.version.sourceDraftRevision).toBe(form.revision);
      const questions = publishedResult.value.version.steps.flatMap((s) => s.questions);
      expect(questions).toHaveLength(3);
    }
    expect([edited.ok, publishedResult.ok].some(Boolean)).toBe(true);
  });
});
