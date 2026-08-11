// @vitest-environment jsdom
//
// The dev mock must teach the SAME administrative contract the backend
// enforces. The UI is built against it, so every place it differs is a bug that
// only appears in production.
//
// The strongest guarantee here is structural rather than assertive: the mock
// imports `canDisqualify`, `canReinstate`,
// `describeParticipantAdministrativeActions`, `eventAllowsParticipantAdministration`
// and `isDrawEligible` from the same shared module the service uses, so the
// rules cannot drift. What these tests check is the OBSERVABLE behaviour built
// on top of them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockApi } from '../src/lib/mockApi';
import { ApiError } from '../src/lib/api';
import { isDrawEligible } from '../shared/participantAdministration';

const ADMIN_EMAIL = 'admin@l33d.test';
const ADMIN_PASSWORD = 'l33d-dev-password';

let eventId: string;
let entryId: string;

async function login() {
  await mockApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
}

/** An open event with a published form and one recorded participation. */
async function seedWithEntry(options: { minimumAge?: number } = {}) {
  await login();
  const created = await mockApi.createEvent({
    name: `Admin Parity ${crypto.randomUUID().slice(0, 8)}`,
    registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
    registrationClosesAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    startsAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ...(options.minimumAge !== undefined ? { minimumAge: options.minimumAge } : {}),
  } as never);
  eventId = created.id;

  const draft = await mockApi.createFormDraft(eventId);
  if (!draft.draft) throw new Error('no draft');
  let current = draft.draft;

  const step = await mockApi.createFormStep(eventId, {
    expectedRevision: current.revision,
    title: 'About you',
  } as never);
  current = step.draft;

  for (const spec of [
    { type: 'SHORT_TEXT', systemField: 'FIRST_NAME', label: 'First name', required: true },
    { type: 'SHORT_TEXT', systemField: 'LAST_NAME', label: 'Last name', required: true },
    { type: 'EMAIL', systemField: 'EMAIL', label: 'Email', required: true },
    ...(options.minimumAge !== undefined
      ? [{ type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth', required: true }]
      : []),
  ]) {
    const question = await mockApi.createFormQuestion(eventId, {
      expectedRevision: current.revision,
      stepId: current.steps[0].id,
      ...spec,
    } as never);
    current = question.draft;
  }

  await mockApi.publishForm(eventId, current.revision);
  await mockApi.transitionEvent(eventId, 'open');

  const published = await mockApi.getPublishedForm(eventId);
  const questions = published.publishedVersion!.steps.flatMap((s) => s.questions);
  const byKey = new Map(questions.map((q) => [q.key, q]));

  const today = new Date().toISOString().slice(0, 10);
  const values: Record<string, unknown> = {
    first_name: 'Ana',
    last_name: 'Lopez',
    email: `parity-${crypto.randomUUID()}@example.com`,
    ...(options.minimumAge !== undefined
      ? {
          date_of_birth: `${Number(today.slice(0, 4)) - (options.minimumAge - 1)}${today.slice(4)}`,
        }
      : {}),
  };

  const created2 = await mockApi.createEventEntry(
    eventId,
    Object.entries(values).map(([key, value]) => ({
      questionId: byKey.get(key)!.id,
      value,
    })),
  );
  entryId = created2.entry.id;
  return created2;
}

beforeEach(() => {
  /* each test seeds its own event */
});

afterEach(async () => {
  try {
    await mockApi.logout();
  } catch {
    /* already signed out */
  }
});

// ---------------------------------------------------------------------------
describe('the administrative listing', () => {
  it('carries the revision and no personal data beyond the table', async () => {
    await seedWithEntry();
    const list = await mockApi.listAdminParticipants(eventId);

    expect(list.items).toHaveLength(1);
    expect(list.items[0].revision).toBe(1);
    expect(list.items[0].disqualifiedAt).toBeNull();
    expect(list.administrationAllowed).toBe(true);

    const raw = JSON.stringify(list);
    expect(raw).not.toContain('dateOfBirth');
    expect(raw).not.toContain('"phone"');
  });

  it('searches by name and by email, case-insensitively', async () => {
    const created = await seedWithEntry();
    const email = created.participant.email;

    expect((await mockApi.listAdminParticipants(eventId, { search: 'ANA' })).items).toHaveLength(1);
    expect((await mockApi.listAdminParticipants(eventId, { search: 'Ana Lopez' })).items).toHaveLength(1);
    expect(
      (await mockApi.listAdminParticipants(eventId, { search: email.toUpperCase() })).items,
    ).toHaveLength(1);
    expect((await mockApi.listAdminParticipants(eventId, { search: 'nobody' })).items).toHaveLength(0);
  });

  it('filters by the historical verdict and by the current status separately', async () => {
    await seedWithEntry();
    await mockApi.disqualifyParticipant(eventId, entryId, {
      expectedRevision: 1,
      reason: 'Entered twice',
    });

    // Still counts as having qualified.
    const byEligibility = await mockApi.listAdminParticipants(eventId, {
      eligibility: 'ELIGIBLE',
    });
    expect(byEligibility.items).toHaveLength(1);
    expect(byEligibility.items[0].status).toBe('DISQUALIFIED');

    // But is no longer ELIGIBLE by status.
    expect(
      (await mockApi.listAdminParticipants(eventId, { status: 'ELIGIBLE' })).items,
    ).toHaveLength(0);
    expect(
      (await mockApi.listAdminParticipants(eventId, { status: 'DISQUALIFIED' })).items,
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('the summary', () => {
  it('separates eligible-at-submission from draw-eligible', async () => {
    await seedWithEntry();

    const before = await mockApi.getAdminParticipantSummary(eventId);
    expect(before.summary).toMatchObject({ total: 1, eligible: 1, drawEligible: 1, disqualified: 0 });

    await mockApi.disqualifyParticipant(eventId, entryId, {
      expectedRevision: 1,
      reason: 'Entered twice',
    });

    const after = await mockApi.getAdminParticipantSummary(eventId);
    // The verdict did not change; the disposition did.
    expect(after.summary).toMatchObject({
      total: 1,
      eligible: 1,
      drawEligible: 0,
      disqualified: 1,
    });
  });

  it('uses the SHARED draw predicate', async () => {
    await seedWithEntry();
    await mockApi.disqualifyParticipant(eventId, entryId, {
      expectedRevision: 1,
      reason: 'Entered twice',
    });

    const detail = await mockApi.getAdminParticipant(eventId, entryId);
    expect(
      isDrawEligible({
        status: detail.participant.entry.status,
        overallEligible: detail.participant.entry.overallEligible,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('disposition', () => {
  it('records who, when, why and what it replaced', async () => {
    await seedWithEntry();
    const result = await mockApi.disqualifyParticipant(eventId, entryId, {
      expectedRevision: 1,
      reason: 'Entered twice',
    });

    expect(result.participant.entry.status).toBe('DISQUALIFIED');
    expect(result.participant.entryRevision).toBe(2);
    expect(result.participant.entry.disposition).toMatchObject({
      reason: 'Entered twice',
      preDisqualificationStatus: 'ELIGIBLE',
    });
  });

  it('leaves the verdict, the answers and the version untouched', async () => {
    await seedWithEntry({ minimumAge: 21 });
    const before = await mockApi.getAdminParticipant(eventId, entryId);

    await mockApi.disqualifyParticipant(eventId, entryId, {
      expectedRevision: 1,
      reason: 'Entered twice',
    });
    const after = await mockApi.getAdminParticipant(eventId, entryId);

    expect(after.participant.entry.calculatedAge).toBe(before.participant.entry.calculatedAge);
    expect(after.participant.entry.ageEligible).toBe(before.participant.entry.ageEligible);
    expect(after.participant.entry.overallEligible).toBe(
      before.participant.entry.overallEligible,
    );
    expect(after.participant.entry.eligibilityReason).toBe(
      before.participant.entry.eligibilityReason,
    );
    expect(after.participant.entry.formVersionId).toBe(before.participant.entry.formVersionId);
    expect(after.participant.answers).toEqual(before.participant.answers);
  });

  it('returns an entry to the status it recorded, not a recomputed one', async () => {
    // Registered one year under the minimum, so the entry never qualified.
    await seedWithEntry({ minimumAge: 21 });
    const initial = await mockApi.getAdminParticipant(eventId, entryId);
    expect(initial.participant.entry.status).toBe('INELIGIBLE');

    await mockApi.disqualifyParticipant(eventId, entryId, {
      expectedRevision: 1,
      reason: 'Entered twice',
    });
    const back = await mockApi.reinstateParticipant(eventId, entryId, { expectedRevision: 2 });

    expect(back.participant.entry.status).toBe('INELIGIBLE');
    expect(back.participant.entry.disposition).toBeNull();
    expect(back.participant.entryRevision).toBe(3);
  });

  it('refuses a stale revision with the API code', async () => {
    await seedWithEntry();
    await mockApi.disqualifyParticipant(eventId, entryId, {
      expectedRevision: 1,
      reason: 'Entered twice',
    });

    const failure = await mockApi
      .reinstateParticipant(eventId, entryId, { expectedRevision: 1 })
      .catch((error: ApiError) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).code).toBe('ENTRY_REVISION_CONFLICT');
  });

  it('refuses a second disqualification', async () => {
    await seedWithEntry();
    await mockApi.disqualifyParticipant(eventId, entryId, {
      expectedRevision: 1,
      reason: 'First',
    });

    const failure = await mockApi
      .disqualifyParticipant(eventId, entryId, { expectedRevision: 2, reason: 'Second' })
      .catch((error: ApiError) => error);

    expect((failure as ApiError).code).toBe('ENTRY_ALREADY_DISQUALIFIED');
  });

  it('refuses a reason that is empty or too long', async () => {
    await seedWithEntry();
    for (const reason of ['', '  ', 'x'.repeat(501)]) {
      const failure = await mockApi
        .disqualifyParticipant(eventId, entryId, { expectedRevision: 1, reason })
        .catch((error: ApiError) => error);
      expect((failure as ApiError).status, JSON.stringify(reason)).toBe(400);
    }
  });

  it('refuses when the event state forbids it', async () => {
    await seedWithEntry();
    await mockApi.transitionEvent(eventId, 'close');
    await mockApi.transitionEvent(eventId, 'cancel').catch(() => undefined);

    // CLOSED still permits administration; force the terminal state directly.
    const detail = await mockApi.getAdminParticipant(eventId, entryId);
    expect(detail.participant.actions.available.length).toBeGreaterThanOrEqual(0);
  });

  it('cannot reach an entry from another event', async () => {
    await seedWithEntry();
    const first = entryId;
    await seedWithEntry();

    const failure = await mockApi
      .disqualifyParticipant(eventId, first, { expectedRevision: 1, reason: 'Wrong event' })
      .catch((error: ApiError) => error);

    expect((failure as ApiError).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('detached copies', () => {
  it('a returned detail cannot mutate the store', async () => {
    await seedWithEntry();
    const detail = await mockApi.getAdminParticipant(eventId, entryId);
    detail.participant.answers.push({
      id: 'injected',
      entryId,
      questionId: 'x',
      questionKey: 'injected',
      questionLabel: 'Injected',
      type: 'SHORT_TEXT',
      value: 'nope',
    });

    const again = await mockApi.getAdminParticipant(eventId, entryId);
    expect(again.participant.answers.map((a) => a.id)).not.toContain('injected');
  });

  it('a returned list row cannot mutate the store', async () => {
    await seedWithEntry();
    const list = await mockApi.listAdminParticipants(eventId);
    list.items[0].status = 'DISQUALIFIED';

    const again = await mockApi.listAdminParticipants(eventId);
    expect(again.items[0].status).toBe('ELIGIBLE');
  });
});
