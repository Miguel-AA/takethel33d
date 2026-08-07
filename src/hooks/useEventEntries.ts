import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type EntryQueryParams } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type { SubmittedAnswer } from '@shared/types';

export function useEventEntries(eventId: string, params: EntryQueryParams) {
  return useQuery({
    queryKey: queryKeys.eventEntryList(eventId, params as Record<string, unknown>),
    queryFn: () => api.listEventEntries(eventId, params),
    enabled: Boolean(eventId),
    // Keeps the previous page on screen while the next one loads, so paging
    // does not blank the table.
    placeholderData: keepPreviousData,
  });
}

/**
 * One participation, in full.
 *
 * `retry: false` because the interesting failures here — a 404 for an entry
 * belonging to another event, a 401 for an expired session — do not get better
 * by being asked again, and retrying a personal-data read is a second
 * unnecessary audit row.
 */
export function useEventEntry(eventId: string, entryId: string | null) {
  return useQuery({
    queryKey: queryKeys.eventEntry(eventId, entryId ?? ''),
    queryFn: () => api.getEventEntry(eventId, entryId as string),
    enabled: Boolean(eventId && entryId),
    retry: false,
  });
}

/**
 * Records a participation.
 *
 * Invalidates the EVENT detail as well as the list: an event that has entries
 * can no longer be deleted, and a stale detail page would keep offering a
 * button the server is now going to refuse.
 */
export function useCreateEventEntry(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (answers: SubmittedAnswer[]) => api.createEventEntry(eventId, answers),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.eventEntriesAll(eventId) });
      void qc.invalidateQueries({ queryKey: queryKeys.eventDetail(eventId), exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
    },
  });
}
