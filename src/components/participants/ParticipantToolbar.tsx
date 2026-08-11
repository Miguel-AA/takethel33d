import { useTranslation } from '../../i18n/I18nProvider';
import { Spinner } from '../Spinner';
import {
  PARTICIPANT_ELIGIBILITY_FILTERS,
  PARTICIPANT_STATUS_FILTERS,
} from '@shared/participantAdministration';
import type {
  ParticipantEligibilityFilter,
  ParticipantStatusFilter,
} from '@shared/types';

export interface ParticipantFilters {
  search: string;
  eligibility: ParticipantEligibilityFilter;
  status: ParticipantStatusFilter;
  formVersionId: string | null;
}

export const EMPTY_FILTERS: ParticipantFilters = {
  search: '',
  eligibility: 'ALL',
  status: 'ALL',
  formVersionId: null,
};

/**
 * Search and filters.
 *
 * TWO separate controls for eligibility and status, never one merged
 * "eligibility" dropdown. They are different questions — "did this person
 * qualify?" and "are they still in the running?" — and an operator filtering by
 * one while thinking of the other would get a confident wrong answer.
 *
 * The filter OPTIONS come from the shared module, so a value the server would
 * reject cannot be offered here. The listing endpoint parses strictly and
 * answers 400 to anything outside the allowlist, which means a stale UI fails
 * loudly rather than silently widening the query.
 */
export function ParticipantToolbar({
  searchInput,
  filters,
  versions,
  busy,
  onSearchInput,
  onFilterChange,
  onReset,
}: {
  searchInput: string;
  filters: ParticipantFilters;
  versions: Array<{ id: string; versionNumber: number }>;
  busy: boolean;
  onSearchInput: (value: string) => void;
  onFilterChange: (next: Partial<ParticipantFilters>) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();

  const dirty =
    searchInput !== '' ||
    filters.eligibility !== 'ALL' ||
    filters.status !== 'ALL' ||
    filters.formVersionId !== null;

  return (
    <div className="card flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <label className="label" htmlFor="participant-search">
            {t('participants.search.label')}
          </label>
          <input
            id="participant-search"
            type="search"
            className="input h-11 rounded-lg"
            placeholder={t('participants.search.placeholder')}
            value={searchInput}
            onChange={(event) => onSearchInput(event.target.value)}
          />
        </div>

        <Select
          id="participant-eligibility"
          label={t('participants.filters.eligibility')}
          value={filters.eligibility}
          options={PARTICIPANT_ELIGIBILITY_FILTERS.map((value) => ({
            value,
            label:
              value === 'ALL'
                ? t('participants.filters.all')
                : t(`entries.status.${value}`),
          }))}
          onChange={(value) =>
            onFilterChange({ eligibility: value as ParticipantEligibilityFilter })
          }
        />

        <Select
          id="participant-status"
          label={t('participants.filters.status')}
          value={filters.status}
          options={PARTICIPANT_STATUS_FILTERS.map((value) => ({
            value,
            label:
              value === 'ALL'
                ? t('participants.filters.all')
                : t(`entries.status.${value}`),
          }))}
          onChange={(value) => onFilterChange({ status: value as ParticipantStatusFilter })}
        />

        {versions.length > 1 && (
          <Select
            id="participant-version"
            label={t('participants.filters.formVersion')}
            value={filters.formVersionId ?? 'ALL'}
            options={[
              { value: 'ALL', label: t('participants.filters.all') },
              ...versions.map((version) => ({
                value: version.id,
                label: `v${version.versionNumber}`,
              })),
            ]}
            onChange={(value) =>
              onFilterChange({ formVersionId: value === 'ALL' ? null : value })
            }
          />
        )}

        {dirty && (
          <button type="button" className="btn-ghost text-xs" onClick={onReset}>
            {t('participants.filters.reset')}
          </button>
        )}

        {busy && <Spinner />}
      </div>
    </div>
  );
}

function Select({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="input h-11 rounded-lg"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
