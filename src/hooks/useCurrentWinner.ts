import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';

export function useCurrentWinner() {
  return useQuery({
    queryKey: queryKeys.raffleCurrent,
    queryFn: () => api.currentRaffle(),
  });
}
