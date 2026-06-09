import type { ApiErrorCode } from '../../shared/types';

export function json(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function error(
  status: number,
  code: ApiErrorCode,
  message: string,
  fields?: Record<string, string>,
): Response {
  return json(status, {
    error: fields ? { code, message, fields } : { code, message },
  });
}

export function notImplemented(): Response {
  return error(500, 'SERVER_ERROR', 'Not implemented');
}
