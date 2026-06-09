// Resolves the marketing website copy for the current locale from the existing
// app-wide I18nProvider. Falls back to Spanish for any uncovered locale.
import { useTranslation } from '../i18n/I18nProvider';
import { landingCopy, type LandingCopy, type LandingLocale } from './copy';

export function useLandingCopy(): LandingCopy {
  const { locale } = useTranslation();
  const key: LandingLocale = (locale as LandingLocale) in landingCopy ? (locale as LandingLocale) : 'es';
  return landingCopy[key];
}
