export const queryKeys = {
  /**
   * The public event page, addressed by SLUG.
   *
   * A first-level namespace of its own, deliberately not nested under
   * `['events', ...]`, for three reasons:
   *
   *   * the administrative keys are indexed by UUID and this one by slug —
   *     sharing a prefix would make the same position sometimes an id and
   *     sometimes an address;
   *   * `eventsAll` is a PREFIX of every administrative event key, so
   *     invalidating it after publishing a form would also discard the public
   *     cache, and vice versa;
   *   * the two carry different shapes. The admin cache holds a full `Event`;
   *     this holds a redacted DTO. A collision would hand a component the wrong
   *     one.
   */
  publicEvent: (slug: string) => ['public', 'event', slug] as const,
  publicAll: ['public'] as const,
  /** The authenticated admin (`GET /api/manager/me`). */
  session: ['session'] as const,
  attendees: (search: string, page: number, pageSize: number) =>
    ['attendees', { search, page, pageSize }] as const,
  attendeesAll: ['attendees'] as const,
  attendee: (id: string) => ['attendee', id] as const,
  metrics: ['metrics'] as const,
  raffleCurrent: ['raffle', 'current'] as const,
  auditAll: ['audit'] as const,
  auditLogs: (filters: Record<string, unknown>) => ['audit', filters] as const,
  auditLog: (id: string) => ['audit', 'detail', id] as const,
  eventsAll: ['events'] as const,
  eventList: (filters: Record<string, unknown>) => ['events', 'list', filters] as const,
  eventDetail: (id: string) => ['events', 'detail', id] as const,
  eventPrizesAll: (eventId: string) => ['events', 'detail', eventId, 'prizes'] as const,
  eventPrizeList: (eventId: string, filters: Record<string, unknown>) =>
    ['events', 'detail', eventId, 'prizes', 'list', filters] as const,
  eventPrizeDetail: (eventId: string, prizeId: string) =>
    ['events', 'detail', eventId, 'prizes', 'detail', prizeId] as const,
  /** The whole form draft; every mutation replaces this one entry. */
  eventFormDraft: (eventId: string) => ['events', 'detail', eventId, 'form'] as const,
  eventFormPreview: (eventId: string) =>
    ['events', 'detail', eventId, 'form', 'preview'] as const,
  /** Publication history. Separate from the draft: versions never change. */
  formVersions: (eventId: string) => ['events', 'detail', eventId, 'formVersions'] as const,
  formVersion: (eventId: string, versionId: string) =>
    ['events', 'detail', eventId, 'formVersions', versionId] as const,
  publishedForm: (eventId: string) =>
    ['events', 'detail', eventId, 'publishedForm'] as const,
  /**
   * Participations in an event.
   *
   * `eventEntriesAll` is a PREFIX of the list key, so invalidating it refetches
   * every page and every search. Anything that must invalidate only itself is
   * invalidated with `exact: true` — see the form draft, where a prefix match
   * once discarded a fresh answer.
   */
  eventEntriesAll: (eventId: string) => ['events', 'detail', eventId, 'entries'] as const,
  eventEntryList: (eventId: string, filters: Record<string, unknown>) =>
    ['events', 'detail', eventId, 'entries', 'list', filters] as const,
  eventEntry: (eventId: string, entryId: string) =>
    ['events', 'detail', eventId, 'entries', 'detail', entryId] as const,

  /**
   * The administrative participants screen (phase 10).
   *
   * A sibling of `eventEntries*` rather than a child, because the two carry
   * different shapes of the same rows: the entries keys hold the registration
   * DTO, these hold the administrative one with its revision token and
   * disposition. Sharing a key would hand a component whichever was cached
   * last.
   *
   * `participantsAll` is a PREFIX of the list, the detail and the summary, so
   * one invalidation after a mutation refreshes the table, the open panel and
   * the counts together — which is exactly what changes when somebody is
   * disqualified.
   */
  participantsAll: (eventId: string) =>
    ['events', 'detail', eventId, 'participants'] as const,
  participantList: (eventId: string, filters: Record<string, unknown>) =>
    ['events', 'detail', eventId, 'participants', 'list', filters] as const,
  participantDetail: (eventId: string, entryId: string) =>
    ['events', 'detail', eventId, 'participants', 'detail', entryId] as const,
  participantSummary: (eventId: string) =>
    ['events', 'detail', eventId, 'participants', 'summary'] as const,

  /**
   * The draw (phase 11).
   *
   * ONE key for the event's draw, because there is one draw per event and it
   * never changes once it exists. No list key, no detail key, no filters: a
   * draw is not a collection.
   *
   * A sibling of `participants*` rather than a child, so invalidating the
   * participants subtree after a disqualification does not discard the draw —
   * and, more importantly, so refetching the draw does not silently refetch the
   * personal-data screens beside it.
   */
  eventDraw: (eventId: string) => ['events', 'detail', eventId, 'draw'] as const,

  /**
   * The administrative results screen (phase 12).
   *
   * A sibling of `eventDraw`, and a CHILD of `eventDetail` — which means
   * anything invalidating the detail with a prefix match invalidates this too.
   * That is usually what you want (publishing changes the event's available
   * actions) and occasionally not, so the mutations below invalidate the detail
   * with `exact: true` and name this key when they mean this key. Phase 11
   * found the cost of getting that backwards: a prefix match discarded a result
   * that had just been written.
   */
  eventResults: (eventId: string) => ['events', 'detail', eventId, 'results'] as const,

  /**
   * The PUBLIC results page, addressed by slug.
   *
   * Under the `public` namespace with the public event, and deliberately not
   * under `events`: the two carry different shapes of the same facts — one
   * names winners with their email addresses, the other shows "Maria D." — and
   * a shared key would eventually hand a component the wrong one.
   */
  publicEventResults: (slug: string) => ['public', 'event', slug, 'results'] as const,
};

export const POLL_INTERVAL_MS = 4000;
