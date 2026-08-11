import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../../i18n/I18nProvider';
import { api, ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { formatDateTime } from '../../lib/format';
import { Spinner } from '../Spinner';
import { ErrorBanner } from '../ErrorBanner';
import { EntryAnswerValue } from '../EntryAnswerValue';
import { EligibilityBadge, EligibilityReason } from '../EligibilityBadge';
import { ParticipantDispositionDialog } from './ParticipantDispositionDialog';
import {
  useAdminParticipant,
  useDisqualifyParticipant,
  useReinstateParticipant,
} from '../../hooks/useAdminParticipants';
import type { AdminEventParticipant } from '@shared/types';

/**
 * One participant's file.
 *
 * FOUR SECTIONS, in the order an operator reads them: who this is, what they
 * submitted, what was decided at the time, and what we have since done about
 * it. The fourth is separate from the third on purpose — an administrative
 * disqualification is not an eligibility verdict, and presenting them together
 * would suggest the rules excluded somebody a person did.
 */
export function ParticipantDetailPanel({
  eventId,
  entryId,
  onClose,
}: {
  eventId: string;
  entryId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const detail = useAdminParticipant(eventId, entryId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('participants.detail.title')}
      onClick={onClose}
    >
      <div
        className="glass-panel-strong max-h-[88vh] w-full max-w-2xl overflow-y-auto p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">
            {t('participants.detail.title')}
          </h3>
          <button type="button" className="btn-ghost text-xs" onClick={onClose}>
            {t('participants.action.close')}
          </button>
        </div>

        {detail.isPending ? (
          <p className="mt-6 text-center text-sm text-slate-500">
            <Spinner /> <span className="ml-2">{t('common.loading')}</span>
          </p>
        ) : detail.isError || !detail.data ? (
          <div className="mt-4">
            <ErrorBanner
              message={
                detail.error instanceof ApiError && detail.error.status === 404
                  ? t('participants.error.notFound')
                  : t('common.error')
              }
            />
          </div>
        ) : (
          <ParticipantDetailBody
            eventId={eventId}
            participant={detail.data.participant}
          />
        )}
      </div>
    </div>
  );
}

function ParticipantDetailBody({
  eventId,
  participant,
}: {
  eventId: string;
  participant: AdminEventParticipant;
}) {
  const { t, locale } = useTranslation();
  const [dialog, setDialog] = useState<'DISQUALIFY' | 'REINSTATE' | null>(null);

  const disqualify = useDisqualifyParticipant(eventId, participant.entryId);
  const reinstate = useReinstateParticipant(eventId, participant.entryId);
  const pending = disqualify.isPending || reinstate.isPending;

  /**
   * The version the entry was filled in with.
   *
   * `participant.entry.formVersionId` — the entry's OWN version, never whatever
   * the event currently publishes — so option values are shown with the labels
   * they had when this person chose them. A published version never changes, so
   * this is cached indefinitely.
   */
  const version = useQuery({
    queryKey: queryKeys.formVersion(eventId, participant.entry.formVersionId),
    queryFn: () => api.getFormVersion(eventId, participant.entry.formVersionId),
    staleTime: Infinity,
    retry: false,
  });

  const mutationError = disqualify.error ?? reinstate.error;
  const errorMessage = mutationError ? messageFor(mutationError, t) : null;

  const { disposition } = participant.entry;

  return (
    <div className="mt-4 space-y-6">
      <Section title={t('participants.detail.identity')}>
        <Row
          label={t('participants.field.name')}
          value={`${participant.participant.firstName} ${participant.participant.lastName}`}
        />
        <Row label={t('participants.field.email')} value={participant.participant.email} />
        <Row
          label={t('participants.field.phone')}
          value={participant.participant.phone ?? '—'}
        />
        {/* Kept out of the table on purpose; shown here, where it was asked for
            and where opening the record is audited. */}
        <Row
          label={t('participants.field.dateOfBirth')}
          value={participant.participant.dateOfBirth ?? '—'}
        />
      </Section>

      <Section title={t('participants.detail.entry')}>
        <Row
          label={t('participants.field.submitted')}
          value={formatDateTime(participant.entry.submittedAt, locale)}
        />
        <Row
          label={t('participants.field.version')}
          value={t('participants.detail.submittedUsing', {
            version: participant.entry.formVersionNumber,
          })}
        />
        <div className="grid grid-cols-3 gap-2 py-2">
          <dt className="text-slate-500">{t('participants.field.status')}</dt>
          <dd className="col-span-2">
            <EligibilityBadge status={participant.entry.status} />
          </dd>
        </div>
      </Section>

      {/* Every label says AT SUBMISSION. A decision belongs to the moment it was
          taken: somebody who has had a birthday since is not retroactively
          eligible, and raising the age limit does not retroactively exclude
          anybody. */}
      <Section title={t('participants.detail.eligibility')}>
        <Row
          label={t('participants.field.age')}
          value={
            participant.entry.calculatedAge === null
              ? '—'
              : String(participant.entry.calculatedAge)
          }
        />
        <Row
          label={t('participants.field.ageEligible')}
          value={
            participant.entry.ageEligible === null
              ? t('entries.ageRule.none')
              : participant.entry.ageEligible
                ? t('common.yes')
                : t('common.no')
          }
        />
        <div className="grid grid-cols-3 gap-2 py-2">
          <dt className="text-slate-500">{t('participants.field.reason')}</dt>
          <dd className="col-span-2">
            <EligibilityReason code={participant.entry.eligibilityReason} />
          </dd>
        </div>
      </Section>

      {disposition && (
        <Section title={t('participants.detail.disposition')}>
          <Row
            label={t('participants.field.disqualifiedAt')}
            value={formatDateTime(disposition.disqualifiedAt, locale)}
          />
          <Row
            label={t('participants.field.disqualifiedBy')}
            value={disposition.disqualifiedByName ?? '—'}
          />
          {/* Operator-written text, rendered as text. */}
          <Row
            label={t('participants.field.disqualificationReason')}
            value={disposition.reason}
          />
          <Row
            label={t('participants.field.returnsTo')}
            value={t(`entries.status.${disposition.preDisqualificationStatus}`)}
          />
        </Section>
      )}

      <section>
        <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-brand-700">
          {t('participants.detail.answers')}
        </h4>
        {participant.answers.length === 0 ? (
          <p className="text-sm text-slate-500">{t('participants.detail.noAnswers')}</p>
        ) : (
          <dl className="divide-y divide-slate-900/10 text-sm">
            {participant.answers.map((answer) => (
              <div key={answer.id} className="grid grid-cols-3 gap-2 py-2">
                {/* The label as it read when this was answered, not as it reads now. */}
                <dt className="break-words text-slate-500">{answer.questionLabel}</dt>
                <dd className="col-span-2">
                  <EntryAnswerValue answer={answer} steps={version.data?.version.steps} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* Only actions the shared rules say are available. A button the server
          would refuse is a lie to the operator. */}
      {participant.actions.available.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-slate-900/10 pt-4">
          {participant.actions.available.includes('DISQUALIFY') && (
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => setDialog('DISQUALIFY')}
            >
              {t('participants.action.disqualify')}
            </button>
          )}
          {participant.actions.available.includes('REINSTATE') && (
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={() => setDialog('REINSTATE')}
            >
              {t('participants.action.reinstate')}
            </button>
          )}
        </div>
      ) : (
        participant.actions.blocked.some(
          (blocked) => blocked.blocker === 'EVENT_STATE_FORBIDS',
        ) && (
          <p className="border-t border-slate-900/10 pt-4 text-xs text-slate-500">
            {t('participants.notEditable')}
          </p>
        )
      )}

      {dialog && (
        <ParticipantDispositionDialog
          action={dialog}
          reinstatesTo={participant.actions.reinstatesTo}
          submitting={pending}
          error={errorMessage}
          onClose={() => {
            disqualify.reset();
            reinstate.reset();
            setDialog(null);
          }}
          onConfirm={(reason) => {
            const onDone = { onSuccess: () => setDialog(null) };
            if (dialog === 'DISQUALIFY') {
              disqualify.mutate(
                { expectedRevision: participant.entryRevision, reason },
                onDone,
              );
            } else {
              reinstate.mutate({ expectedRevision: participant.entryRevision }, onDone);
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Turns a refusal into something an operator can act on.
 *
 * A revision conflict is the common one and is not a failure: somebody else
 * changed the entry. The invalidation the mutation hook performs has already
 * refetched the detail, so the panel behind the dialog is showing the new state
 * by the time this is read.
 */
function messageFor(error: Error, t: (key: string) => string): string {
  if (!(error instanceof ApiError)) return t('common.error');
  switch (error.code) {
    case 'ENTRY_REVISION_CONFLICT':
      return t('participants.error.conflict');
    case 'ENTRY_ALREADY_DISQUALIFIED':
      return t('participants.error.alreadyDisqualified');
    case 'ENTRY_NOT_DISQUALIFIED':
      return t('participants.error.notDisqualified');
    case 'ENTRY_NO_RESTORABLE_STATUS':
      return t('participants.error.noRestorableStatus');
    case 'EVENT_PARTICIPANTS_NOT_EDITABLE':
      return t('participants.notEditable');
    case 'EVENT_ENTRY_NOT_FOUND':
      return t('participants.error.notFound');
    default:
      return t('common.error');
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-sm font-semibold uppercase tracking-wide text-brand-700">
        {title}
      </h4>
      <dl className="divide-y divide-slate-900/10 text-sm">{children}</dl>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words font-medium text-slate-900">{value}</dd>
    </div>
  );
}
