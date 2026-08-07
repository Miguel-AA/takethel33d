// Minimal structured logger.
//
// Cloudflare captures stdout/stderr per invocation, so a JSON line per event is
// queryable in the dashboard and in Logpush. Everything logged is redacted
// first — a log line is durable storage like any other.
//
// Deliberately quiet: this is NOT request tracing. It fires for internal
// failures, audit-write failures and high-severity security events. Logging
// every request would bury the signal and cost money.

import { redact } from './redact';
import { nowIso } from './time';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  /** Correlates with the audit row and the client's X-Request-ID. */
  requestId?: string;
  /** Audit action or a short machine-readable event name. */
  action?: string;
  /** Typed API error code when the line accompanies a response. */
  code?: string;
  [key: string]: unknown;
}

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

type Sink = (level: LogLevel, line: string) => void;

const consoleSink: Sink = (level, line) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

let sink: Sink = consoleSink;

/** Swaps the destination. Tests use this to capture lines without stdout noise. */
export function setLogSink(next: Sink | null): void {
  sink = next ?? consoleSink;
}

/**
 * Strips characters that let a log line be forged or spoofed.
 *
 * Newlines would create a second entry; C0/C1 controls include ANSI escape
 * introducers that can repaint a terminal; the bidi overrides can visually
 * reverse text so a line reads as something it is not. All collapse to a space
 * rather than vanishing, so the tampering remains visible.
 */
// Built from a string rather than a regex literal: matching control
// characters is the whole point here, and a literal trips `no-control-regex`
// (a rule aimed at control characters appearing by ACCIDENT).
const UNSAFE_LOG_CHARS = new RegExp(
  [
    '[',
    '\\u0000-\\u001f', // C0 controls: CR/LF (entry forging), ESC (ANSI escapes)
    '\\u007f-\\u009f', // DEL and C1 controls
    '\\u200e\\u200f', // LTR/RTL marks
    '\\u202a-\\u202e', // bidi embedding/override
    '\\u2066-\\u2069', // bidi isolates
    ']',
  ].join(''),
  'g',
);

function sanitizeMessage(value: string): string {
  return value.replace(UNSAFE_LOG_CHARS, ' ').slice(0, 500);
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  // Every field is redacted: a caller passing an error object that happens to
  // contain a token must not turn a log line into a credential leak.
  const safeFields = fields ? redact(fields) : null;

  const payload = {
    level,
    time: nowIso(),
    message: sanitizeMessage(String(message)),
    ...(safeFields && typeof safeFields === 'object' && !Array.isArray(safeFields)
      ? safeFields
      : {}),
  };

  let line: string;
  try {
    line = JSON.stringify(payload);
  } catch {
    line = JSON.stringify({ level, time: nowIso(), message: 'log serialization failed' });
  }

  // Logging is observability, never a failure mode for the operation being
  // logged: a broken sink must not propagate into the caller.
  try {
    sink(level, line);
  } catch {
    /* deliberately ignored */
  }
}

export const logger: Logger = {
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};

/**
 * Summarises an unknown thrown value for logging.
 *
 * Never returns a stack trace: stacks reveal file layout and library versions,
 * and they are of little use in an edge runtime. The message is truncated.
 */
export function describeError(err: unknown): { errorName: string; errorMessage: string } {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message.replace(/[\r\n]+/g, ' ').slice(0, 300),
    };
  }
  return { errorName: 'UnknownError', errorMessage: String(err).slice(0, 300) };
}
