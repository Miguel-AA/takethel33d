import { describe, expect, it } from 'vitest';
import { organizerEmail, winnerEmail } from '../functions/_shared/emails';
import type { Attendee } from '../shared/types';

const sample: Attendee = {
  id: 'uuid-1',
  participantNumber: 7,
  nombre: 'Lucía <admin>',
  email: 'lucia@example.com',
  telefono: '+1 555 0000',
  insuranceType: 'AUTO',
  createdAt: '2026-05-27T18:00:00.000Z',
};

describe('email templates', () => {
  it('organizerEmail includes the padded participant number, insurance label and escaped HTML', () => {
    const out = organizerEmail(sample);
    expect(out.subject).toContain('#007');
    expect(out.html).toContain('Lucía &lt;admin&gt;');
    expect(out.html).toContain('Auto');
    expect(out.text).toContain('Lucía <admin>');
    expect(out.text).toContain('Auto');
    expect(out.text).toContain('lucia@example.com');
  });

  it('winnerEmail mentions the iPad and includes the participant number', () => {
    const out = winnerEmail(sample);
    expect(out.subject).toMatch(/iPad/);
    expect(out.html).toContain('#007');
    expect(out.text).toContain('#007');
    expect(out.html).toContain('Lucía &lt;admin&gt;');
  });
});
