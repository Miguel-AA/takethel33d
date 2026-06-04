import type { Attendee, InsuranceType } from '@shared/types';

interface SendArgs {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export async function sendResendEmail(args: SendArgs): Promise<boolean> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify({
        from: args.from,
        to: [args.to],
        subject: args.subject,
        html: args.html,
        text: args.text,
        reply_to: args.replyTo,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function pad(n: number): string {
  return n.toString().padStart(3, '0');
}

function insuranceLabel(t: InsuranceType): string {
  switch (t) {
    case 'HOUSE':
      return 'House';
    case 'AUTO':
      return 'Auto';
    case 'LIFE':
      return 'Life';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shellHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;box-shadow:0 1px 3px rgba(15,23,42,0.06);overflow:hidden;">
            <tr>
              <td style="background:#1f4fdb;padding:20px 24px;color:#ffffff;font-weight:700;font-size:18px;">
                Gifted Grads Insurance
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                ${body}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;background:#f8fafc;color:#64748b;font-size:12px;text-align:center;">
                Este mensaje fue generado automáticamente por la plataforma de leads.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function organizerEmail(attendee: Attendee): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Nuevo lead de seguro #${pad(attendee.participantNumber)} — ${attendee.nombre}`;
  const rows: Array<[string, string]> = [
    ['Número', `#${pad(attendee.participantNumber)}`],
    ['Nombre', attendee.nombre],
    ['Email', attendee.email],
    ['Teléfono', attendee.telefono],
    ['Tipo de seguro', insuranceLabel(attendee.insuranceType)],
    ['Recibido', new Date(attendee.createdAt).toLocaleString('es', { timeZone: 'UTC' })],
  ];
  const tableRows = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:140px;">${escapeHtml(k)}</td><td style="padding:8px 0;color:#0f172a;font-size:14px;font-weight:500;">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const html = shellHtml(
    subject,
    `<p style="margin:0 0 8px;font-size:14px;color:#475569;">Llegó un nuevo lead de seguro:</p>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2e8f0;margin-top:12px;">
       ${tableRows}
     </table>
     <p style="margin:24px 0 0;font-size:13px;color:#475569;">Puedes responder este correo directamente para contactar al lead.</p>`,
  );
  const text = `Nuevo lead de seguro — Gifted Grads Insurance\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
  return { subject, html, text };
}

export function winnerEmail(attendee: Attendee): {
  subject: string;
  html: string;
  text: string;
} {
  const number = `#${pad(attendee.participantNumber)}`;
  const subject = `🎉 ¡Ganaste el iPad! — Gifted Grads`;
  const html = shellHtml(
    subject,
    `<p style="margin:0 0 12px;font-size:16px;">¡Felicidades <strong>${escapeHtml(attendee.nombre)}</strong>!</p>
     <p style="margin:0 0 16px;font-size:14px;color:#475569;">
       Tu número de participante <strong style="color:#1f4fdb;font-family:monospace;">${number}</strong> fue el seleccionado en la rifa.
       Has ganado un <strong>iPad</strong>.
     </p>
     <div style="border:2px dashed #93c5fd;background:#eff6ff;padding:16px;border-radius:10px;text-align:center;margin:16px 0;">
       <div style="font-size:12px;color:#1d4ed8;text-transform:uppercase;letter-spacing:0.08em;">Número ganador</div>
       <div style="font-family:'Courier New',monospace;font-size:36px;font-weight:800;color:#1e3a8a;margin-top:4px;">${number}</div>
     </div>
     <p style="margin:16px 0 0;font-size:14px;color:#475569;">
       Para reclamar tu premio, responde a este correo con tu nombre completo y un horario disponible para coordinar la entrega.
     </p>
     <p style="margin:24px 0 0;font-size:14px;">¡Nos vemos pronto!<br/><span style="color:#64748b;">Equipo Gifted Grads</span></p>`,
  );
  const text = `¡Felicidades ${attendee.nombre}!

Tu número de participante ${number} fue el seleccionado en la rifa. Has ganado un iPad.

Para reclamar tu premio, responde a este correo con tu nombre completo y un horario disponible para coordinar la entrega.

¡Nos vemos pronto!
Equipo Gifted Grads`;
  return { subject, html, text };
}
