import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { POLL_INTERVAL_MS, queryKeys } from '../lib/queryKeys';

export function useMetrics() {
  return useQuery({
    queryKey: queryKeys.metrics,
    queryFn: () => api.metrics(),
    refetchInterval: POLL_INTERVAL_MS,
  });
}
