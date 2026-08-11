import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AdminParticipantQueryParams } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type {
  DisqualifyEntryInput,
  ParticipantMutationResponse,
  ReinstateEntryInput,
} from '@shared/types';

export function useAdminParticipants(eventId: string, params: AdminParticipantQueryParams) {
  return useQuery({
    queryKey: queryKeys.participantList(eventId, params as Record<string, unknown>),
    queryFn: () => api.listAdminParticipants(eventId, params),
    enabled: Boolean(eventId),
    // Keeps the current page on screen while the next one loads, so paging and
    // typing in the search box do not blank the table under the operator.
    placeholderData: keepPreviousData,
  });
}

/**
 * The counts above the table.
 *
 * A query of its own rather than a field on the list, because it describes the
 * whole event and does not change when a filter does. Folding it in would
 * recompute six aggregates on every keystroke.
 */
export function useAdminParticipantSummary(eventId: string) {
  return useQuery({
    queryKey: queryKeys.participantSummary(eventId),
    queryFn: () => api.getAdminParticipantSummary(eventId),
    enabled: Boolean(eventId),
  });
}

/**
 * One participant's file.
 *
 * `retry: false` because the interesting failures — a 404 for an entry
 * belonging to another event, a 401 for an expired session — do not get better
 * by being asked again, and retrying a personal-data read writes a second
 * unnecessary audit row.
 */
export function useAdminParticipant(eventId: string, entryId: string | null) {
  return useQuery({
    queryKey: queryKeys.participantDetail(eventId, entryId ?? ''),
    queryFn: () => api.getAdminParticipant(eventId, entryId as string),
    enabled: Boolean(eventId && entryId),
    retry: false,
  });
}

/**
 * Invalidates everything one disposition change can move.
 *
 * The list (a row's status and revision), the open detail (its actions), and
 * the summary (four of its six counts). ONE prefix covers all three, so this is
 * a single invalidation rather than a burst — and it deliberately does not
 * touch anything outside the participants subtree: a disqualification changes
 * nothing about the event, its prizes or its form.
 *
 * The audit list IS invalidated, because a new row was just written to it.
 */
function useDispositionInvalidation(eventId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: queryKeys.participantsAll(eventId) });
    void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
  };
}

export function useDisqualifyParticipant(eventId: string, entryId: string) {
  const invalidate = useDispositionInvalidation(eventId);
  return useMutation<ParticipantMutationResponse, Error, DisqualifyEntryInput>({
    mutationFn: (body) => api.disqualifyParticipant(eventId, entryId, body),
    onSuccess: invalidate,
    // No retry. A revision conflict is the server telling us the row moved, and
    // repeating the same stale revision would only fail again.
    retry: false,
  });
}

export function useReinstateParticipant(eventId: string, entryId: string) {
  const invalidate = useDispositionInvalidation(eventId);
  return useMutation<ParticipantMutationResponse, Error, ReinstateEntryInput>({
    mutationFn: (body) => api.reinstateParticipant(eventId, entryId, body),
    onSuccess: invalidate,
    retry: false,
  });
}
