import type { ApiErrorCode } from '../../shared/types';

/** Header carrying the correlation id back to the client. */
export const REQUEST_ID_HEADER = 'X-Request-ID';

/**
 * Builds a JSON response.
 *
 * `headers` is merged through the Headers API rather than object spread,
 * because spreading a `Headers` instance silently yields `{}` and because
 * `Set-Cookie` may legitimately appear more than once (logout clears two
 * cookie names). Pass an array of pairs to emit repeated headers.
 */
export function json(status: number, body: unknown, headers?: HeadersInit): Response {
  const merged = new Headers();
  merged.set('Content-Type', 'application/json');

  if (headers) {
    // The raw pairs are walked directly rather than being funnelled through a
    // `Headers` constructor: that would fold repeated `Set-Cookie` values into
    // one comma-joined string, and logout legitimately emits two.
    const entries: Array<[string, string]> = [];
    if (Array.isArray(headers)) {
      for (const [key, value] of headers) entries.push([key, value]);
    } else if (headers instanceof Headers) {
      headers.forEach((value, key) => entries.push([key, value]));
    } else {
      for (const [key, value] of Object.entries(headers)) entries.push([key, value]);
    }

    for (const [key, value] of entries) {
      if (key.toLowerCase() === 'set-cookie') merged.append(key, value);
      else merged.set(key, value);
    }
  }

  return new Response(JSON.stringify(body), { status, headers: merged });
}

export interface ErrorOptions {
  headers?: HeadersInit;
  /**
   * Correlation id. Echoed in the body AND the `X-Request-ID` header so a user
   * reporting a failure can quote a value that ties to the exact audit row and
   * log line.
   */
  requestId?: string;
}

export function error(
  status: number,
  code: ApiErrorCode,
  message: string,
  fields?: Record<string, string>,
  options: ErrorOptions = {},
): Response {
  const body = {
    error: {
      code,
      message,
      ...(fields ? { fields } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
    },
  };

  const headers: Array<[string, string]> = [];
  if (options.headers) {
    const provided = new Headers(options.headers);
    provided.forEach((value, key) => headers.push([key, value]));
  }
  if (options.requestId) headers.push([REQUEST_ID_HEADER, options.requestId]);

  return json(status, body, headers);
}

/**
 * Stamps the correlation id onto an existing response.
 *
 * Used by the middleware so EVERY response carries the header, including those
 * produced by handlers that know nothing about request context. The response is
 * cloned rather than mutated because a `Response` returned from `next()` may
 * have immutable headers.
 */
export function withRequestId(response: Response, requestId: string): Response {
  if (response.headers.get(REQUEST_ID_HEADER)) return response;

  try {
    const headers = new Headers(response.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    // Never let correlation bookkeeping break a real response.
    return response;
  }
}

/**
 * Rejects a state-changing request that is not JSON.
 *
 * This is a CSRF control, not a formality. A cross-origin HTML form can only
 * send `application/x-www-form-urlencoded`, `multipart/form-data` or
 * `text/plain`; it cannot set `application/json` without triggering a CORS
 * preflight that this API never approves. Because `Request.json()` parses a
 * body regardless of its declared type, an unguarded handler would accept a
 * forged cross-site form post — which on the login endpoint means an attacker
 * can log a victim's browser into the ATTACKER's account (session fixation).
 *
 * Returns a 415 response when the request must be refused, or null to proceed.
 *
 * Prefer `readJsonBody` (functions/_shared/payload.ts) for new handlers: it
 * applies this check plus size limits and safe parsing.
 */
export function requireJsonRequest(
  request: Request,
  requestId?: string,
): Response | null {
  const contentType = request.headers.get('Content-Type') ?? '';
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  if (mediaType === 'application/json') return null;

  return error(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'Content-Type must be application/json',
    undefined,
    { requestId },
  );
}

export function notImplemented(): Response {
  return error(500, 'SERVER_ERROR', 'Not implemented');
}
