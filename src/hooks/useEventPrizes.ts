import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type PrizeQueryParams } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type {
  CreateEventPrizeInput,
  PrizeTransitionAction,
  ReorderEventPrizeItem,
  UpdateEventPrizeInput,
} from '@shared/types';

export function useEventPrizes(eventId: string, params: PrizeQueryParams) {
  return useQuery({
    queryKey: queryKeys.eventPrizeList(eventId, params as Record<string, unknown>),
    queryFn: () => api.listEventPrizes(eventId, params),
    enabled: Boolean(eventId),
    placeholderData: keepPreviousData,
  });
}

export function useEventPrize(eventId: string, prizeId: string | null) {
  return useQuery({
    queryKey: queryKeys.eventPrizeDetail(eventId, prizeId ?? ''),
    queryFn: () => api.getEventPrize(eventId, prizeId as string),
    enabled: Boolean(eventId && prizeId),
    retry: false,
  });
}

/**
 * Invalidates everything a prize mutation can affect.
 *
 * The EVENT detail is refreshed too: adding or removing prizes changes whether
 * the event can be deleted and whether it can be marked ready for the draw, and
 * a stale detail page would keep offering the wrong buttons.
 */
function usePrizeInvalidation(eventId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: queryKeys.eventPrizesAll(eventId) });
    void qc.invalidateQueries({ queryKey: queryKeys.eventDetail(eventId) });
    void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
  };
}

export function useCreateEventPrize(eventId: string) {
  const invalidate = usePrizeInvalidation(eventId);
  return useMutation({
    mutationFn: (input: CreateEventPrizeInput) => api.createEventPrize(eventId, input),
    onSuccess: invalidate,
  });
}

export function useUpdateEventPrize(eventId: string) {
  const invalidate = usePrizeInvalidation(eventId);
  return useMutation({
    mutationFn: ({ prizeId, input }: { prizeId: string; input: UpdateEventPrizeInput }) =>
      api.updateEventPrize(eventId, prizeId, input),
    onSuccess: invalidate,
  });
}

export function usePrizeTransition(eventId: string) {
  const invalidate = usePrizeInvalidation(eventId);
  return useMutation({
    mutationFn: ({
      prizeId,
      action,
      expectedRevision,
    }: {
      prizeId: string;
      action: PrizeTransitionAction;
      expectedRevision?: number;
    }) => api.transitionEventPrize(eventId, prizeId, action, expectedRevision),
    // No optimistic update: archiving is irreversible in this phase, so the UI
    // waits for the server rather than showing a state it may have to undo.
    onSuccess: invalidate,
  });
}

export function useDeleteEventPrize(eventId: string) {
  const qc = useQueryClient();
  const invalidate = usePrizeInvalidation(eventId);
  return useMutation({
    mutationFn: ({ prizeId, expectedRevision }: { prizeId: string; expectedRevision?: number }) =>
      api.deleteEventPrize(eventId, prizeId, expectedRevision),
    onSuccess: (_result, variables) => {
      qc.removeQueries({ queryKey: queryKeys.eventPrizeDetail(eventId, variables.prizeId) });
      invalidate();
    },
  });
}

export function useReorderEventPrizes(eventId: string) {
  const invalidate = usePrizeInvalidation(eventId);
  return useMutation({
    mutationFn: (items: ReorderEventPrizeItem[]) => api.reorderEventPrizes(eventId, items),
    onSuccess: invalidate,
  });
}
