// POST /api/register — public legacy endpoint.
//
// The production lead flow goes through Jotform → webhook now, so this
// endpoint is kept as a fallback for tests, mock dev mode, and any direct
// API client. It shares the same insertAttendee() helper that the webhook
// uses, so participant-number assignment is consistent.

import { registerSchema } from '../../shared/schemas';
import { error, json } from '../_shared/responses';
import { insertAttendee } from '../_shared/attendees';
import { organizerEmail, sendResendEmail } from '../_shared/emails';

type Env = {
  DB: D1Database;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  ORGANIZER_EMAIL: string;
};

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const raw = await ctx.request.json().catch(() => null);
  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      if (path) fields[path] = issue.message;
    }
    return error(400, 'VALIDATION_ERROR', 'Validation failed', fields);
  }

  const result = await insertAttendee(ctx.env.DB, parsed.data);
  if (result.kind === 'email_exists') {
    return error(409, 'EMAIL_EXISTS', 'Email ya registrado');
  }

  const attendee = result.attendee;

  const { subject, html, text } = organizerEmail(attendee);
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

  return json(201, {
    id: attendee.id,
    participantNumber: attendee.participantNumber,
    createdAt: attendee.createdAt,
  });
};
