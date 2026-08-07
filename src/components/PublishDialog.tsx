import type { FormPublishValidationResponse } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';
import { Spinner } from './Spinner';
import { ErrorBanner } from './ErrorBanner';

/**
 * The confirmation step before freezing a form.
 *
 * Deliberately NOT optimistic. Publishing creates something that can never be
 * changed, so the operator is shown what will be frozen, at which revision,
 * and is asked once — rather than finding out afterwards.
 */
export function PublishDialog({
  validation,
  validating,
  publishing,
  errorMessage,
  onGoToIssue,
  onConfirm,
  onCancel,
}: {
  validation: FormPublishValidationResponse | null;
  validating: boolean;
  publishing: boolean;
  errorMessage: string | null;
  /** Walks the builder to the thing that needs fixing. */
  onGoToIssue: (issue: { stepId?: string; questionId?: string }) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  if (validating || !validation) {
    return (
      <div className="p-6 text-center text-slate-500">
        <Spinner /> <span className="ml-2">{t('publish.checking')}</span>
      </div>
    );
  }

  const nextVersion = (validation.publishedVersionNumber ?? 0) + 1;

  return (
    <div className="space-y-4">
      {errorMessage && <ErrorBanner message={errorMessage} />}

      {validation.publishable ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">
            {t('publish.summary', {
              version: nextVersion,
              revision: validation.draftRevision ?? 0,
            })}
          </p>
          <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
            {t('publish.immutableWarning')}
          </p>
          {validation.warnings.length > 0 && (
            <ul className="space-y-1">
              {validation.warnings.map((issue, index) => (
                <li key={`${issue.code}-${index}`} className="text-xs text-amber-700">
                  {t(`publish.issue.${issue.code}`)}
                  {issue.subject ? ` — ${issue.subject}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-900">{t('publish.notReady')}</p>
          <ul className="space-y-2">
            {validation.errors.map((issue, index) => (
              <li
                key={`${issue.code}-${index}`}
                className="flex items-start justify-between gap-2 rounded-lg border border-red-200 bg-red-50 p-2"
              >
                <span className="text-sm text-red-900">
                  {t(`publish.issue.${issue.code}`)}
                  {issue.subject ? ` — ${issue.subject}` : ''}
                </span>
                {(issue.stepId || issue.questionId) && (
                  <button
                    type="button"
                    className="btn-ghost shrink-0 text-xs"
                    onClick={() =>
                      onGoToIssue({ stepId: issue.stepId, questionId: issue.questionId })
                    }
                  >
                    {t('publish.goToIssue')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
        <button
          type="button"
          className="btn-primary text-xs sm:w-auto"
          disabled={!validation.publishable || publishing}
          onClick={onConfirm}
        >
          {publishing ? (
            <>
              <Spinner /> {t('publish.publishing')}
            </>
          ) : (
            t('publish.confirm', { version: nextVersion })
          )}
        </button>
        <button
          type="button"
          className="btn-secondary text-xs sm:w-auto"
          disabled={publishing}
          onClick={onCancel}
        >
          {t('form.action.cancel')}
        </button>
      </div>
    </div>
  );
}
