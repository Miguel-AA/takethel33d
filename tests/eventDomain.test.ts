// @vitest-environment node
//
// Slug rules, the state machine and the shared event schemas.

import { describe, expect, it } from 'vitest';
import {
  RESERVED_SLUGS,
  checkSlug,
  isReservedSlug,
  isValidSlug,
  slugify,
  withSuffix,
} from '../shared/slug';
import {
  ACTION_SOURCES,
  ACTION_TARGET,
  EDITABLE_FIELDS_BY_STATUS,
  EVENT_STATUSES,
  EVENT_TRANSITION_ACTIONS,
  allowedActions,
  canTransition,
  isEditable,
  isPhysicallyDeletable,
  type EventStatus,
} from '../shared/eventLifecycle';
import {
  createEventSchema,
  duplicateEventSchema,
  eventListQuerySchema,
  eventTransitionSchema,
  updateEventSchema,
} from '../shared/schemas';

describe('slugify', () => {
  it('derives a usable address from a name', () => {
    expect(slugify('Grand Opening Smoke Shop')).toBe('grand-opening-smoke-shop');
    expect(slugify('Summer Giveaway 2026')).toBe('summer-giveaway-2026');
  });

  it('folds accents rather than dropping them', () => {
    // A Spanish name must not collapse into hyphens.
    expect(slugify('Ñandú del Año')).toBe('nandu-del-ano');
    expect(slugify('Café Münchén')).toBe('cafe-munchen');
  });

  it('collapses separators and trims edges', () => {
    expect(slugify('  --Events--  2026  ')).toBe('events-2026');
    expect(slugify('a///b')).toBe('a-b');
    expect(slugify('!!!')).toBe('');
  });
});

describe('slug validation', () => {
  it('accepts well-formed slugs, including short ones', () => {
    // A short slug is legal: an event named "Q1" must still get an address.
    for (const slug of ['grand-opening-smoke-shop', 'summer-giveaway-2026', 'abc', 'q1', 'x']) {
      expect(isValidSlug(slug), slug).toBe(true);
    }
  });

  it('rejects malformed slugs', () => {
    for (const slug of [
      'Grand Opening',
      '-events',
      'events-',
      'events--2026',
      '../../admin',
      'UPPER',
      'has space',
      'sym#bol',
      '',
      null,
      123,
      'x'.repeat(81),
    ]) {
      expect(isValidSlug(slug), String(slug)).toBe(false);
    }
  });

  it('rejects reserved application routes', () => {
    for (const slug of ['api', 'manager', 'events', 'admin', 'login', 'audit']) {
      expect(isReservedSlug(slug), slug).toBe(true);
      expect(checkSlug(slug)).toEqual({ ok: false, reason: 'reserved' });
    }
    expect(RESERVED_SLUGS.has('api')).toBe(true);
  });

  it('reports invalid and reserved distinctly', () => {
    expect(checkSlug('Not Valid')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkSlug('manager')).toEqual({ ok: false, reason: 'reserved' });
    expect(checkSlug('real-event')).toEqual({ ok: true, slug: 'real-event' });
  });

  it('withSuffix stays within the length limit', () => {
    expect(withSuffix('summer-giveaway', 2)).toBe('summer-giveaway-2');
    const long = 'a'.repeat(80);
    expect(withSuffix(long, 12).length).toBeLessThanOrEqual(80);
  });
});

describe('state machine', () => {
  it('permits exactly the approved transitions', () => {
    const expected: Record<EventStatus, EventStatus[]> = {
      DRAFT: ['SCHEDULED', 'OPEN', 'CANCELLED', 'ARCHIVED'],
      SCHEDULED: ['OPEN', 'CANCELLED', 'ARCHIVED'],
      OPEN: ['CLOSED', 'CANCELLED', 'ARCHIVED'],
      CLOSED: ['DRAW_READY', 'ARCHIVED'],
      DRAW_READY: ['ARCHIVED'],
      DRAW_COMPLETED: ['ARCHIVED'],
      CANCELLED: ['ARCHIVED'],
      ARCHIVED: [],
    };

    for (const status of EVENT_STATUSES) {
      const actual = allowedActions(status).map((action) => ACTION_TARGET[action]);
      expect(actual.sort(), status).toEqual(expected[status].sort());
    }
  });

  it('refuses every forbidden move', () => {
    // No path back to DRAFT.
    for (const action of EVENT_TRANSITION_ACTIONS) {
      expect(ACTION_TARGET[action]).not.toBe('DRAFT');
    }
    // CLOSED cannot reopen.
    expect(canTransition('CLOSED', 'open')).toBe(false);
    // OPEN cannot go back to scheduled.
    expect(canTransition('OPEN', 'publish')).toBe(false);
    // Terminal states.
    for (const action of EVENT_TRANSITION_ACTIONS) {
      expect(canTransition('ARCHIVED', action), `ARCHIVED -> ${action}`).toBe(false);
    }
    expect(canTransition('CANCELLED', 'open')).toBe(false);
    expect(canTransition('CANCELLED', 'close')).toBe(false);
    // DRAW_COMPLETED is only reachable by a draw, which does not exist yet.
    for (const action of EVENT_TRANSITION_ACTIONS) {
      expect(ACTION_TARGET[action]).not.toBe('DRAW_COMPLETED');
    }
    // A cancelled event may still be filed away.
    expect(canTransition('CANCELLED', 'archive')).toBe(true);
  });

  it('every action declares its sources', () => {
    for (const action of EVENT_TRANSITION_ACTIONS) {
      expect(ACTION_SOURCES[action].length, action).toBeGreaterThan(0);
    }
  });
});

describe('edit policy', () => {
  it('a draft is fully editable', () => {
    expect(EDITABLE_FIELDS_BY_STATUS.DRAFT).toContain('slug');
    expect(EDITABLE_FIELDS_BY_STATUS.DRAFT).toContain('minimumAge');
    expect(isEditable('DRAFT')).toBe(true);
  });

  it('freezes the slug once the event leaves draft', () => {
    for (const status of EVENT_STATUSES.filter((s) => s !== 'DRAFT')) {
      expect(EDITABLE_FIELDS_BY_STATUS[status], status).not.toContain('slug');
    }
  });

  it('freezes participation rules once open', () => {
    for (const field of [
      'minimumAge',
      'maxEntriesPerIdentity',
      'timezone',
      'registrationOpensAt',
      'registrationClosesAt',
    ] as const) {
      expect(EDITABLE_FIELDS_BY_STATUS.OPEN, field).not.toContain(field);
    }
    // Editorial copy may still change.
    expect(EDITABLE_FIELDS_BY_STATUS.OPEN).toContain('description');
  });

  it('allows only editorial changes after closing', () => {
    for (const status of ['CLOSED', 'DRAW_READY', 'DRAW_COMPLETED'] as const) {
      expect(EDITABLE_FIELDS_BY_STATUS[status]).not.toContain('name');
      expect(EDITABLE_FIELDS_BY_STATUS[status]).not.toContain('startsAt');
      expect(EDITABLE_FIELDS_BY_STATUS[status]).toContain('description');
    }
  });

  it('makes an archived event read-only', () => {
    expect(EDITABLE_FIELDS_BY_STATUS.ARCHIVED).toHaveLength(0);
    expect(isEditable('ARCHIVED')).toBe(false);
  });

  it('only a draft is physically deletable', () => {
    for (const status of EVENT_STATUSES) {
      expect(isPhysicallyDeletable(status), status).toBe(status === 'DRAFT');
    }
  });
});

describe('createEventSchema', () => {
  it('accepts a minimal draft', () => {
    const parsed = createEventSchema.parse({ name: 'My Event' });
    expect(parsed.name).toBe('My Event');
    expect(parsed.slug).toBeUndefined();
  });

  it('accepts a complete configuration', () => {
    const parsed = createEventSchema.parse({
      name: 'Full Event',
      slug: 'full-event',
      timezone: 'America/New_York',
      description: 'Something',
      bannerUrl: 'https://example.com/banner.png',
      locationName: 'Miami',
      registrationOpensAt: '2026-06-01T00:00:00.000Z',
      registrationClosesAt: '2026-06-10T00:00:00.000Z',
      startsAt: '2026-06-11T00:00:00.000Z',
      endsAt: '2026-06-12T00:00:00.000Z',
      minimumAge: 21,
      maxEntriesPerIdentity: 1,
      confirmationTitle: 'Thanks',
      confirmationMessage: 'See you there',
      ineligibleTitle: 'Sorry',
      ineligibleMessage: 'Not eligible',
    });
    expect(parsed.minimumAge).toBe(21);
  });

  it('requires a name', () => {
    expect(() => createEventSchema.parse({})).toThrow();
    expect(() => createEventSchema.parse({ name: '   ' })).toThrow();
  });

  it('rejects unknown fields, which is what blocks mass assignment', () => {
    for (const extra of [
      { status: 'OPEN' },
      { createdBy: 'someone' },
      { revision: 99 },
      { id: 'forced-id' },
      { publishedAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      expect(() => createEventSchema.parse({ name: 'X', ...extra }), JSON.stringify(extra)).toThrow();
    }
  });

  it('rejects a malformed slug and a non-http banner URL', () => {
    expect(() => createEventSchema.parse({ name: 'X', slug: 'Bad Slug' })).toThrow();
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'not-a-url']) {
      expect(() => createEventSchema.parse({ name: 'X', bannerUrl: url }), url).toThrow();
    }
    expect(createEventSchema.parse({ name: 'X', bannerUrl: null }).bannerUrl).toBeNull();
  });

  it('rejects non-canonical timestamps', () => {
    for (const value of ['2026-06-01', '2026-06-01T00:00:00Z', 'tomorrow']) {
      expect(() => createEventSchema.parse({ name: 'X', startsAt: value }), value).toThrow();
    }
  });

  it('bounds age and entry limits', () => {
    expect(() => createEventSchema.parse({ name: 'X', minimumAge: -1 })).toThrow();
    expect(() => createEventSchema.parse({ name: 'X', minimumAge: 131 })).toThrow();
    expect(() => createEventSchema.parse({ name: 'X', maxEntriesPerIdentity: 0 })).toThrow();
    expect(() => createEventSchema.parse({ name: 'X', maxEntriesPerIdentity: 1001 })).toThrow();
    expect(createEventSchema.parse({ name: 'X', minimumAge: null }).minimumAge).toBeNull();
  });
});

describe('updateEventSchema', () => {
  it('requires expectedRevision', () => {
    expect(() => updateEventSchema.parse({ name: 'New' })).toThrow();
    expect(updateEventSchema.parse({ expectedRevision: 3, name: 'New' }).name).toBe('New');
  });

  it('rejects an empty patch', () => {
    // A request that changes nothing is a client bug, not a no-op success.
    expect(() => updateEventSchema.parse({ expectedRevision: 1 })).toThrow();
  });

  it('refuses to carry a status change', () => {
    expect(() =>
      updateEventSchema.parse({ expectedRevision: 1, status: 'OPEN' }),
    ).toThrow();
  });

  it('refuses operational timestamps and identity fields', () => {
    for (const extra of [
      { publishedAt: '2026-01-01T00:00:00.000Z' },
      { archivedAt: '2026-01-01T00:00:00.000Z' },
      { createdBy: 'x' },
      { updatedBy: 'x' },
      { revision: 5 },
      { id: 'x' },
      { createdAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      expect(
        () => updateEventSchema.parse({ expectedRevision: 1, ...extra }),
        JSON.stringify(extra),
      ).toThrow();
    }
  });
});

describe('duplicate and transition schemas', () => {
  it('duplicate accepts an empty body', () => {
    expect(duplicateEventSchema.parse({})).toEqual({});
    expect(duplicateEventSchema.parse({ name: 'Copy', copyDates: true }).copyDates).toBe(true);
  });

  it('duplicate rejects unknown fields', () => {
    expect(() => duplicateEventSchema.parse({ status: 'OPEN' })).toThrow();
  });

  it('transition accepts an empty body and an optional revision', () => {
    expect(eventTransitionSchema.parse({})).toEqual({});
    expect(eventTransitionSchema.parse({ expectedRevision: 4 }).expectedRevision).toBe(4);
    expect(() => eventTransitionSchema.parse({ action: 'open' })).toThrow();
  });
});

describe('eventListQuerySchema', () => {
  it('applies defaults', () => {
    const parsed = eventListQuerySchema.parse({});
    expect(parsed).toMatchObject({
      page: 1,
      pageSize: 25,
      archived: 'active',
      sort: 'createdAt',
      direction: 'desc',
    });
  });

  it('caps pageSize and rejects nonsense', () => {
    expect(() => eventListQuerySchema.parse({ pageSize: 201 })).toThrow();
    expect(() => eventListQuerySchema.parse({ page: 0 })).toThrow();
    expect(eventListQuerySchema.parse({ pageSize: '50' }).pageSize).toBe(50);
  });

  it('enforces the sort allowlist', () => {
    expect(eventListQuerySchema.parse({ sort: 'name' }).sort).toBe('name');
    for (const sort of ['password_hash', 'created_by', 'id; DROP TABLE events']) {
      expect(() => eventListQuerySchema.parse({ sort }), sort).toThrow();
    }
  });

  it('enforces the status and archived allowlists', () => {
    expect(() => eventListQuerySchema.parse({ status: 'MADE_UP' })).toThrow();
    expect(() => eventListQuerySchema.parse({ archived: 'maybe' })).toThrow();
    expect(() => eventListQuerySchema.parse({ direction: 'sideways' })).toThrow();
  });
});
