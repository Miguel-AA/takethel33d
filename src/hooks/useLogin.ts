import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { setToken } from '../lib/auth';

export function useLogin() {
  return useMutation({
    mutationFn: (password: string) => api.login(password),
    onSuccess: (data) => {
      setToken(data.token, data.expiresAt);
    },
  });
}
