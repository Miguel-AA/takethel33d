import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type { RaffleDrawRequest } from '@shared/types';

export function useDrawRaffle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RaffleDrawRequest) => api.drawRaffle(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.raffleCurrent });
    },
  });
}
