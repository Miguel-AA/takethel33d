const TOKEN_KEY = 'gg.token';
const TOKEN_EXPIRY_KEY = 'gg.token.expiresAt';

export function getToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const expiresAt = localStorage.getItem(TOKEN_EXPIRY_KEY);
  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    clearToken();
    return null;
  }
  return token;
}

export function setToken(token: string, expiresAt: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(TOKEN_EXPIRY_KEY, expiresAt);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}
