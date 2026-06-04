import { useTranslation, type Locale } from '../i18n/I18nProvider';
import clsx from 'clsx';

export function LanguageToggle() {
  const { locale, setLocale } = useTranslation();
  const options: Locale[] = ['es', 'en'];
  return (
    <div className="inline-flex rounded-lg border border-white/20 bg-black/40 p-0.5 text-xs font-medium backdrop-blur-xl">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => setLocale(opt)}
          className={clsx(
            'px-2.5 py-1 rounded-md uppercase tracking-wide transition',
            locale === opt
              ? 'bg-brand-600 text-white'
              : 'text-slate-300 hover:bg-white/10 hover:text-white',
          )}
          aria-pressed={locale === opt}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}
