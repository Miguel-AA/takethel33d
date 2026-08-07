// @vitest-environment node
//
// Prize schemas and the shared permission tables.

import { describe, expect, it } from 'vitest';
import {
  PRIZE_ACTION_SOURCES,
  PRIZE_ACTION_TARGET,
  PRIZE_CAPABILITIES_BY_EVENT_STATUS,
  PRIZE_STATUSES,
  PRIZE_TRANSITION_ACTIONS,
  allowedPrizeActions,
  canDeletePrize,
  canPrizeTransition,
  editableFieldsFor,
  eventAllows,
} from '../shared/prizeLifecycle';
import { EVENT_STATUSES } from '../shared/eventLifecycle';
import {
  createEventPrizeSchema,
  eventPrizeListQuerySchema,
  prizeTransitionSchema,
  reorderEventPrizesSchema,
  updateEventPrizeSchema,
} from '../shared/schemas';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('prize status machine', () => {
  it('has exactly three statuses', () => {
    expect([...PRIZE_STATUSES]).toEqual(['ACTIVE', 'INACTIVE', 'ARCHIVED']);
  });

  it('permits exactly the approved transitions', () => {
    expect(canPrizeTransition('INACTIVE', 'activate')).toBe(true);
    expect(canPrizeTransition('ACTIVE', 'deactivate')).toBe(true);
    expect(canPrizeTransition('ACTIVE', 'archive')).toBe(true);
    expect(canPrizeTransition('INACTIVE', 'archive')).toBe(true);
  });

  it('refuses repeats and anything out of an archived prize', () => {
    // Activating an already-active prize is a refusal, not a no-op.
    expect(canPrizeTransition('ACTIVE', 'activate')).toBe(false);
    expect(canPrizeTransition('INACTIVE', 'deactivate')).toBe(false);
    // Archiving is terminal in this phase.
    for (const action of PRIZE_TRANSITION_ACTIONS) {
      expect(canPrizeTransition('ARCHIVED', action), action).toBe(false);
    }
  });

  it('every action declares sources and a target', () => {
    for (const action of PRIZE_TRANSITION_ACTIONS) {
      expect(PRIZE_ACTION_SOURCES[action].length, action).toBeGreaterThan(0);
      expect(PRIZE_STATUSES).toContain(PRIZE_ACTION_TARGET[action]);
    }
  });
});

describe('permissions by event status', () => {
  it('gives full control while the event is DRAFT or SCHEDULED', () => {
    for (const status of ['DRAFT', 'SCHEDULED'] as const) {
      for (const capability of [
        'create',
        'editEditorial',
        'editQuantity',
        'activate',
        'deactivate',
        'archive',
        'delete',
        'reorder',
      ] as const) {
        expect(eventAllows(status, capability), `${status}/${capability}`).toBe(true);
      }
    }
  });

  it('freezes the offer once the event is OPEN, except editorial copy', () => {
    expect(eventAllows('OPEN', 'editEditorial')).toBe(true);
    // The SET of prizes and the NUMBER of units are the promise made to
    // participants and cannot move.
    for (const capability of [
      'create',
      'editQuantity',
      'activate',
      'deactivate',
      'archive',
      'delete',
      'reorder',
    ] as const) {
      expect(eventAllows('OPEN', capability), capability).toBe(false);
    }
  });

  it('freezes everything from CLOSED onwards', () => {
    for (const status of ['CLOSED', 'DRAW_READY', 'DRAW_COMPLETED', 'ARCHIVED'] as const) {
      expect(PRIZE_CAPABILITIES_BY_EVENT_STATUS[status], status).toHaveLength(0);
    }
  });

  it('lets a cancelled event only file prizes away', () => {
    expect([...PRIZE_CAPABILITIES_BY_EVENT_STATUS.CANCELLED]).toEqual(['archive']);
  });

  it('covers every event status', () => {
    for (const status of EVENT_STATUSES) {
      expect(PRIZE_CAPABILITIES_BY_EVENT_STATUS[status], status).toBeDefined();
    }
  });
});

describe('editable fields', () => {
  it('allows editorial plus quantity while draft', () => {
    expect(editableFieldsFor('DRAFT', 'ACTIVE').sort()).toEqual(
      ['description', 'imageUrl', 'name', 'quantity'].sort(),
    );
  });

  it('drops quantity once open', () => {
    expect(editableFieldsFor('OPEN', 'ACTIVE').sort()).toEqual(
      ['description', 'imageUrl', 'name'].sort(),
    );
  });

  it('makes an archived prize immutable whatever the event allows', () => {
    for (const status of EVENT_STATUSES) {
      expect(editableFieldsFor(status, 'ARCHIVED'), status).toHaveLength(0);
    }
  });

  it('never offers an action the prize status forbids', () => {
    for (const eventStatus of EVENT_STATUSES) {
      for (const prizeStatus of PRIZE_STATUSES) {
        for (const action of allowedPrizeActions(eventStatus, prizeStatus)) {
          expect(canPrizeTransition(prizeStatus, action)).toBe(true);
          expect(eventAllows(eventStatus, action)).toBe(true);
        }
      }
    }
  });

  it('never allows deleting an archived prize', () => {
    for (const eventStatus of EVENT_STATUSES) {
      expect(canDeletePrize(eventStatus, 'ARCHIVED'), eventStatus).toBe(false);
    }
    expect(canDeletePrize('DRAFT', 'ACTIVE')).toBe(true);
    expect(canDeletePrize('OPEN', 'ACTIVE')).toBe(false);
  });
});

describe('createEventPrizeSchema', () => {
  it('accepts a minimal prize', () => {
    const parsed = createEventPrizeSchema.parse({ name: 'Vape', quantity: 2 });
    expect(parsed.name).toBe('Vape');
    expect(parsed.quantity).toBe(2);
  });

  it('accepts a complete prize', () => {
    const parsed = createEventPrizeSchema.parse({
      name: 'Gift Card',
      description: 'A $50 card',
      imageUrl: 'https://example.com/card.png',
      quantity: 3,
      sortOrder: 1,
    });
    expect(parsed.imageUrl).toBe('https://example.com/card.png');
  });

  it('requires a non-blank name and a quantity', () => {
    expect(() => createEventPrizeSchema.parse({ quantity: 1 })).toThrow();
    expect(() => createEventPrizeSchema.parse({ name: '   ', quantity: 1 })).toThrow();
    expect(() => createEventPrizeSchema.parse({ name: 'X' })).toThrow();
  });

  it.each([0, -1, 1001, 1.5])('rejects quantity %s', (quantity) => {
    expect(() => createEventPrizeSchema.parse({ name: 'X', quantity })).toThrow();
  });

  it('accepts the quantity bounds exactly', () => {
    expect(createEventPrizeSchema.parse({ name: 'X', quantity: 1 }).quantity).toBe(1);
    expect(createEventPrizeSchema.parse({ name: 'X', quantity: 1000 }).quantity).toBe(1000);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    '/relative/path.png',
    'example.com/image.png',
    'not a url',
    'ftp://example.com/x.png',
  ])('rejects the image URL %s', (imageUrl) => {
    expect(() =>
      createEventPrizeSchema.parse({ name: 'X', quantity: 1, imageUrl }),
    ).toThrow();
  });

  it('accepts an explicit null image', () => {
    expect(
      createEventPrizeSchema.parse({ name: 'X', quantity: 1, imageUrl: null }).imageUrl,
    ).toBeNull();
  });

  it.each([
    { status: 'ACTIVE' },
    { revision: 5 },
    { id: 'forced' },
    { eventId: 'other-event' },
    { createdBy: 'someone' },
    { archivedAt: '2026-01-01T00:00:00.000Z' },
    { createdAt: '2026-01-01T00:00:00.000Z' },
  ])('rejects the injected field %o', (extra) => {
    expect(() =>
      createEventPrizeSchema.parse({ name: 'X', quantity: 1, ...extra }),
    ).toThrow();
  });

  it('bounds the name and description lengths', () => {
    expect(() =>
      createEventPrizeSchema.parse({ name: 'x'.repeat(121), quantity: 1 }),
    ).toThrow();
    expect(() =>
      createEventPrizeSchema.parse({
        name: 'X',
        quantity: 1,
        description: 'x'.repeat(2001),
      }),
    ).toThrow();
  });
});

describe('updateEventPrizeSchema', () => {
  it('requires expectedRevision and a non-empty patch', () => {
    expect(() => updateEventPrizeSchema.parse({ name: 'New' })).toThrow();
    expect(() => updateEventPrizeSchema.parse({ expectedRevision: 1 })).toThrow();
    expect(updateEventPrizeSchema.parse({ expectedRevision: 1, name: 'New' }).name).toBe('New');
  });

  it.each([
    { status: 'INACTIVE' },
    { sortOrder: 3 },
    { eventId: 'x' },
    { revision: 9 },
    { archivedAt: null },
    { updatedBy: 'x' },
  ])('refuses to carry %o', (extra) => {
    expect(() => updateEventPrizeSchema.parse({ expectedRevision: 1, ...extra })).toThrow();
  });
});

describe('reorderEventPrizesSchema', () => {
  const item = (prizeId: string, sortOrder: number) => ({
    prizeId,
    expectedRevision: 1,
    sortOrder,
  });

  it('accepts a coherent order', () => {
    const parsed = reorderEventPrizesSchema.parse({
      items: [item(UUID_A, 0), item(UUID_B, 1)],
    });
    expect(parsed.items).toHaveLength(2);
  });

  it('rejects an empty list', () => {
    expect(() => reorderEventPrizesSchema.parse({ items: [] })).toThrow();
  });

  it('rejects a repeated prize', () => {
    expect(() =>
      reorderEventPrizesSchema.parse({ items: [item(UUID_A, 0), item(UUID_A, 1)] }),
    ).toThrow();
  });

  it('rejects a repeated position', () => {
    // Two prizes cannot occupy the same slot; the unique index would refuse it
    // anyway, but the schema says so before a query runs.
    expect(() =>
      reorderEventPrizesSchema.parse({ items: [item(UUID_A, 0), item(UUID_B, 0)] }),
    ).toThrow();
  });

  it('rejects negative positions and bad ids', () => {
    expect(() => reorderEventPrizesSchema.parse({ items: [item(UUID_A, -1)] })).toThrow();
    expect(() => reorderEventPrizesSchema.parse({ items: [item('not-a-uuid', 0)] })).toThrow();
  });

  it('rejects an invalid revision', () => {
    expect(() =>
      reorderEventPrizesSchema.parse({
        items: [{ prizeId: UUID_A, expectedRevision: 0, sortOrder: 0 }],
      }),
    ).toThrow();
  });

  it('has no event revision field — reordering does not change the event', () => {
    expect(() =>
      reorderEventPrizesSchema.parse({
        expectedEventRevision: 1,
        items: [item(UUID_A, 0)],
      }),
    ).toThrow();
  });
});

describe('list query and transition schemas', () => {
  it('applies list defaults', () => {
    expect(eventPrizeListQuerySchema.parse({})).toMatchObject({
      page: 1,
      pageSize: 25,
      archived: 'active',
      sort: 'sortOrder',
      direction: 'asc',
    });
  });

  it('enforces the sort allowlist', () => {
    expect(eventPrizeListQuerySchema.parse({ sort: 'quantity' }).sort).toBe('quantity');
    for (const sort of ['event_id', 'password_hash', 'id; DROP TABLE event_prizes']) {
      expect(() => eventPrizeListQuerySchema.parse({ sort }), sort).toThrow();
    }
  });

  it('rejects invalid status, archived and pageSize', () => {
    expect(() => eventPrizeListQuerySchema.parse({ status: 'GONE' })).toThrow();
    expect(() => eventPrizeListQuerySchema.parse({ archived: 'maybe' })).toThrow();
    expect(() => eventPrizeListQuerySchema.parse({ pageSize: 201 })).toThrow();
  });

  it('accepts an empty transition body', () => {
    expect(prizeTransitionSchema.parse({})).toEqual({});
    expect(prizeTransitionSchema.parse({ expectedRevision: 2 }).expectedRevision).toBe(2);
    expect(() => prizeTransitionSchema.parse({ status: 'ACTIVE' })).toThrow();
  });
});
