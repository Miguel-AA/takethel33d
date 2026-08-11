// Shared scaffolding for the results suites.
//
// A publishable event is the whole application in miniature: an administrator,
// an event, a form, a publication, an OPEN transition, real registrations, a
// CLOSE, prizes, `mark-draw-ready` and a completed draw. Five suites need
// exactly the same one.
//
// Everything goes through the REAL services, never raw SQL, so a fixture cannot
// construct a state the application itself would refuse — which matters more
// here than anywhere: a publication is a copy of a draw, and a draw assembled
// by hand would not be the thing this phase claims to copy.

import { ResultsService } from '../../functions/_shared/resultsService';
import { drawActor, createDrawHarness, seedDrawableEvent, type DrawHarness } from './drawFlow';
import type { CompletedDraw, Event, EventPrize } from '../../shared/types';

export interface ResultHarness extends DrawHarness {
  results: ResultsService;
}

export async function createResultHarness(): Promise<ResultHarness> {
  const harness = await createDrawHarness();
  return { ...harness, results: new ResultsService(harness.db.d1) };
}

export const resultActor = drawActor;

export interface SeededResults {
  event: Event;
  prizes: EventPrize[];
  entryIds: string[];
  draw: CompletedDraw;
}

/**
 * An event whose draw has been run, ready to publish.
 *
 * The draw goes through `DrawService`, so the assignments, their prize
 * snapshots and the event's transition to DRAW_COMPLETED are the real ones.
 */
export async function seedDrawnEvent(
  harness: ResultHarness,
  options: { participants?: number; prizes?: number[] } = {},
): Promise<SeededResults> {
  const seeded = await seedDrawableEvent(harness, {
    participants: options.participants ?? 5,
    prizes: options.prizes ?? [2],
  });

  const drawn = await harness.draws.run(seeded.event.id, resultActor(harness));
  if (!drawn.ok) throw new Error(JSON.stringify(drawn.failure));

  const event = await harness.events.findById(seeded.event.id);
  if (!event) throw new Error('event vanished');

  return {
    event,
    prizes: seeded.prizes,
    entryIds: seeded.entryIds,
    draw: drawn.value.response.draw!,
  };
}

/** An event whose results have been drawn AND published. */
export async function seedPublishedEvent(
  harness: ResultHarness,
  options: { participants?: number; prizes?: number[] } = {},
): Promise<SeededResults> {
  const seeded = await seedDrawnEvent(harness, options);
  const published = await harness.results.publish(seeded.event.id, resultActor(harness));
  if (!published.ok) throw new Error(JSON.stringify(published.failure));

  const event = await harness.events.findById(seeded.event.id);
  if (!event) throw new Error('event vanished');
  return { ...seeded, event };
}

/** Files the event away through the REAL lifecycle transition. */
export async function archive(harness: ResultHarness, eventId: string): Promise<void> {
  const result = await harness.events.transition(
    eventId,
    'archive',
    resultActor(harness) as never,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
}
