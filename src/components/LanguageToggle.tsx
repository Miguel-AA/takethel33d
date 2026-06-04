import { useTranslation, type Locale } from '../i18n/I18nProvider';
import clsx from 'clsx';

export function LanguageToggle() {
  const { locale, setLocale } = useTranslation();
  const options: Locale[] = ['es', 'en'];
  return (
    <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-medium">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => setLocale(opt)}
          className={clsx(
            'px-2.5 py-1 rounded-md uppercase tracking-wide transition',
            locale === opt
              ? 'bg-brand-600 text-white'
              : 'text-slate-600 hover:bg-slate-100',
          )}
          aria-pressed={locale === opt}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
