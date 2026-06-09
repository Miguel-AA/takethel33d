import { useTranslation, type Locale } from '../i18n/I18nProvider';
import clsx from 'clsx';

export function LanguageToggle() {
  const { locale, setLocale } = useTranslation();
  const options: Locale[] = ['es', 'en'];
  return (
    <div className="inline-flex rounded-lg border border-white/40 bg-white/55 p-0.5 text-xs font-medium shadow-sm backdrop-blur-xl">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => setLocale(opt)}
          className={clsx(
            'px-2.5 py-1 rounded-md uppercase tracking-wide transition',
            locale === opt
              ? 'bg-gradient-to-r from-brand-600 to-brand-500 text-white shadow-sm'
              : 'text-slate-500 hover:bg-slate-900/5 hover:text-slate-900',
          )}
          aria-pressed={locale === opt}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
