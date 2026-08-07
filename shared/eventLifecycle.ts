// Event state machine.
//
// SHARED on purpose: the server is the authority, but the admin UI must be able
// to show only the actions a state actually permits. Both read this one table,
// so a button can never offer a transition the backend will reject — and a
// hand-crafted request can never take one the UI merely hid.
//
// There is NO automatic transition. Dates are preconditions and presentation;
// an administrator performs every state change explicitly. Nothing here runs on
// a timer, and nothing changes state merely because a date passed.

export const EVENT_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'OPEN',
  'CLOSED',
  'DRAW_READY',
  'DRAW_COMPLETED',
  'CANCELLED',
  'ARCHIVED',
] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_TRANSITION_ACTIONS = [
  'publish',
  'open',
  'close',
  'mark-draw-ready',
  'cancel',
  'archive',
] as const;

export type EventTransitionAction = (typeof EVENT_TRANSITION_ACTIONS)[number];

/** Target state of each action. */
export const ACTION_TARGET: Record<EventTransitionAction, EventStatus> = {
  publish: 'SCHEDULED',
  open: 'OPEN',
  close: 'CLOSED',
  'mark-draw-ready': 'DRAW_READY',
  cancel: 'CANCELLED',
  archive: 'ARCHIVED',
};

/**
 * States each action may be invoked FROM.
 *
 * Deliberately absent: any path back to DRAFT, reopening a CLOSED event,
 * leaving ARCHIVED or CANCELLED, and jumping to DRAW_COMPLETED (which only a
 * completed draw may set, in a later phase).
 */
export const ACTION_SOURCES: Record<EventTransitionAction, readonly EventStatus[]> = {
  publish: ['DRAFT'],
  open: ['DRAFT', 'SCHEDULED'],
  close: ['OPEN'],
  'mark-draw-ready': ['CLOSED'],
  cancel: ['DRAFT', 'SCHEDULED', 'OPEN'],
  // A cancelled event can still be filed away; an archived one is terminal.
  archive: [
    'DRAFT',
    'SCHEDULED',
    'OPEN',
    'CLOSED',
    'DRAW_READY',
    'DRAW_COMPLETED',
    'CANCELLED',
  ],
};

/** Every state reachable from a given state, derived from the action table. */
export function allowedTargets(from: EventStatus): EventStatus[] {
  return EVENT_TRANSITION_ACTIONS.filter((action) =>
    ACTION_SOURCES[action].includes(from),
  ).map((action) => ACTION_TARGET[action]);
}

/** Actions permitted from a state, ignoring data preconditions. */
export function allowedActions(from: EventStatus): EventTransitionAction[] {
  return EVENT_TRANSITION_ACTIONS.filter((action) =>
    ACTION_SOURCES[action].includes(from),
  );
}

export function canTransition(
  from: EventStatus,
  action: EventTransitionAction,
): boolean {
  return ACTION_SOURCES[action].includes(from);
}

/** True once the event is in a terminal state. */
export function isTerminal(status: EventStatus): boolean {
  return status === 'ARCHIVED';
}

// ---------------------------------------------------------------------------
// Editability
// ---------------------------------------------------------------------------

/** Every field a client may ever send in an update. */
export const EVENT_EDITABLE_FIELDS = [
  'name',
  'slug',
  'description',
  'bannerUrl',
  'locationName',
  'timezone',
  'registrationOpensAt',
  'registrationClosesAt',
  'startsAt',
  'endsAt',
  'minimumAge',
  'maxEntriesPerIdentity',
  'confirmationTitle',
  'confirmationMessage',
  'ineligibleTitle',
  'ineligibleMessage',
] as const;

export type EventEditableField = (typeof EVENT_EDITABLE_FIELDS)[number];

const EDITORIAL_FIELDS: EventEditableField[] = [
  'description',
  'bannerUrl',
  'locationName',
  'confirmationTitle',
  'confirmationMessage',
  'ineligibleTitle',
  'ineligibleMessage',
];

const MESSAGE_FIELDS: EventEditableField[] = [
  'confirmationTitle',
  'confirmationMessage',
  'ineligibleTitle',
  'ineligibleMessage',
];

/**
 * Which fields may change in each state.
 *
 * The rule tightens as an event becomes real to participants. A DRAFT is fully
 * malleable. Once SCHEDULED the slug is frozen, because it is the public
 * address. Once OPEN nothing that defines who may take part can move — age,
 * entry limit, timezone and the registration window are the contract offered to
 * people who already signed up. After CLOSED only editorial copy may change.
 */
export const EDITABLE_FIELDS_BY_STATUS: Record<
  EventStatus,
  readonly EventEditableField[]
> = {
  DRAFT: EVENT_EDITABLE_FIELDS,
  SCHEDULED: [
    'name',
    ...EDITORIAL_FIELDS,
    'timezone',
    'registrationOpensAt',
    'registrationClosesAt',
    'startsAt',
    'endsAt',
    'minimumAge',
    'maxEntriesPerIdentity',
  ],
  // Participation rules are frozen: people have already acted on them.
  OPEN: ['name', ...EDITORIAL_FIELDS],
  CLOSED: EDITORIAL_FIELDS,
  DRAW_READY: EDITORIAL_FIELDS,
  DRAW_COMPLETED: EDITORIAL_FIELDS,
  CANCELLED: MESSAGE_FIELDS,
  ARCHIVED: [],
};

export function isFieldEditable(
  status: EventStatus,
  field: EventEditableField,
): boolean {
  return EDITABLE_FIELDS_BY_STATUS[status].includes(field);
}

export function isEditable(status: EventStatus): boolean {
  return EDITABLE_FIELDS_BY_STATUS[status].length > 0;
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

/**
 * Fields that must be present before an event may reach a state.
 *
 * A DRAFT is allowed to be incomplete — that is the whole point of a draft — so
 * completeness is demanded at the transition, not at every save.
 */
/**
 * Transitions that require a PUBLISHED registration form.
 *
 * Scheduling or opening an event announces it to people who will be asked to
 * fill something in. Doing that with no published form — or with only a draft
 * an operator is still editing — would advertise a door with nothing behind
 * it, and would let the form change under the first arrivals.
 *
 * Only these two. Closing, cancelling and archiving an event that never opened
 * must stay possible; demanding a form to abandon something would trap it.
 */
export const ACTIONS_REQUIRING_PUBLISHED_FORM: readonly EventTransitionAction[] = [
  'publish',
  'open',
];

export function actionRequiresPublishedForm(action: EventTransitionAction): boolean {
  return ACTIONS_REQUIRING_PUBLISHED_FORM.includes(action);
}

/** The blocker reported when it is missing. */
export const PUBLISHED_FORM_REQUIRED = 'PUBLISHED_FORM_REQUIRED';

export const REQUIRED_FIELDS_FOR_STATUS: Partial<
  Record<EventStatus, readonly EventEditableField[]>
> = {
  SCHEDULED: [
    'timezone',
    'registrationOpensAt',
    'registrationClosesAt',
    'startsAt',
    'endsAt',
  ],
  // Opening immediately does not require an opening date: the act of opening IS
  // the opening. A closing date and an event window are still required, so the
  // event has a defined end.
  OPEN: ['timezone', 'registrationClosesAt', 'startsAt', 'endsAt'],
};

/**
 * Operational timestamps that must ALREADY be present before a state is
 * entered.
 *
 * Distinct from `REQUIRED_FIELDS_FOR_STATUS`, which covers configuration the
 * operator fills in. These record that something actually happened: an event
 * cannot be "ready for the draw" unless it was genuinely closed. The status
 * column alone is not proof — a row edited directly in the database could claim
 * CLOSED without ever having been closed.
 */
export const REQUIRED_TIMESTAMPS_FOR_STATUS: Partial<
  Record<EventStatus, readonly string[]>
> = {
  DRAW_READY: ['closedAt'],
};

/**
 * Timing preconditions relative to NOW, per action.
 *
 * The ordering rules in the service say the four dates are consistent with each
 * OTHER; these say the window still makes sense at the moment of the action.
 * Scheduling an event whose registration opening has already passed, or opening
 * registration that has already closed, is incoherent regardless of how neatly
 * the dates line up.
 *
 *  - `mustBeFuture`: the field, when set, has to be ahead of now.
 */
export const TIMING_PRECONDITIONS: Partial<
  Record<EventTransitionAction, { mustBeFuture: readonly EventEditableField[] }>
> = {
  // "Scheduled" means registration has not started yet.
  publish: { mustBeFuture: ['registrationOpensAt'] },
  // Opening is only meaningful while there is still something to open into.
  open: { mustBeFuture: ['registrationClosesAt', 'endsAt'] },
};

/** Deletion is only ever safe for a pristine draft (see EventLifecycleService). */
export function isPhysicallyDeletable(status: EventStatus): boolean {
  return status === 'DRAFT';
}
