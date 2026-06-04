// POST /api/jotform/webhook/[secret] — public, protected by URL secret.
//
// Jotform posts here on every form submission as multipart/form-data with
// `submissionID`, `formID`, and `rawRequest` (a JSON string of all answers).
// We always return 200 for any payload we cannot use — Jotform retries
// aggressively on 5xx and we don't want loops. Only real D1 errors bubble
// up as 5xx so they end up in the worker logs.

import { json } from '../../../_shared/responses';
import { timingSafeEqual } from '../../../_shared/auth';
import { insertAttendee } from '../../../_shared/attendees';
import { organizerEmail, sendResendEmail } from '../../../_shared/emails';
import {
  isAllowedFormId,
  JotformParseError,
  parseJotformPayload,
} from '../../../_shared/jotform';

type Env = {
  DB: D1Database;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  ORGANIZER_EMAIL: string;
  JOTFORM_WEBHOOK_SECRET: string;
  JOTFORM_ALLOWED_FORM_IDS?: string;
};

export const onRequestPost: PagesFunction<Env, 'secret'> = async (ctx) => {
  const secret = ctx.params.secret;
  if (
    typeof secret !== 'string' ||
    !ctx.env.JOTFORM_WEBHOOK_SECRET ||
    !timingSafeEqual(secret, ctx.env.JOTFORM_WEBHOOK_SECRET)
  ) {
    // 404 instead of 401 so probes can't tell the route exists.
    return new Response('Not found', { status: 404 });
  }

  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch (err) {
    console.error('jotform webhook: bad body', err);
    return json(200, { ok: false, ignored: 'bad_form_data' });
  }

  let payload;
  try {
    payload = parseJotformPayload(form);
  } catch (err) {
    if (err instanceof JotformParseError) {
      console.warn('jotform webhook: parse error', err.code, err.message, err.details);
      return json(200, { ok: false, ignored: err.code });
    }
    console.error('jotform webhook: unexpected parse failure', err);
    return json(200, { ok: false, ignored: 'unknown' });
  }

  if (
    !isAllowedFormId(payload.formId, ctx.env.JOTFORM_ALLOWED_FORM_IDS, {
      requireConfigured: true,
    })
  ) {
    console.warn('jotform webhook: formID not in allowlist', payload.formId);
    return json(200, { ok: false, ignored: 'form_not_allowed' });
  }

  const result = await insertAttendee(
    ctx.env.DB,
    payload.data,
    payload.submissionId,
  );

  if (result.kind === 'idempotent') {
    return json(200, {
      ok: true,
      idempotent: true,
      participantNumber: result.attendee.participantNumber,
      submissionId: payload.submissionId,
    });
  }

  if (result.kind === 'email_exists') {
    // Duplicate email coming via a NEW submissionID — the asistente
    // already registered through a different channel. Record this in
    // logs but don't fail; Jotform shouldn't retry.
    console.warn(
      'jotform webhook: duplicate email for new submission',
      payload.submissionId,
      payload.data.email,
    );
    return json(200, { ok: false, ignored: 'email_exists' });
  }

  // Inserted — notify organizer (fire and forget, non-fatal).
  if (ctx.env.RESEND_API_KEY && ctx.env.RESEND_FROM && ctx.env.ORGANIZER_EMAIL) {
    const { subject, html, text } = organizerEmail(result.attendee);
    ctx.waitUntil(
      sendResendEmail({
        apiKey: ctx.env.RESEND_API_KEY,
        from: ctx.env.RESEND_FROM,
        to: ctx.env.ORGANIZER_EMAIL,
        subject,
        html,
        text,
      }),
    );
  }

  return json(200, {
    ok: true,
    participantNumber: result.attendee.participantNumber,
    submissionId: payload.submissionId,
  });
};
