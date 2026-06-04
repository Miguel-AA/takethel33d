import { describe, expect, it } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { I18nProvider, useTranslation } from '../src/i18n/I18nProvider';

function Probe() {
  const { t, setLocale, locale } = useTranslation();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="title">{t('app.title')}</span>
      <span data-testid="register">{t('register.title')}</span>
      <span data-testid="interp">
        {t('dashboard.pagination.info', { page: 2, totalPages: 5, total: 117 })}
      </span>
      <button onClick={() => setLocale('en')}>EN</button>
    </div>
  );
}

describe('I18nProvider', () => {
  it('renders Spanish strings by default and interpolates vars', () => {
    localStorage.clear();
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('es');
    expect(screen.getByTestId('register').textContent).toMatch(/cotización/i);
    expect(screen.getByTestId('interp').textContent).toContain('2');
    expect(screen.getByTestId('interp').textContent).toContain('5');
    expect(screen.getByTestId('interp').textContent).toContain('117');
  });

  it('switches to English and persists the locale to localStorage', () => {
    localStorage.clear();
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    act(() => {
      screen.getByText('EN').click();
    });
    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(screen.getByTestId('register').textContent).toMatch(/quote/i);
    expect(localStorage.getItem('gg.locale')).toBe('en');
  });
});
