import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type { RegisterRequest } from '@shared/types';

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterRequest) => api.register(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.attendeesAll });
      qc.invalidateQueries({ queryKey: queryKeys.metrics });
    },
  });
}
