// Prize status and the rules that govern what may be done to a prize.
//
// SHARED so the admin UI, the dev mock and the backend all read ONE table.
// The server re-validates everything regardless — the UI merely avoids
// offering a button that would be refused.
//
// The central idea: what you may do to a prize depends on the state of its
// EVENT, not only on the prize. Once people can enter an event, the prizes on
// offer are part of the promise made to them, so they stop being freely
// editable.

import type { EventStatus } from './eventLifecycle.ts';

export const PRIZE_STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type PrizeStatus = (typeof PRIZE_STATUSES)[number];

/** Explicit status actions. There is no generic `PATCH status`. */
export const PRIZE_TRANSITION_ACTIONS = ['activate', 'deactivate', 'archive'] as const;
export type PrizeTransitionAction = (typeof PRIZE_TRANSITION_ACTIONS)[number];

/** Source status each action may be invoked from. */
export const PRIZE_ACTION_SOURCES: Record<PrizeTransitionAction, readonly PrizeStatus[]> = {
  activate: ['INACTIVE'],
  deactivate: ['ACTIVE'],
  // Archiving is terminal in this phase: an archived prize is history.
  archive: ['ACTIVE', 'INACTIVE'],
};

export const PRIZE_ACTION_TARGET: Record<PrizeTransitionAction, PrizeStatus> = {
  activate: 'ACTIVE',
  deactivate: 'INACTIVE',
  archive: 'ARCHIVED',
};

export function canPrizeTransition(
  from: PrizeStatus,
  action: PrizeTransitionAction,
): boolean {
  return PRIZE_ACTION_SOURCES[action].includes(from);
}

// ---------------------------------------------------------------------------
// What the EVENT's state permits
// ---------------------------------------------------------------------------

/**
 * Capabilities, deliberately split so "rename a prize" and "change how many
 * there are" can be permitted independently — that distinction is the whole
 * point of the OPEN policy below.
 */
export const PRIZE_CAPABILITIES = [
  'create',
  'editEditorial',
  'editQuantity',
  'activate',
  'deactivate',
  'archive',
  'delete',
  'reorder',
] as const;

export type PrizeCapability = (typeof PRIZE_CAPABILITIES)[number];

const FULL_CONTROL: readonly PrizeCapability[] = PRIZE_CAPABILITIES;

/**
 * Capabilities granted by each event state.
 *
 *  - DRAFT / SCHEDULED: nobody can enter yet, so everything is malleable.
 *  - OPEN: participants are acting on the advertised prizes. Only editorial
 *    copy may change — a typo fix must stay possible, but the SET of prizes and
 *    the NUMBER of units are the offer itself and are frozen. That is why
 *    create, delete, archive, reorder, activate, deactivate and quantity are
 *    all withheld here.
 *  - CLOSED / DRAW_READY / DRAW_COMPLETED: the configuration is what the draw
 *    will run against, so it is fully frozen.
 *  - CANCELLED: nothing will be drawn; the only useful act is filing prizes away.
 *  - ARCHIVED: read-only, like the event itself.
 */
export const PRIZE_CAPABILITIES_BY_EVENT_STATUS: Record<
  EventStatus,
  readonly PrizeCapability[]
> = {
  DRAFT: FULL_CONTROL,
  SCHEDULED: FULL_CONTROL,
  OPEN: ['editEditorial'],
  CLOSED: [],
  DRAW_READY: [],
  DRAW_COMPLETED: [],
  CANCELLED: ['archive'],
  ARCHIVED: [],
};

export function eventAllows(
  eventStatus: EventStatus,
  capability: PrizeCapability,
): boolean {
  return PRIZE_CAPABILITIES_BY_EVENT_STATUS[eventStatus].includes(capability);
}

/** True when the event permits any prize mutation at all. */
export function eventAllowsAnyPrizeMutation(eventStatus: EventStatus): boolean {
  return PRIZE_CAPABILITIES_BY_EVENT_STATUS[eventStatus].length > 0;
}

// ---------------------------------------------------------------------------
// Editable fields
// ---------------------------------------------------------------------------

export const PRIZE_EDITORIAL_FIELDS = ['name', 'description', 'imageUrl'] as const;
export const PRIZE_QUANTITY_FIELDS = ['quantity'] as const;

export const PRIZE_EDITABLE_FIELDS = [
  ...PRIZE_EDITORIAL_FIELDS,
  ...PRIZE_QUANTITY_FIELDS,
] as const;

export type PrizeEditableField = (typeof PRIZE_EDITABLE_FIELDS)[number];

/**
 * Fields a patch may touch, given the event's state and the prize's own.
 *
 * An ARCHIVED prize is immutable whatever the event allows: it has been
 * retired, and editing history is not a thing this system does.
 */
export function editableFieldsFor(
  eventStatus: EventStatus,
  prizeStatus: PrizeStatus,
): PrizeEditableField[] {
  if (prizeStatus === 'ARCHIVED') return [];

  const fields: PrizeEditableField[] = [];
  if (eventAllows(eventStatus, 'editEditorial')) fields.push(...PRIZE_EDITORIAL_FIELDS);
  if (eventAllows(eventStatus, 'editQuantity')) fields.push(...PRIZE_QUANTITY_FIELDS);
  return fields;
}

/** Status actions available right now, from both states together. */
export function allowedPrizeActions(
  eventStatus: EventStatus,
  prizeStatus: PrizeStatus,
): PrizeTransitionAction[] {
  return PRIZE_TRANSITION_ACTIONS.filter(
    (action) =>
      canPrizeTransition(prizeStatus, action) && eventAllows(eventStatus, action),
  );
}

/**
 * Physical deletion is only ever for a live prize under an editable event.
 * An archived prize is deliberately NOT deletable: archiving is the act of
 * keeping it.
 */
export function canDeletePrize(
  eventStatus: EventStatus,
  prizeStatus: PrizeStatus,
): boolean {
  return eventAllows(eventStatus, 'delete') && prizeStatus !== 'ARCHIVED';
}
