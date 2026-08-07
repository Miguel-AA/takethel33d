import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type EventQueryParams } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type {
  CreateEventInput,
  DuplicateEventInput,
  EventTransitionAction,
  UpdateEventInput,
} from '@shared/types';

export function useEvents(params: EventQueryParams) {
  return useQuery({
    queryKey: queryKeys.eventList(params as Record<string, unknown>),
    queryFn: () => api.listEvents(params),
    placeholderData: keepPreviousData,
  });
}

export function useEvent(id: string | null) {
  return useQuery({
    queryKey: queryKeys.eventDetail(id ?? ''),
    queryFn: () => api.getEvent(id as string),
    enabled: Boolean(id),
    retry: false,
  });
}

/**
 * Invalidates everything a mutation can affect.
 *
 * A lifecycle action changes the event, its position in filtered lists, and the
 * audit trail — refreshing only the detail would leave the list showing a stale
 * status.
 */
function useEventInvalidation() {
  const qc = useQueryClient();
  return (id?: string) => {
    void qc.invalidateQueries({ queryKey: queryKeys.eventsAll });
    void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
    if (id) void qc.invalidateQueries({ queryKey: queryKeys.eventDetail(id) });
  };
}

export function useCreateEvent() {
  const invalidate = useEventInvalidation();
  return useMutation({
    mutationFn: (input: CreateEventInput) => api.createEvent(input),
    onSuccess: (event) => invalidate(event.id),
  });
}

export function useUpdateEvent(id: string) {
  const invalidate = useEventInvalidation();
  return useMutation({
    mutationFn: (input: UpdateEventInput) => api.updateEvent(id, input),
    onSuccess: () => invalidate(id),
  });
}

export function useDuplicateEvent(id: string) {
  const invalidate = useEventInvalidation();
  return useMutation({
    mutationFn: (input: DuplicateEventInput) => api.duplicateEvent(id, input),
    onSuccess: (event) => invalidate(event.id),
  });
}

export function useEventTransition(id: string) {
  const invalidate = useEventInvalidation();
  return useMutation({
    mutationFn: ({
      action,
      expectedRevision,
    }: {
      action: EventTransitionAction;
      expectedRevision?: number;
    }) => api.transitionEvent(id, action, expectedRevision),
    // No optimistic update: a lifecycle change is irreversible, so the UI waits
    // for the server rather than showing a state that may be rejected.
    onSuccess: () => invalidate(id),
  });
}

export function useDeleteEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedRevision }: { id: string; expectedRevision?: number }) =>
      api.deleteEvent(id, expectedRevision),
    onSuccess: (_result, variables) => {
      qc.removeQueries({ queryKey: queryKeys.eventDetail(variables.id) });
      void qc.invalidateQueries({ queryKey: queryKeys.eventsAll });
      void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
    },
  });
}
