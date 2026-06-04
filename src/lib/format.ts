export function formatParticipantNumber(n: number): string {
  return n.toString().padStart(3, '0');
}

export function formatDateTime(iso: string, locale = 'es'): string {
  const d = new Date(iso);
  return d.toLocaleString(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}
