import { useQuery } from '@tanstack/react-query';
import { api, isSessionEnded } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';

/**
 * The authenticated administrator, resolved from the server.
 *
 * The session cookie is HttpOnly, so the client cannot inspect it: this query
 * IS the source of truth for "am I signed in?".
 *
 * Retry policy matters for correctness, not just UX. A 401 is a DEFINITIVE
 * answer and must not be retried. Anything else (offline, DNS, 5xx) is
 * transient and IS retried — otherwise a momentary network blip would be
 * indistinguishable from "your session ended" and would eject a signed-in
 * administrator.
 *
 * `enabled` lets public pages skip the request entirely, so an anonymous
 * visitor browsing the marketing site never triggers a pointless 401.
 */
export function useSession(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: () => api.me(),
    enabled: options.enabled ?? true,
    retry: (failureCount, error) => {
      if (isSessionEnded(error)) return false;
      return failureCount < 2;
    },
    staleTime: 60_000,
  });
}
