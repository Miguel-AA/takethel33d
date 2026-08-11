import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type { AdminEventResults, PublishResultsResponse } from '@shared/types';

/**
 * What happened, and what has been done about it.
 *
 * `retry: false` for the same reason the draw uses it: the interesting failures
 * — a 404 for an event that is not there, a 401 for an expired session — do not
 * get better by being asked again, and this body carries winners' names and
 * email addresses.
 *
 * No polling. A publication does not appear on its own.
 */
export function useEventResults(eventId: string) {
  return useQuery({
    queryKey: queryKeys.eventResults(eventId),
    queryFn: () => api.getEventResults(eventId),
    enabled: Boolean(eventId),
    retry: false,
  });
}

/**
 * Publishes the results.
 *
 * `retry: false` IS A SAFETY PROPERTY, not a preference. An automatic retry
 * after a lost response would be a second attempt at an irreversible act. The
 * server answers it with the existing publication rather than an error, so
 * nothing would break — but the client should not be quietly making the attempt.
 *
 * The mutation takes NO ARGUMENT. There is nothing about a publication for a
 * caller to specify, and a hook that accepted a payload would be an invitation
 * to add one.
 */
export function usePublishResults(eventId: string) {
  const qc = useQueryClient();

  return useMutation<PublishResultsResponse, Error, void>({
    mutationFn: () => api.publishResults(eventId),
    onSuccess: (result) => {
      // Written straight into the cache: the response IS the new state, and
      // refetching would ask the server to re-serialise winners' names and
      // email addresses a moment after sending them.
      qc.setQueryData<AdminEventResults>(queryKeys.eventResults(eventId), result.results);

      // `exact: true` on the event detail. `eventDetail(id)` is a PREFIX of
      // `eventResults(id)`, so a prefix invalidation would discard the result
      // just written above and refetch it — the mistake phase 11's validation
      // found on the draw screen.
      void qc.invalidateQueries({ queryKey: queryKeys.eventDetail(eventId), exact: true });
      // The public page gains a link to the results, so its cached copy is now
      // out of date.
      void qc.invalidateQueries({ queryKey: queryKeys.publicAll });
      void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
    },
    retry: false,
  });
}

/**
 * The published winners, as the world sees them.
 *
 * Unauthenticated and addressed by slug. `retry: false` because the one
 * interesting failure — "there are no published results here" — is a permanent
 * answer for an event nobody has published, not a transient one.
 */
export function usePublicEventResults(slug: string) {
  return useQuery({
    queryKey: queryKeys.publicEventResults(slug),
    queryFn: () => api.getPublicEventResults(slug),
    enabled: Boolean(slug),
    retry: false,
  });
}
