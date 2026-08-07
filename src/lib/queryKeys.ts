export const queryKeys = {
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
};

export const POLL_INTERVAL_MS = 4000;
