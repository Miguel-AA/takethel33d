// Shared scaffolding for the draw suites.
//
// Getting an event to the point where it can be drawn is a long journey — an
// administrator, an event, a form, a publication, an OPEN transition, real
// registrations, a CLOSE, prizes, and finally `mark-draw-ready` — and five
// suites need exactly the same one. Duplicating it would mean five subtly
// different fixtures.
//
// Everything goes through the REAL services, never raw SQL, so a fixture cannot
// construct a state the application itself would refuse. That matters more here
// than anywhere else: a draw is only meaningful over a population that arrived
// the way a real population arrives.

import { PrizeService } from '../../functions/_shared/prizeService';
import { DrawService } from '../../functions/_shared/drawService';
import {
  answersFor,
  createHarness,
  seedPublicEvent,
  type PublicHarness,
} from './publicFlow';
import type { Event, EventFormVersion, EventPrize } from '../../shared/types';

export interface DrawHarness extends PublicHarness {
  prizes: PrizeService;
  draws: DrawService;
}

export async function createDrawHarness(): Promise<DrawHarness> {
  const harness = await createHarness();
  return {
    ...harness,
    prizes: new PrizeService(harness.db.d1),
    draws: new DrawService(harness.db.d1),
  };
}

/** The actor shape the administrative services take. */
export const drawActor = (harness: PublicHarness) => ({
  admin: harness.admin,
  requestContext: {
    requestId: 'req-draw',
    ipHash: null,
    userAgent: null,
    origin: null,
    method: 'POST',
    pathname: '/draw',
  },
});

export interface DrawSeedOptions {
  /** How many people register. Each becomes an ELIGIBLE entry. */
  participants?: number;
  /** One entry per prize, giving its unit count. */
  prizes?: number[];
  /** Stop at CLOSED instead of going on to DRAW_READY. */
  markReady?: boolean;
}

export interface SeededDraw {
  event: Event;
  version: EventFormVersion;
  prizes: EventPrize[];
  entryIds: string[];
}

/**
 * An event at DRAW_READY, with real participants and real prizes.
 *
 * The prizes are created while the event is still a DRAFT because
 * `PRIZE_CAPABILITIES_BY_EVENT_STATUS` freezes them from DRAW_READY onward —
 * which is itself one of the guarantees the draw depends on.
 */
export async function seedDrawableEvent(
  harness: DrawHarness,
  options: DrawSeedOptions = {},
): Promise<SeededDraw> {
  const participantCount = options.participants ?? 5;
  const prizeSpec = options.prizes ?? [1];

  const actor = drawActor(harness);
  const prizes: EventPrize[] = [];

  const { event, version } = await seedPublicEvent(harness, {
    // Prizes are created while the event is still a DRAFT, because
    // `PRIZE_CAPABILITIES_BY_EVENT_STATUS` freezes them from CLOSED onward and
    // allows only editorial changes while OPEN. That freeze is itself one of
    // the guarantees the draw depends on, so the fixture respects it rather
    // than writing rows around it.
    onDraft: async (eventId) => {
      for (const [index, quantity] of prizeSpec.entries()) {
        const created = await harness.prizes.create(
          eventId,
          { name: `Prize ${index + 1}`, quantity } as never,
          actor as never,
        );
        if (!created.ok) throw new Error(JSON.stringify(created.failure));
        prizes.push(created.value);
      }
    },
  });

  const entryIds: string[] = [];
  for (let i = 0; i < participantCount; i++) {
    const result = await harness.registration.register(
      event.id,
      answersFor(version, {
        first_name: `Person${i}`,
        last_name: 'Test',
        email: `person${i}@example.com`,
      }),
      harness.actor(),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    entryIds.push(result.value.entry.id);
  }

  const closed = await harness.events.transition(event.id, 'close', actor as never);
  if (!closed.ok) throw new Error(JSON.stringify(closed.failure));

  if (options.markReady !== false) {
    const ready = await harness.events.transition(
      event.id,
      'mark-draw-ready',
      actor as never,
    );
    if (!ready.ok) throw new Error(JSON.stringify(ready.failure));
  }

  const reloaded = await harness.events.findById(event.id);
  if (!reloaded) throw new Error('event vanished');

  return { event: reloaded, version, prizes, entryIds };
}
