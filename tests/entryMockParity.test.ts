// Observable parity between the dev mock and the real backend, for entries.
//
// The mock does not reproduce D1 and is not meant to. What it MUST reproduce is
// every rule an operator can observe: identity reuse, one entry per identity
// per event, the OPEN-and-inside-the-window gate, the published version as the
// only authority, the same refusals with the same codes, and responses that
// cannot mutate under their holder.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventFormVersion, SubmittedAnswer } from '@shared/types';

const ADMIN_EMAIL = 'admin@l33d.test';
const ADMIN_PASSWORD = 'l33d-dev-password';

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

async function freshMock(signIn = true) {
  const mod = await import('../src/lib/mockApi');
  if (signIn) await mod.mockApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  return {
    mockApi: mod.mockApi,
    setEventStatus: mod.__setMockEventStatus,
    setClock: mod.__setMockClock,
  };
}

let mock: Awaited<ReturnType<typeof freshMock>>;

beforeEach(async () => {
  vi.resetModules();
  mock = await freshMock();
});

/** An OPEN event serving a published form with the three identity questions. */
async function openEvent(name = 'Entry Parity Event', extra: Array<Record<string, unknown>> = []) {
  const event = await mock.mockApi.createEvent({
    name,
    registrationOpensAt: at(-1),
    registrationClosesAt: at(5),
    startsAt: at(6),
    endsAt: at(7),
  });

  const created = await mock.mockApi.createFormDraft(event.id);
  if (!created.draft) throw new Error('draft missing');
  let form = (
    await mock.mockApi.createFormStep(event.id, {
      expectedRevision: created.draft.revision,
      title: 'About you',
    })
  ).draft;

  const stepId = form.steps[0].id;
  const specs = [
    { type: 'SHORT_TEXT', systemField: 'FIRST_NAME', label: 'First name', required: true },
    { type: 'SHORT_TEXT', systemField: 'LAST_NAME', label: 'Last name', required: true },
    { type: 'EMAIL', systemField: 'EMAIL', label: 'Email', required: true },
    ...extra,
  ];
  for (const spec of specs) {
    form = (
      await mock.mockApi.createFormQuestion(event.id, {
        expectedRevision: form.revision,
        stepId,
        ...spec,
      } as never)
    ).draft;
  }

  const published = await mock.mockApi.publishForm(event.id, form.revision);
  await mock.mockApi.transitionEvent(event.id, 'open');
  const reloaded = await mock.mockApi.getEvent(event.id);
  return { event: reloaded.event, version: published.version };
}

function answersFor(
  version: EventFormVersion,
  overrides: Record<string, unknown> = {},
): SubmittedAnswer[] {
  const values: Record<string, unknown> = {
    first_name: 'Ana',
    last_name: 'Lopez',
    email: 'Ana@Example.com',
    ...overrides,
  };
  const byKey = new Map(
    version.steps.flatMap((step) => step.questions).map((question) => [question.key, question]),
  );
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const question = byKey.get(key);
      if (!question) throw new Error(`no question keyed ${key}`);
      return { questionId: question.id, value };
    });
}

// ---------------------------------------------------------------------------
describe('recording a participation', () => {
  it('creates an identity, an entry and its answers', async () => {
    const { event, version } = await openEvent();
    const created = await mock.mockApi.createEventEntry(event.id, answersFor(version));

    expect(created.answerCount).toBe(3);
    expect(created.entry.formVersionId).toBe(version.id);
    // Born decided, exactly as on the server. No age rule and no date of birth
    // asked, so the age and the age JUDGEMENT are both null — but the
    // participation itself has a verdict.
    expect(created.entry.status).toBe('ELIGIBLE');
    expect(created.entry.overallEligible).toBe(true);
    expect(created.entry.eligibilityReason).toBe('ELIGIBLE');
    expect(created.entry.calculatedAge).toBeNull();
    expect(created.entry.ageEligible).toBeNull();
    // Presentable email preserved; the canonical form carries identity.
    expect(created.participant.email).toBe('Ana@Example.com');
    expect(created.participant.normalizedEmail).toBe('ana@example.com');
  });

  it('files an answer under the VERSION’s key, label and type', async () => {
    const { event, version } = await openEvent();
    const created = await mock.mockApi.createEventEntry(event.id, answersFor(version));
    const detail = await mock.mockApi.getEventEntry(event.id, created.entry.id);

    const email = detail.answers.find((answer) => answer.questionKey === 'email');
    expect(email?.questionLabel).toBe('Email');
    expect(email?.type).toBe('EMAIL');
  });

  it('orders answers as the form asks them, not as they were sent', async () => {
    const { event, version } = await openEvent('Ordered', [
      { type: 'SHORT_TEXT', label: 'City', key: 'city' },
    ]);
    const created = await mock.mockApi.createEventEntry(event.id, [
      ...answersFor(version, { city: 'Madrid' }).reverse(),
    ]);
    const detail = await mock.mockApi.getEventEntry(event.id, created.entry.id);
    expect(detail.answers.map((answer) => answer.questionKey)).toEqual([
      'first_name',
      'last_name',
      'email',
      'city',
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('identity parity', () => {
  it('one address is one identity across events', async () => {
    const first = await openEvent('First');
    const second = await openEvent('Second');

    const a = await mock.mockApi.createEventEntry(first.event.id, answersFor(first.version));
    const b = await mock.mockApi.createEventEntry(second.event.id, answersFor(second.version));

    expect(b.participant.id).toBe(a.participant.id);
    expect(a.entry.formVersionId).toBe(first.version.id);
    expect(b.entry.formVersionId).toBe(second.version.id);
  });

  it('refuses a second entry in the same event, naming the first', async () => {
    const { event, version } = await openEvent();
    const created = await mock.mockApi.createEventEntry(event.id, answersFor(version));

    await expect(
      mock.mockApi.createEventEntry(event.id, answersFor(version)),
    ).rejects.toMatchObject({
      code: 'PARTICIPANT_ALREADY_ENTERED',
      fields: { entryId: created.entry.id },
    });
  });

  it('a different capitalisation is the same person', async () => {
    const { event, version } = await openEvent();
    await mock.mockApi.createEventEntry(event.id, answersFor(version));
    await expect(
      mock.mockApi.createEventEntry(event.id, answersFor(version, { email: 'ANA@EXAMPLE.COM' })),
    ).rejects.toMatchObject({ code: 'PARTICIPANT_ALREADY_ENTERED' });
  });

  it('refuses two different dates of birth for one address', async () => {
    const dob = { type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth' };
    const first = await openEvent('DOB one', [dob]);
    const second = await openEvent('DOB two', [dob]);

    await mock.mockApi.createEventEntry(
      first.event.id,
      answersFor(first.version, { date_of_birth: '1990-01-01' }),
    );
    await expect(
      mock.mockApi.createEventEntry(
        second.event.id,
        answersFor(second.version, { date_of_birth: '1991-01-01' }),
      ),
    ).rejects.toMatchObject({
      code: 'PARTICIPANT_IDENTITY_CONFLICT',
      fields: { field: 'dateOfBirth' },
    });
  });

  it('a form that does not ask cannot erase what an earlier one recorded', async () => {
    const first = await openEvent('With DOB', [
      { type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth' },
    ]);
    await mock.mockApi.createEventEntry(
      first.event.id,
      answersFor(first.version, { date_of_birth: '1990-01-01' }),
    );

    const second = await openEvent('Without DOB');
    const created = await mock.mockApi.createEventEntry(
      second.event.id,
      answersFor(second.version, { first_name: 'Ana Maria' }),
    );
    expect(created.participant.firstName).toBe('Ana Maria');
    expect(created.participant.dateOfBirth).toBe('1990-01-01');
  });
});

// ---------------------------------------------------------------------------
describe('the lifecycle gate', () => {
  it('refuses every state that is not OPEN', async () => {
    const { event, version } = await openEvent();
    for (const status of ['DRAFT', 'SCHEDULED', 'CLOSED', 'CANCELLED', 'ARCHIVED'] as const) {
      mock.setEventStatus(event.id, status);
      await expect(
        mock.mockApi.createEventEntry(event.id, answersFor(version)),
        status,
      ).rejects.toMatchObject({
        code: 'EVENT_NOT_ACCEPTING_ENTRIES',
        fields: { reason: 'EVENT_NOT_OPEN' },
      });
    }
  });

  it('refuses before the window opens and once it has closed', async () => {
    const { event, version } = await openEvent();

    mock.setEventStatus(event.id, 'OPEN', { registrationOpensAt: at(1) });
    await expect(
      mock.mockApi.createEventEntry(event.id, answersFor(version)),
    ).rejects.toMatchObject({ fields: { reason: 'REGISTRATION_NOT_STARTED' } });

    mock.setEventStatus(event.id, 'OPEN', {
      registrationOpensAt: at(-2),
      registrationClosesAt: at(-1),
    });
    await expect(
      mock.mockApi.createEventEntry(event.id, answersFor(version)),
    ).rejects.toMatchObject({ fields: { reason: 'REGISTRATION_CLOSED' } });
  });
});

// ---------------------------------------------------------------------------
describe('the published version is the authority', () => {
  it('refuses an event with no published form', async () => {
    const event = await mock.mockApi.createEvent({
      name: 'Formless',
      registrationOpensAt: at(-1),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
    });
    mock.setEventStatus(event.id, 'OPEN');

    await expect(mock.mockApi.createEventEntry(event.id, [])).rejects.toMatchObject({
      code: 'FORM_VERSION_REQUIRED',
    });
  });

  it('refuses a pointer at another event’s version', async () => {
    const owner = await openEvent('Owner');
    const impostor = await openEvent('Impostor');
    mock.setEventStatus(impostor.event.id, 'OPEN', {
      publishedFormVersionId: owner.version.id,
    });

    await expect(
      mock.mockApi.createEventEntry(impostor.event.id, answersFor(owner.version)),
    ).rejects.toMatchObject({ code: 'FORM_VERSION_REQUIRED' });
  });

  it('refuses a question from another event’s form', async () => {
    const { event, version } = await openEvent('Owner');
    const other = await openEvent('Other');
    const foreign = other.version.steps[0].questions[0];

    await expect(
      mock.mockApi.createEventEntry(event.id, [
        ...answersFor(version),
        { questionId: foreign.id, value: 'x' },
      ]),
    ).rejects.toMatchObject({ code: 'FORM_ANSWER_UNKNOWN_QUESTION' });
  });
});

// ---------------------------------------------------------------------------
describe('submission refusals carry the same codes', () => {
  it('missing, duplicate, unknown, not-allowed and invalid', async () => {
    const { event, version } = await openEvent('Refusals', [
      { type: 'INFORMATION', label: 'Please read', key: 'notice' },
    ]);
    const answers = answersFor(version);

    await expect(mock.mockApi.createEventEntry(event.id, [])).rejects.toMatchObject({
      code: 'FORM_REQUIRED_ANSWER_MISSING',
      status: 422,
    });

    await expect(
      mock.mockApi.createEventEntry(event.id, [...answers, answers[0]]),
    ).rejects.toMatchObject({ code: 'DUPLICATE_FORM_ANSWER' });

    await expect(
      mock.mockApi.createEventEntry(event.id, [
        ...answers,
        { questionId: crypto.randomUUID(), value: 'x' },
      ]),
    ).rejects.toMatchObject({ code: 'FORM_ANSWER_UNKNOWN_QUESTION' });

    const notice = version.steps
      .flatMap((step) => step.questions)
      .find((question) => question.key === 'notice')!;
    await expect(
      mock.mockApi.createEventEntry(event.id, [...answers, { questionId: notice.id, value: 'x' }]),
    ).rejects.toMatchObject({
      code: 'FORM_ANSWER_NOT_ALLOWED',
      fields: { reason: 'information' },
    });

    await expect(
      mock.mockApi.createEventEntry(event.id, answersFor(version, { email: 'nope' })),
    ).rejects.toMatchObject({ code: 'FORM_ANSWER_INVALID' });
  });

  it('refuses more answers than a form could hold', async () => {
    const { event } = await openEvent();
    const flood = Array.from({ length: 1000 }, () => ({
      questionId: crypto.randomUUID(),
      value: 'x',
    }));
    await expect(mock.mockApi.createEventEntry(event.id, flood)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
describe('reading entries', () => {
  it('lists only this event’s entries and searches name and email', async () => {
    const first = await openEvent('First');
    const second = await openEvent('Second');
    await mock.mockApi.createEventEntry(first.event.id, answersFor(first.version));
    await mock.mockApi.createEventEntry(
      second.event.id,
      answersFor(second.version, { first_name: 'Bob', email: 'bob@example.com' }),
    );

    const list = await mock.mockApi.listEventEntries(first.event.id);
    expect(list.total).toBe(1);
    expect(list.items[0].email).toBe('Ana@Example.com');
    expect(list.acceptingEntries).toBe(true);

    expect((await mock.mockApi.listEventEntries(first.event.id, { search: 'lop' })).total).toBe(1);
    expect((await mock.mockApi.listEventEntries(first.event.id, { search: 'ana@' })).total).toBe(1);
    expect((await mock.mockApi.listEventEntries(first.event.id, { search: 'zzz' })).total).toBe(0);
  });

  it('an entry reached through the wrong event is not found', async () => {
    const first = await openEvent('First');
    const second = await openEvent('Second');
    const created = await mock.mockApi.createEventEntry(first.event.id, answersFor(first.version));

    await expect(
      mock.mockApi.getEventEntry(second.event.id, created.entry.id),
    ).rejects.toMatchObject({ code: 'EVENT_ENTRY_NOT_FOUND' });
  });

  it('hands out detached copies, so a cached entry cannot mutate underfoot', async () => {
    const { event, version } = await openEvent();
    const created = await mock.mockApi.createEventEntry(event.id, answersFor(version));

    const first = await mock.mockApi.getEventEntry(event.id, created.entry.id);
    first.participant.firstName = 'Vandalised';
    first.answers.pop();
    if (Array.isArray(first.answers[0]?.value)) first.answers[0].value.push('x');

    const second = await mock.mockApi.getEventEntry(event.id, created.entry.id);
    expect(second.participant.firstName).toBe('Ana');
    expect(second.answers).toHaveLength(3);
    expect(second.answers[0]).not.toBe(first.answers[0]);
  });
});

// ---------------------------------------------------------------------------
describe('session and dependency parity', () => {
  it('every entry call requires a session', async () => {
    const { event, version } = await openEvent();
    const answers = answersFor(version);
    const created = await mock.mockApi.createEventEntry(event.id, answers);

    vi.resetModules();
    const anonymous = await freshMock(false);
    for (const call of [
      () => anonymous.mockApi.listEventEntries(event.id),
      () => anonymous.mockApi.getEventEntry(event.id, created.entry.id),
      () => anonymous.mockApi.createEventEntry(event.id, answers),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 401 });
    }
  });

  it('an event with entries can never be deleted', async () => {
    const { event, version } = await openEvent();
    await mock.mockApi.createEventEntry(event.id, answersFor(version));
    await expect(mock.mockApi.deleteEvent(event.id)).rejects.toMatchObject({
      code: 'EVENT_CANNOT_BE_DELETED',
    });
  });
});

// ---------------------------------------------------------------------------
describe('parity for the rules the validation added', () => {
  it('refuses a date of birth in the future, exactly as the server does', async () => {
    const { event, version } = await openEvent('Future DOB', [
      { type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth' },
    ]);
    const future = new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10);

    await expect(
      mock.mockApi.createEventEntry(event.id, answersFor(version, { date_of_birth: future })),
    ).rejects.toMatchObject({ code: 'FORM_ANSWER_INVALID' });

    // A plain DATE question is unaffected: the rule belongs to the system field.
    const plain = await openEvent('Future date', [
      { type: 'DATE', label: 'Preferred date', key: 'preferred_date' },
    ]);
    await expect(
      mock.mockApi.createEventEntry(
        plain.event.id,
        answersFor(plain.version, { preferred_date: future }),
      ),
    ).resolves.toMatchObject({ answerCount: 4 });
  });

  it('an empty array is absence for a multi-select and a WRONG SHAPE elsewhere', async () => {
    const { event, version } = await openEvent('Shapes', [
      { type: 'YES_NO', label: 'Smoker', key: 'smoker' },
      {
        type: 'MULTI_SELECT',
        label: 'Diet',
        key: 'diet',
        options: [
          { value: 'vegan', label: 'Vegan' },
          { value: 'halal', label: 'Halal' },
        ],
      },
    ]);

    // Nothing selected: a legitimate answer to "which of these?", stored as no
    // row rather than as an empty list.
    const created = await mock.mockApi.createEventEntry(
      event.id,
      answersFor(version, { diet: [] }),
    );
    expect(created.answerCount).toBe(3);

    // The same shape sent to a yes/no question is garbage, and is refused
    // rather than quietly treated as "did not answer".
    const other = await openEvent('Shapes two', [
      { type: 'YES_NO', label: 'Smoker', key: 'smoker' },
    ]);
    await expect(
      mock.mockApi.createEventEntry(
        other.event.id,
        answersFor(other.version, { smoker: [], email: 'b@example.com' }),
      ),
    ).rejects.toMatchObject({ code: 'FORM_ANSWER_INVALID' });
  });
});

// ---------------------------------------------------------------------------
describe('the decision, decided the same way', () => {
  /** The client's form, with an age rule set directly on the mock event. */
  async function gatedEvent(name: string, minimumAge: number | null) {
    const seeded = await openEvent(name, [
      { type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth' },
      {
        type: 'SINGLE_SELECT',
        label: 'Do you smoke?',
        key: 'smoker_status',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      },
    ]);
    mock.setEventStatus(seeded.event.id, 'OPEN', { minimumAge });
    return seeded;
  }

  function dobForAge(years: number): string {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const [year, month, day] = today.split('-');
    return `${Number(year) - years}-${month}-${day}`;
  }

  it('21 is eligible and 20 is recorded as ineligible', async () => {
    const older = await gatedEvent('Old enough', 21);
    const eligible = await mock.mockApi.createEventEntry(
      older.event.id,
      answersFor(older.version, { date_of_birth: dobForAge(21), smoker_status: 'yes' }),
    );
    expect(eligible.entry.status).toBe('ELIGIBLE');
    expect(eligible.entry.calculatedAge).toBe(21);
    expect(eligible.entry.ageEligible).toBe(true);
    expect(eligible.entry.eligibilityReason).toBe('ELIGIBLE');

    const younger = await gatedEvent('Too young', 21);
    const ineligible = await mock.mockApi.createEventEntry(
      younger.event.id,
      answersFor(younger.version, {
        date_of_birth: dobForAge(20),
        smoker_status: 'no',
        email: 'young@example.com',
      }),
    );
    // Recorded, not refused — exactly as the server does.
    expect(ineligible.entry.status).toBe('INELIGIBLE');
    expect(ineligible.entry.calculatedAge).toBe(20);
    expect(ineligible.entry.ageEligible).toBe(false);
    expect(ineligible.entry.eligibilityReason).toBe('AGE_REQUIREMENT_NOT_MET');
    expect(ineligible.answerCount).toBe(5);
  });

  it('an event with no age rule judges nothing', async () => {
    const seeded = await gatedEvent('No rule', null);
    const created = await mock.mockApi.createEventEntry(
      seeded.event.id,
      answersFor(seeded.version, { date_of_birth: dobForAge(30), smoker_status: 'no' }),
    );
    expect(created.entry.overallEligible).toBe(true);
    // The age is recorded; the JUDGEMENT is absent.
    expect(created.entry.calculatedAge).toBe(30);
    expect(created.entry.ageEligible).toBeNull();
  });

  it('refuses an impossible date of birth with the same code', async () => {
    const seeded = await gatedEvent('Bad date', 21);
    await expect(
      mock.mockApi.createEventEntry(
        seeded.event.id,
        answersFor(seeded.version, { date_of_birth: '1800-01-01' }),
      ),
    ).rejects.toMatchObject({ code: 'DATE_OF_BIRTH_INVALID', status: 400 });
  });

  it('refuses a timezone the runtime cannot resolve', async () => {
    const seeded = await gatedEvent('Bad zone', 21);
    mock.setEventStatus(seeded.event.id, 'OPEN', {
      minimumAge: 21,
      timezone: 'Mars/Olympus_Mons',
    });
    await expect(
      mock.mockApi.createEventEntry(
        seeded.event.id,
        answersFor(seeded.version, { date_of_birth: dobForAge(30) }),
      ),
    ).rejects.toMatchObject({ code: 'FORM_VERSION_INVALID' });
  });

  it('the listing carries the verdict', async () => {
    const seeded = await gatedEvent('Listed', 21);
    await mock.mockApi.createEventEntry(
      seeded.event.id,
      answersFor(seeded.version, { date_of_birth: dobForAge(19), smoker_status: 'no' }),
    );
    const list = await mock.mockApi.listEventEntries(seeded.event.id);
    expect(list.items[0].status).toBe('INELIGIBLE');
    expect(list.items[0].calculatedAge).toBe(19);
    expect(list.items[0].eligibilityReason).toBe('AGE_REQUIREMENT_NOT_MET');
  });

  it('smoking is data, never a rule', async () => {
    const seeded = await gatedEvent('Habits', 21);
    const created = await mock.mockApi.createEventEntry(
      seeded.event.id,
      answersFor(seeded.version, { date_of_birth: dobForAge(40), smoker_status: 'yes' }),
    );
    expect(created.entry.overallEligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the age is computed in the EVENT’s timezone, here too', () => {
  it('the same instant makes the same person a different age in two events', async () => {
    // 03:30 UTC on the 8th: still the 7th in New York, already the 8th in
    // Tokyo. Somebody whose 21st birthday is the 8th passes in one and not the
    // other — from one submission instant. Computing in UTC would get New York
    // wrong for five hours every night.
    mock.setClock(new Date('2026-08-08T03:30:00.000Z'));

    const dob = { type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth' };
    const tokyo = await openEvent('Tokyo', [dob]);
    mock.setEventStatus(tokyo.event.id, 'OPEN', { minimumAge: 21, timezone: 'Asia/Tokyo' });
    const newYork = await openEvent('New York', [dob]);
    mock.setEventStatus(newYork.event.id, 'OPEN', {
      minimumAge: 21,
      timezone: 'America/New_York',
    });

    const inTokyo = await mock.mockApi.createEventEntry(
      tokyo.event.id,
      answersFor(tokyo.version, { date_of_birth: '2005-08-08' }),
    );
    const inNewYork = await mock.mockApi.createEventEntry(
      newYork.event.id,
      answersFor(newYork.version, { date_of_birth: '2005-08-08' }),
    );

    expect(inTokyo.entry.calculatedAge).toBe(21);
    expect(inTokyo.entry.status).toBe('ELIGIBLE');
    expect(inNewYork.entry.calculatedAge).toBe(20);
    expect(inNewYork.entry.status).toBe('INELIGIBLE');
    expect(inNewYork.entry.eligibilityReason).toBe('AGE_REQUIREMENT_NOT_MET');

    mock.setClock(null);
  });

  it('the time of day does not move the answer within one local day', async () => {
    const dob = { type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth' };
    const ages: number[] = [];

    // 00:01 and 23:59 local in New York, on the same local day.
    for (const instant of ['2026-08-07T04:01:00.000Z', '2026-08-08T03:59:00.000Z']) {
      mock.setClock(new Date(instant));
      const seeded = await openEvent(`At ${instant}`, [dob]);
      mock.setEventStatus(seeded.event.id, 'OPEN', {
        minimumAge: 21,
        timezone: 'America/New_York',
      });
      const created = await mock.mockApi.createEventEntry(
        seeded.event.id,
        answersFor(seeded.version, {
          date_of_birth: '2005-08-07',
          email: `at-${instant}@example.com`,
        }),
      );
      ages.push(created.entry.calculatedAge!);
    }

    expect(ages[0]).toBe(ages[1]);
    mock.setClock(null);
  });
});
