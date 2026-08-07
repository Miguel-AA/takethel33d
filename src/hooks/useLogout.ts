import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * Signs out. Unlike the previous client-only logout, this calls the backend so
 * the session row is actually revoked and the cookie is expired by the server.
 *
 * The local cache is cleared in `onSettled`, not `onSuccess`: if the network
 * call fails the user must still end up signed out locally rather than being
 * left looking authenticated.
 */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSettled: () => {
      qc.clear();
    },
  });
}
