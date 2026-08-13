// Terminal input for the administrative CLIs.
//
// EXTRACTED, not rewritten: `promptHidden` below is the implementation
// `bootstrap-admin.ts` has always used, moved here so the credential-reset tool
// uses the SAME code rather than a second copy that could drift. A password
// prompt is exactly the kind of thing that must not exist twice.
//
// Its fidelity was measured during the 13.10 investigation rather than assumed:
// piped input terminated by LF and by CRLF both round-trip byte-identically, so
// it neither strips a character nor leaves a carriage return behind.
//
// This module has no imports beyond `node:` builtins so it can run under plain
// `node` alongside the scripts that use it.

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Reads a line, echoing it. For values that are not secret. */
export async function promptVisible(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/**
 * Reads a line without echoing it.
 *
 * The prompt itself is written, then the output stream is muted so the typed
 * characters never reach the terminal — and therefore never appear in a
 * scrollback buffer, a screen share or a recording.
 *
 * The value is returned OPAQUE. Nothing here trims it, lowercases it or
 * normalises its Unicode: a password is a byte sequence the user chose, and
 * every transformation is a way for what was stored to differ from what is
 * typed later.
 */
export async function promptHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: unknown, _encoding: unknown, callback: () => void) {
      if (!muted) process.stdout.write(chunk as Uint8Array);
      callback();
    },
  });

  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, resolve);
      muted = true;
    });
    process.stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}

/**
 * True when this process can actually read a hidden password.
 *
 * Without a TTY the prompt renders and immediately reads end-of-file, so the
 * script would carry on with an empty string and fail somewhere less obvious.
 * Checked up front so the refusal names the real problem.
 */
export function canPromptInteractively(): boolean {
  return Boolean(process.stdin.isTTY);
}
