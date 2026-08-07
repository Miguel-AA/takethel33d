import { useState } from 'react';
import type {
  EventFormDraft,
  EventFormVersion,
  EventFormVersionSummary,
} from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';
import { formatDateTime } from '../lib/format';
import { Spinner } from './Spinner';
import { ErrorBanner } from './ErrorBanner';
import { FormPreview } from './FormPreview';
import { summarizeFormDifference, type FormDifference } from '../lib/formDiff';
import { versionToPreview } from '../lib/formDiff';

/**
 * Publication history.
 *
 * READ ONLY throughout: a published version cannot be edited, so this offers
 * nothing that looks like it might. There is no reorder control, no field, no
 * save — only what was published and when.
 */
export function VersionHistory({
  versions,
  loading,
  error,
  draft,
  selectedVersion,
  selectedVersionId,
  versionLoading,
  onSelect,
  onClearSelection,
}: {
  versions: EventFormVersionSummary[];
  loading: boolean;
  error: boolean;
  /** The current draft, for the comparison summary. */
  draft: EventFormDraft | null;
  selectedVersion: EventFormVersion | null;
  selectedVersionId: string | null;
  versionLoading: boolean;
  onSelect: (versionId: string) => void;
  onClearSelection: () => void;
}) {
  const { t, locale } = useTranslation();
  const [comparing, setComparing] = useState(false);

  if (loading) {
    return (
      <div className="p-6 text-center text-slate-500">
        <Spinner /> <span className="ml-2">{t('common.loading')}</span>
      </div>
    );
  }
  if (error) return <ErrorBanner message={t('common.error')} />;

  if (selectedVersionId) {
    return (
      <div className="space-y-4">
        <button type="button" className="btn-secondary text-xs" onClick={onClearSelection}>
          {t('versions.backToList')}
        </button>

        {versionLoading || !selectedVersion ? (
          <div className="p-6 text-center text-slate-500">
            <Spinner /> <span className="ml-2">{t('common.loading')}</span>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              {t('versions.readOnly', { version: selectedVersion.versionNumber })}
            </p>
            {/* The same renderer the draft preview uses; nothing here is editable. */}
            <FormPreview preview={versionToPreview(selectedVersion)} />
          </>
        )}
      </div>
    );
  }

  if (versions.length === 0) {
    return <p className="text-sm text-slate-500">{t('versions.empty')}</p>;
  }

  const current = versions.find((version) => version.currentPublished) ?? null;
  const difference: FormDifference | null =
    comparing && draft && selectedComparable(current) ? summarizeFormDifference(draft) : null;

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-slate-900/10">
        {versions.map((version) => (
          <li key={version.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-900">v{version.versionNumber}</span>
                {version.currentPublished && (
                  <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-xs font-semibold text-brand-700">
                    {t('versions.current')}
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500">
                {formatDateTime(version.publishedAt, locale)}
                {version.publishedByName ? ` · ${version.publishedByName}` : ''}
                {' · '}
                {t('versions.fromRevision', { revision: version.sourceDraftRevision })}
                {' · '}
                {t('versions.counts', {
                  steps: version.stepCount,
                  questions: version.questionCount,
                })}
              </div>
            </div>
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => onSelect(version.id)}
            >
              {t('versions.open')}
            </button>
          </li>
        ))}
      </ul>

      {draft && current && (
        <div className="border-t border-slate-900/10 pt-3">
          <button
            type="button"
            className="btn-ghost text-xs"
            aria-expanded={comparing}
            onClick={() => setComparing((open) => !open)}
          >
            {t('versions.compare', { version: current.versionNumber })}
          </button>
          {difference && (
            <dl className="mt-2 grid gap-1 text-xs text-slate-700 sm:grid-cols-2">
              <Row label={t('versions.diff.steps')} value={difference.steps} />
              <Row label={t('versions.diff.questions')} value={difference.questions} />
              <Row label={t('versions.diff.options')} value={difference.options} />
              <Row label={t('versions.diff.required')} value={difference.requiredQuestions} />
            </dl>
          )}
          {comparing && current.sourceDraftRevision === draft.revision && (
            <p className="mt-2 text-xs text-slate-500">{t('versions.diff.identical')}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The comparison only makes sense against a version that is actually live. */
function selectedComparable(current: EventFormVersionSummary | null): boolean {
  return current !== null;
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
