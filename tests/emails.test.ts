import { describe, expect, it } from 'vitest';
import { organizerEmail, winnerEmail } from '../functions/_shared/emails';
import type { Attendee } from '../shared/types';

const sample: Attendee = {
  id: 'uuid-1',
  participantNumber: 7,
  firstName: 'Lucía <admin>',
  lastName: 'Pérez',
  email: 'lucia@example.com',
  phone: '+1 555 0000',
  highestLevelOfEducation: 'BACHELORS',
  age: 29,
  zip: '33101',
  city: 'Miami',
  housingStatus: 'OWNER',
  ownsVehicle: true,
  isBusinessOwner: false,
  createdAt: '2026-05-27T18:00:00.000Z',
};

describe('email templates', () => {
  it('organizerEmail includes the padded participant number and escaped HTML', () => {
    const out = organizerEmail(sample);
    expect(out.subject).toContain('#007');
    expect(out.html).toContain('Lucía &lt;admin&gt; Pérez');
    expect(out.text).toContain('Lucía <admin> Pérez');
    expect(out.text).toContain('lucia@example.com');
    expect(out.text).toContain('+1 555 0000');
  });

  it('winnerEmail mentions the gift card and includes the participant number', () => {
    const out = winnerEmail(sample);
    expect(out.subject).toMatch(/gift card/i);
    expect(out.html).toContain('#007');
    expect(out.text).toContain('#007');
    expect(out.html).toContain('Lucía &lt;admin&gt; Pérez');
  });
});
