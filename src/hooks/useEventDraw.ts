import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type { DrawResponse, DrawStatusResponse } from '@shared/types';

/**
 * The event's draw, and whether one can be run.
 *
 * `retry: false` for the same reason the participant detail uses it: the
 * interesting failures — a 404 for an event that is not there, a 401 for an
 * expired session — do not get better by being asked again.
 *
 * NO POLLING. A draw does not appear on its own; it appears because somebody in
 * this browser pressed the button, and the mutation invalidates this key when
 * they do. Polling would repeatedly refetch a body full of winners' names for
 * no reason.
 */
export function useEventDraw(eventId: string) {
  return useQuery({
    queryKey: queryKeys.eventDraw(eventId),
    queryFn: () => api.getDraw(eventId),
    enabled: Boolean(eventId),
    retry: false,
  });
}

/**
 * Runs the draw.
 *
 * `retry: false` IS A SAFETY PROPERTY HERE, not a preference. An automatic
 * retry on a request whose response was lost in transit would be a second
 * attempt at the one operation that must happen exactly once. The server would
 * refuse it — `ux_draws_event` sees to that — but the operator would be shown a
 * conflict for a draw that actually succeeded, which is a worse thing to be
 * told than a plain failure.
 *
 * The mutation takes NO ARGUMENT. There is nothing about a draw for a caller to
 * specify, and a hook that accepted a payload would be an invitation to add one.
 */
export function useRunDraw(eventId: string) {
  const qc = useQueryClient();

  return useMutation<DrawResponse, Error, void>({
    mutationFn: () => api.runDraw(eventId),
    onSuccess: (result) => {
      // Written straight into the cache rather than refetched: the response IS
      // the draw, and a refetch would ask the server to re-serialise the same
      // rows a moment after it wrote them.
      qc.setQueryData<DrawStatusResponse>(queryKeys.eventDraw(eventId), (previous) =>
        previous
          ? {
              ...previous,
              ...result,
              // The readiness the server sent described a draw that had not
              // happened yet. Rewritten from what did happen, so the panel
              // cannot offer the button again while the refetch is in flight.
              readiness: {
                ...previous.readiness,
                eventStatus: result.eventStatus,
                canRun: false,
                blockers: ['DRAW_ALREADY_COMPLETED'],
              },
            }
          : previous,
      );
      // `exact: true`, and it is load-bearing.
      //
      // `eventDetail(id)` is `['events','detail',id]`, which is a PREFIX of the
      // draw key — so a prefix invalidation would discard the result that was
      // just written above and refetch it, sending a body full of winners'
      // names again for nothing. The same trap the form draft documented in
      // phase 6, where a prefix match once threw away a fresh answer.
      //
      // The draw key itself is deliberately not invalidated at all: the
      // response IS the draw, straight from the server that wrote it.
      void qc.invalidateQueries({ queryKey: queryKeys.eventDetail(eventId), exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.participantsAll(eventId) });
      void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
    },
    retry: false,
  });
}
