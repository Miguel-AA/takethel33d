import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type { AdminLoginInput } from '@shared/types';

/**
 * Signs an administrator in. The server installs the session cookie; nothing
 * is stored client-side, so success is recorded by seeding the session query
 * with the admin the login response returned (which avoids an immediate
 * refetch of `/me` right after logging in).
 */
export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: AdminLoginInput) =>
      api.login(email, password),
    onSuccess: (data) => {
      qc.setQueryData(queryKeys.session, { admin: data.admin });
    },
  });
}
