// @vitest-environment node
//
// The public projection: what a visitor is told, and what they are never told.

import { describe, expect, it } from 'vitest';
import {
  derivePublicEventStatus,
  isPubliclyAskable,
  publicStatusAcceptsEntries,
  publicVisibility,
  toPublicEventDto,
  toPublicFormDto,
  toPublicPrizeDtos,
} from '../shared/publicEvent';
import { EVENT_STATUSES } from '../shared/eventLifecycle';
import { entryWindowProblem } from '../shared/entryLifecycle';
import type { Event, EventPrize, FormQuestion, FormStep } from '../shared/types';

const NOW = '2026-05-10T12:00:00.000Z';
const EARLIER = '2026-05-01T00:00:00.000Z';
const LATER = '2026-05-20T00:00:00.000Z';

function statusInput(overrides: Partial<Parameters<typeof derivePublicEventStatus>[0]> = {}) {
  return {
    status: 'OPEN' as const,
    registrationOpensAt: EARLIER,
    registrationClosesAt: LATER,
    hasServableForm: true,
    ...overrides,
  };
}

describe('visibility', () => {
  it('hides exactly DRAFT and ARCHIVED', () => {
    // A draft would leak a slug and a name before anybody announced them; an
    // archived event was filed away deliberately. Both answer 404, which is the
    // same answer an unused slug gives.
    for (const status of EVENT_STATUSES) {
      const expected = status === 'DRAFT' || status === 'ARCHIVED' ? 'hidden' : 'visible';
      expect(publicVisibility(status), status).toBe(expected);
    }
  });
});

describe('derived status', () => {
  it('is OPEN only when the state, the window and a servable form all agree', () => {
    expect(derivePublicEventStatus(statusInput(), NOW)).toBe('OPEN');
  });

  it('is UPCOMING while the window has not started', () => {
    expect(
      derivePublicEventStatus(statusInput({ registrationOpensAt: LATER }), NOW),
    ).toBe('UPCOMING');
  });

  it('is UPCOMING for a SCHEDULED event regardless of its dates', () => {
    expect(
      derivePublicEventStatus(
        statusInput({ status: 'SCHEDULED', registrationOpensAt: EARLIER }),
        NOW,
      ),
    ).toBe('UPCOMING');
  });

  it('is CLOSED once the window has ended', () => {
    expect(
      derivePublicEventStatus(statusInput({ registrationClosesAt: EARLIER }), NOW),
    ).toBe('CLOSED');
  });

  it('treats the boundaries exactly as the entry guard does', () => {
    // `opens <= now < closes`. A page that says OPEN while the POST guard says
    // REGISTRATION_CLOSED is a page that invites somebody to fail.
    const opensNow = statusInput({ registrationOpensAt: NOW });
    expect(derivePublicEventStatus(opensNow, NOW)).toBe('OPEN');
    expect(entryWindowProblem(opensNow, NOW)).toBeNull();

    const closesNow = statusInput({ registrationClosesAt: NOW });
    expect(derivePublicEventStatus(closesNow, NOW)).toBe('CLOSED');
    expect(entryWindowProblem(closesNow, NOW)).toBe('REGISTRATION_CLOSED');
  });

  it('is UNAVAILABLE — never CLOSED — when an open event has no servable form', () => {
    // Telling somebody they are too late when the truth is "we are broken" is a
    // lie that also hides the fault from whoever could fix it.
    expect(
      derivePublicEventStatus(statusInput({ hasServableForm: false }), NOW),
    ).toBe('UNAVAILABLE');
  });

  it('is CANCELLED whatever the dates say', () => {
    expect(
      derivePublicEventStatus(
        statusInput({ status: 'CANCELLED', registrationClosesAt: LATER }),
        NOW,
      ),
    ).toBe('CANCELLED');
  });

  it('collapses the draw states into CLOSED', () => {
    // Operational detail that means nothing to a participant and would disclose
    // the organiser's timetable.
    for (const status of ['CLOSED', 'DRAW_READY', 'DRAW_COMPLETED'] as const) {
      expect(derivePublicEventStatus(statusInput({ status }), NOW), status).toBe('CLOSED');
    }
  });

  it('accepts entries in OPEN and in nothing else', () => {
    expect(publicStatusAcceptsEntries('OPEN')).toBe(true);
    for (const status of ['UPCOMING', 'CLOSED', 'CANCELLED', 'UNAVAILABLE'] as const) {
      expect(publicStatusAcceptsEntries(status), status).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

function question(overrides: Partial<FormQuestion> = {}): FormQuestion {
  return {
    id: 'q1',
    ownerType: 'VERSION',
    ownerId: 'v1',
    stepId: 's1',
    key: 'first_name',
    systemField: 'FIRST_NAME',
    type: 'SHORT_TEXT',
    label: 'First name',
    description: null,
    placeholder: null,
    required: true,
    active: true,
    exportable: true,
    sortOrder: 0,
    validation: null,
    options: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function step(overrides: Partial<FormStep> = {}): FormStep {
  return {
    id: 's1',
    ownerType: 'VERSION',
    ownerId: 'v1',
    title: 'About you',
    description: null,
    sortOrder: 0,
    questions: [question()],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('form projection', () => {
  it('drops inactive questions', () => {
    // Publishing PRESERVES inactive questions, so a version legitimately holds
    // questions nobody should be asked.
    const projected = toPublicFormDto(3, [
      step({
        questions: [question(), question({ id: 'q2', key: 'ghost', active: false })],
      }),
    ]);

    expect(projected.ok).toBe(true);
    if (!projected.ok) throw new Error('unreachable');
    expect(projected.form.steps[0].questions.map((q) => q.id)).toEqual(['q1']);
    expect(isPubliclyAskable(question({ active: false }))).toBe(false);
  });

  it('drops inactive options', () => {
    const projected = toPublicFormDto(1, [
      step({
        questions: [
          question({
            type: 'SINGLE_SELECT',
            options: [
              { id: 'o1', questionId: 'q1', value: 'yes', label: 'Yes', sortOrder: 0, active: true, createdAt: NOW, updatedAt: NOW },
              { id: 'o2', questionId: 'q1', value: 'no', label: 'No', sortOrder: 1, active: false, createdAt: NOW, updatedAt: NOW },
            ],
          }),
        ],
      }),
    ]);

    if (!projected.ok) throw new Error('unreachable');
    expect(projected.form.steps[0].questions[0].options).toEqual([
      { value: 'yes', label: 'Yes' },
    ]);
  });

  it('refuses a step left with nothing askable rather than hiding it', () => {
    // A published version is immutable, so this means something wrote outside
    // the application. Rendering the remains would ask people to fill in a form
    // that is not the one published.
    const projected = toPublicFormDto(1, [
      step({ questions: [question({ active: false })] }),
    ]);
    expect(projected).toEqual({ ok: false, problem: 'EMPTY_STEP' });
  });

  it('refuses a version with no steps at all', () => {
    expect(toPublicFormDto(1, [])).toEqual({ ok: false, problem: 'NO_QUESTIONS' });
  });

  it('orders steps and questions by sortOrder, not by arrival', () => {
    const projected = toPublicFormDto(1, [
      step({
        id: 'b',
        sortOrder: 1,
        questions: [question({ id: 'q3', sortOrder: 0 })],
      }),
      step({
        id: 'a',
        sortOrder: 0,
        questions: [
          question({ id: 'q2', sortOrder: 1 }),
          question({ id: 'q1', sortOrder: 0 }),
        ],
      }),
    ]);

    if (!projected.ok) throw new Error('unreachable');
    expect(projected.form.steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(projected.form.steps[0].questions.map((q) => q.id)).toEqual(['q1', 'q2']);
  });

  it('never carries ownerType, ownerId, active, exportable or timestamps', () => {
    const projected = toPublicFormDto(1, [step()]);
    if (!projected.ok) throw new Error('unreachable');
    const serialized = JSON.stringify(projected.form);

    for (const leak of ['ownerType', 'ownerId', 'active', 'exportable', 'createdAt', 'updatedAt']) {
      expect(serialized, leak).not.toContain(`"${leak}"`);
    }
  });
});

// ---------------------------------------------------------------------------

function prize(overrides: Partial<EventPrize> = {}): EventPrize {
  return {
    id: 'p1',
    eventId: 'e1',
    name: 'A prize',
    description: null,
    imageUrl: null,
    quantity: 1,
    sortOrder: 0,
    status: 'ACTIVE',
    revision: 1,
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

describe('prize projection', () => {
  it('offers ACTIVE prizes only', () => {
    const projected = toPublicPrizeDtos([
      prize({ id: 'p1', name: 'Live' }),
      prize({ id: 'p2', name: 'Parked', status: 'INACTIVE' }),
      prize({ id: 'p3', name: 'Withdrawn', status: 'ARCHIVED', archivedAt: NOW }),
    ]);
    expect(projected.map((p) => p.name)).toEqual(['Live']);
  });

  it('orders by sortOrder', () => {
    const projected = toPublicPrizeDtos([
      prize({ id: 'p2', name: 'Second', sortOrder: 1 }),
      prize({ id: 'p1', name: 'First', sortOrder: 0 }),
    ]);
    expect(projected.map((p) => p.name)).toEqual(['First', 'Second']);
  });

  it('exposes five fields and no identifiers', () => {
    const [projected] = toPublicPrizeDtos([prize()]);
    expect(Object.keys(projected).sort()).toEqual([
      'description',
      'imageUrl',
      'name',
      'quantity',
      'sortOrder',
    ]);
  });

  it('an event with no prizes is legitimate', () => {
    expect(toPublicPrizeDtos([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const EVENT: Event = {
  id: 'internal-event-id',
  slug: 'summer-giveaway',
  name: 'Summer Giveaway',
  description: 'Come along',
  bannerUrl: null,
  locationName: 'Miami',
  timezone: 'America/New_York',
  registrationOpensAt: EARLIER,
  registrationClosesAt: LATER,
  startsAt: LATER,
  endsAt: LATER,
  minimumAge: 21,
  maxEntriesPerIdentity: 1,
  status: 'OPEN',
  confirmationTitle: 'You are in',
  confirmationMessage: 'Good luck',
  ineligibleTitle: 'Sorry',
  ineligibleMessage: 'You must be 21',
  revision: 7,
  createdBy: 'admin-1',
  updatedBy: 'admin-2',
  createdAt: EARLIER,
  updatedAt: NOW,
  publishedAt: EARLIER,
  openedAt: EARLIER,
  closedAt: null,
  cancelledAt: null,
  archivedAt: null,
  publishedFormVersionId: 'version-9',
};

describe('event projection', () => {
  const dto = toPublicEventDto({
    event: EVENT,
    registrationStatus: 'OPEN',
    form: null,
    prizes: [],
    formToken: 'v1.x.y',
  });

  it('carries what a visitor needs', () => {
    expect(dto.slug).toBe('summer-giveaway');
    expect(dto.name).toBe('Summer Giveaway');
    expect(dto.minimumAge).toBe(21);
    expect(dto.registrationStatus).toBe('OPEN');
    expect(dto.messages.confirmationTitle).toBe('You are in');
  });

  it('never carries the internal id, the revision or any actor', () => {
    // The public flow addresses an event by slug and carries the id only inside
    // the signed token, so a scraped page yields nothing pasteable into an
    // administrative URL.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('internal-event-id');
    expect(serialized).not.toContain('admin-1');
    expect(serialized).not.toContain('admin-2');
    expect(serialized).not.toContain('version-9');
    expect(serialized).not.toContain('"revision"');
    expect(serialized).not.toContain('maxEntriesPerIdentity');
  });

  it('exposes a fixed key set — a new Event column cannot leak by default', () => {
    expect(Object.keys(dto).sort()).toEqual([
      'bannerUrl',
      'description',
      'endsAt',
      'formToken',
      'form',
      'locationName',
      'messages',
      'minimumAge',
      'name',
      'prizes',
      'registrationClosesAt',
      'registrationOpensAt',
      'registrationStatus',
      'slug',
      'startsAt',
      'timezone',
    ].sort());
  });
});
