import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type { PublicEntryResponse, PublicSubmissionInput } from '@shared/types';

/**
 * The public event page.
 *
 * `refetchOnWindowFocus` is switched OFF here, against the app-wide default,
 * and that is a correctness decision rather than a performance one: a refetch
 * mints a NEW form token bound to whatever version the event serves at that
 * moment. Somebody who tabs away mid-form and comes back would otherwise have
 * the version underneath them silently replaced. The token the wizard holds is
 * captured once and kept until the visitor reloads deliberately.
 */
export function usePublicEvent(slug: string) {
  return useQuery({
    queryKey: queryKeys.publicEvent(slug),
    queryFn: () => api.getPublicEvent(slug),
    refetchOnWindowFocus: false,
    // The page is a snapshot of a moment; re-reading it behind the user's back
    // is exactly what must not happen while a form is being filled in.
    staleTime: Infinity,
    retry: (failureCount, error) => {
      const status = (error as Error & { status?: number }).status;
      // A missing event will not appear by retrying, and a rate-limited caller
      // must not be made to hammer harder.
      if (status === 404 || status === 429) return false;
      return failureCount < 2;
    },
  });
}

export function useSubmitPublicEntry(slug: string) {
  return useMutation<PublicEntryResponse, Error, PublicSubmissionInput>({
    mutationFn: (body) => api.submitPublicEntry(slug, body),
    // No retry. The submission is idempotent by key, so a retry would be safe —
    // but an automatic one would hide a real failure from somebody who needs to
    // know whether they are registered.
    retry: false,
  });
}
