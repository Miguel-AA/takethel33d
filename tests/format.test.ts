import { describe, expect, it } from 'vitest';
import { formatParticipantNumber, formatPercent } from '../src/lib/format';

describe('formatParticipantNumber', () => {
  it('pads to 3 digits', () => {
    expect(formatParticipantNumber(1)).toBe('001');
    expect(formatParticipantNumber(42)).toBe('042');
    expect(formatParticipantNumber(199)).toBe('199');
  });
  it('does not truncate large numbers', () => {
    expect(formatParticipantNumber(1234)).toBe('1234');
  });
});

describe('formatPercent', () => {
  it('renders one decimal place with a percent sign', () => {
    expect(formatPercent(25)).toBe('25.0%');
    expect(formatPercent(33.333)).toBe('33.3%');
  });
});
