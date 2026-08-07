// @vitest-environment node
//
// Timezone and DST behaviour of the admin form's date conversion.
//
// The browser's own zone must never be the authority: an administrator in
// Madrid scheduling a New York event types New York wall-clock time.

import { describe, expect, it } from 'vitest';
import {
  formatInEventZone,
  isoToLocalInput,
  localInputToIso,
} from '../src/lib/eventDateTime';

describe('wall clock to UTC, in the event timezone', () => {
  it.each([
    // EDT (UTC-4) in summer.
    ['America/New_York', '2026-06-01T10:00', '2026-06-01T14:00:00.000Z'],
    // EST (UTC-5) in winter.
    ['America/New_York', '2026-01-15T10:00', '2026-01-15T15:00:00.000Z'],
    // No DST, always UTC+9.
    ['Asia/Tokyo', '2026-06-01T10:00', '2026-06-01T01:00:00.000Z'],
    ['Asia/Tokyo', '2026-01-15T10:00', '2026-01-15T01:00:00.000Z'],
    // BST in summer, GMT in winter.
    ['Europe/London', '2026-06-01T10:00', '2026-06-01T09:00:00.000Z'],
    ['Europe/London', '2026-01-15T10:00', '2026-01-15T10:00:00.000Z'],
    ['UTC', '2026-06-01T10:00', '2026-06-01T10:00:00.000Z'],
  ])('%s %s -> %s', (zone, local, expected) => {
    expect(localInputToIso(local, zone)).toBe(expected);
  });

  it('round-trips without drifting when re-edited', () => {
    // Re-opening the form must show exactly what was typed, or an untouched
    // save would silently move the event.
    for (const [zone, local] of [
      ['America/New_York', '2026-06-01T10:00'],
      ['America/New_York', '2026-01-15T23:45'],
      ['Asia/Tokyo', '2026-03-08T00:30'],
      ['Europe/London', '2026-10-25T01:30'],
      ['UTC', '2026-12-31T23:59'],
    ] as const) {
      const iso = localInputToIso(local, zone);
      expect(iso, `${zone} ${local}`).not.toBeNull();
      expect(isoToLocalInput(iso, zone), `${zone} ${local}`).toBe(local);
    }
  });

  it('gives different instants for the same wall clock in different zones', () => {
    const local = '2026-06-01T10:00';
    const instants = new Set(
      ['America/New_York', 'Asia/Tokyo', 'Europe/London', 'UTC'].map((zone) =>
        localInputToIso(local, zone),
      ),
    );
    expect(instants.size).toBe(4);
  });

  it('does not consult the runtime timezone', () => {
    // The host here is not New York; the answer must still be New York's.
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      expect(localInputToIso('2026-06-01T10:00', 'America/New_York')).toBe(
        '2026-06-01T14:00:00.000Z',
      );
      process.env.TZ = 'America/Los_Angeles';
      expect(localInputToIso('2026-06-01T10:00', 'America/New_York')).toBe(
        '2026-06-01T14:00:00.000Z',
      );
    } finally {
      process.env.TZ = previous;
    }
  });
});

describe('DST boundaries', () => {
  // 2026-03-08: clocks jump 02:00 -> 03:00 in New York. 02:30 never happens.
  it('rejects a wall-clock time that does not exist', () => {
    expect(localInputToIso('2026-03-08T02:30', 'America/New_York')).toBeNull();
    expect(localInputToIso('2026-03-08T02:00', 'America/New_York')).toBeNull();
    expect(localInputToIso('2026-03-08T02:59', 'America/New_York')).toBeNull();
  });

  it('accepts the times either side of the spring-forward gap', () => {
    expect(localInputToIso('2026-03-08T01:59', 'America/New_York')).toBe(
      '2026-03-08T06:59:00.000Z',
    );
    expect(localInputToIso('2026-03-08T03:00', 'America/New_York')).toBe(
      '2026-03-08T07:00:00.000Z',
    );
  });

  // 2026-11-01: clocks fall back 02:00 -> 01:00. 01:30 happens twice.
  it('resolves an ambiguous wall-clock time to the FIRST occurrence', () => {
    // Documented policy: the earlier (still-daylight-time) instant is chosen,
    // which is what a person means by "1:30 that morning".
    const resolved = localInputToIso('2026-11-01T01:30', 'America/New_York');
    expect(resolved).toBe('2026-11-01T05:30:00.000Z');

    // It is a real instant, and re-editing shows the same wall clock back.
    expect(isoToLocalInput(resolved, 'America/New_York')).toBe('2026-11-01T01:30');
  });

  it('handles the hours around fall-back unambiguously', () => {
    expect(localInputToIso('2026-11-01T00:30', 'America/New_York')).toBe(
      '2026-11-01T04:30:00.000Z',
    );
    expect(localInputToIso('2026-11-01T03:00', 'America/New_York')).toBe(
      '2026-11-01T08:00:00.000Z',
    );
  });

  it('London has its own transition dates', () => {
    // 2026-03-29 01:00 -> 02:00 in London.
    expect(localInputToIso('2026-03-29T01:30', 'Europe/London')).toBeNull();
    expect(localInputToIso('2026-03-29T00:30', 'Europe/London')).toBe(
      '2026-03-29T00:30:00.000Z',
    );
  });

  it('a zone without DST never produces a gap', () => {
    for (const day of ['2026-03-08', '2026-11-01', '2026-03-29']) {
      expect(localInputToIso(`${day}T02:30`, 'Asia/Tokyo'), day).not.toBeNull();
      expect(localInputToIso(`${day}T02:30`, 'UTC'), day).not.toBeNull();
    }
  });
});

describe('malformed and empty input', () => {
  it.each([
    'not-a-date',
    '2026-13-01T10:00',
    '2026-06-32T10:00',
    '2026-06-01T25:00',
    '2026-06-01',
    '10:00',
    '',
  ])('rejects %s', (value) => {
    expect(localInputToIso(value, 'America/New_York')).toBeNull();
  });

  it('accepts an optional seconds component', () => {
    expect(localInputToIso('2026-06-01T10:00:30', 'America/New_York')).toBe(
      '2026-06-01T14:00:30.000Z',
    );
  });

  it('renders an absent date as a dash rather than an epoch', () => {
    expect(isoToLocalInput(null, 'UTC')).toBe('');
    expect(isoToLocalInput('nonsense', 'UTC')).toBe('');
    expect(formatInEventZone(null, 'UTC')).toBe('—');
    expect(formatInEventZone('nonsense', 'UTC')).toBe('—');
  });
});

describe('display formatting', () => {
  it('names the timezone so a time is never ambiguous to the reader', () => {
    const rendered = formatInEventZone('2026-06-01T14:00:00.000Z', 'America/New_York');
    expect(rendered).toMatch(/10:00/);
    // The zone abbreviation must be present.
    expect(rendered).toMatch(/EDT|GMT-4/);
  });

  it('shows the same instant differently per zone', () => {
    const instant = '2026-06-01T14:00:00.000Z';
    const ny = formatInEventZone(instant, 'America/New_York');
    const tokyo = formatInEventZone(instant, 'Asia/Tokyo');
    expect(ny).not.toBe(tokyo);
  });

  it('survives a timezone the runtime cannot resolve', () => {
    // A corrupt stored zone must not take the page down.
    expect(() => formatInEventZone('2026-06-01T14:00:00.000Z', 'Mars/Olympus')).not.toThrow();
  });
});
