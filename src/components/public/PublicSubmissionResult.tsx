import { useTranslation } from '../../i18n/I18nProvider';
import type { PublicEntryResponse } from '@shared/types';

/**
 * What a participant is told once their submission resolves.
 *
 * The operator's configured copy wins when it exists; the i18n fallback covers
 * the case where they left the field empty. The FALLBACK IS ON THE CLIENT on
 * purpose — the server has no idea what language the visitor reads, and a
 * hardcoded English default written server-side would be wrong for half the
 * audience of a bilingual product.
 *
 * INELIGIBLE IS NOT AN ERROR. It is rendered as a resolved outcome, calmly:
 * the person did take part, their entry was recorded, and they did not meet a
 * rule. Styling it as a failure would suggest they did something wrong.
 *
 * Nothing here shows an age, a date of birth, an email or any identifier. The
 * response does not carry them, and this component could not display them if it
 * wanted to.
 */
export function PublicSubmissionResult({ result }: { result: PublicEntryResponse }) {
  const { t } = useTranslation();
  const eligible = result.result === 'ELIGIBLE';

  const title =
    result.message.title.trim().length > 0
      ? result.message.title
      : t(eligible ? 'public.result.eligible.title' : 'public.result.ineligible.title');

  const body =
    result.message.body.trim().length > 0
      ? result.message.body
      : t(eligible ? 'public.result.eligible.body' : 'public.result.ineligible.body');

  // A reason is shown only when there is safe copy for it. An unrecognised code
  // renders nothing rather than leaking the raw enum onto the page.
  const reasonKey = result.reason ? `public.result.reason.${result.reason}` : null;
  const reason = reasonKey ? t(reasonKey) : null;
  const hasReason = reason !== null && reason !== reasonKey;

  return (
    <section
      className="card-lg p-8 text-center"
      // Announced as soon as it replaces the form.
      role="status"
      aria-live="polite"
    >
      <div
        aria-hidden="true"
        className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full text-2xl ${
          eligible ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'
        }`}
      >
        {eligible ? '✓' : 'i'}
      </div>

      <h2 className="mt-5 text-2xl font-bold text-slate-900">{title}</h2>
      <p className="mx-auto mt-3 max-w-prose whitespace-pre-line text-slate-700">{body}</p>

      {!eligible && hasReason && (
        <p className="mx-auto mt-4 max-w-prose text-sm text-slate-600">{reason}</p>
      )}
    </section>
  );
}
