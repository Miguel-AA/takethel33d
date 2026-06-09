import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n/I18nProvider';
import { formatDateTime, formatParticipantNumber } from '../lib/format';
import { Spinner } from '../components/Spinner';
import { ApiError, api } from '../lib/api';
import type { Attendee, InsuranceType } from '@shared/types';

interface ConfirmationState {
  participantNumber?: number;
  attendee?: {
    nombre?: string;
    email?: string;
    telefono?: string;
    insuranceType?: InsuranceType;
    createdAt?: string;
  };
}

interface DisplayState {
  participantNumber: number;
  attendee?: ConfirmationState['attendee'] | Attendee;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 20_000;

export function ConfirmationPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const submissionId = params.get('submission');
  const numberFromQuery = params.get('n');

  const state = (location.state as ConfirmationState | null) ?? {};
  const eagerNumber =
    state.participantNumber ??
    (numberFromQuery ? Number(numberFromQuery) : null);

  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!submissionId || eagerNumber) return;
    const handle = setTimeout(() => setTimedOut(true), POLL_TIMEOUT_MS);
    return () => clearTimeout(handle);
  }, [submissionId, eagerNumber]);

  const lookup = useQuery({
    queryKey: ['registration', 'by-submission', submissionId],
    queryFn: () => api.getRegistrationBySubmission(submissionId as string),
    enabled: !!submissionId && !eagerNumber && !timedOut,
    refetchInterval: (q) => (q.state.data ? false : POLL_INTERVAL_MS),
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.code === 'PENDING') return true;
      return failureCount < 2;
    },
  });

  const displayed: DisplayState | null = useMemo(() => {
    if (eagerNumber && Number.isFinite(eagerNumber)) {
      return { participantNumber: eagerNumber, attendee: state.attendee };
    }
    if (lookup.data) {
      return {
        participantNumber: lookup.data.participantNumber,
        attendee: lookup.data.attendee,
      };
    }
    return null;
  }, [eagerNumber, state.attendee, lookup.data]);

  if (!displayed && !submissionId) {
    return <Navigate to="/events" replace />;
  }

  return (
    <div className="relative isolate overflow-hidden">
      <div className="relative mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
        {displayed ? (
          <Loaded participantNumber={displayed.participantNumber} attendee={displayed.attendee} />
        ) : timedOut ? (
          <Timeout />
        ) : (
          <Pending message={t('confirmation.confirming')} />
        )}
      </div>
    </div>
  );
}

function Pending({ message }: { message: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <Spinner className="h-8 w-8 text-brand-500" />
      <div className="text-slate-700">{message}</div>
    </div>
  );
}

function Timeout() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-xl py-12 text-center">
      <div className="card-lg p-8">
        <div className="text-3xl">⌛</div>
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
          {t('confirmation.timeout.title')}
        </h1>
        <p className="mt-2 text-slate-600">{t('confirmation.timeout.body')}</p>
        <Link to="/events" className="btn-secondary mt-6 inline-flex">
          {t('confirmation.backHome')}
        </Link>
      </div>
    </div>
  );
}

function Loaded({
  participantNumber,
  attendee,
}: {
  participantNumber: number;
  attendee?: ConfirmationState['attendee'] | Attendee;
}) {
  const { t, locale } = useTranslation();
  const a = attendee;

  return (
    <>
      <header className="flex items-start gap-5">
        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-lg border border-brand-400/30 bg-brand-600 text-white shadow-cardLg">
          <CheckIcon />
        </div>
        <div>
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
            <span className="accent-underline">{t('confirmation.title')}</span>
          </h1>
          <p className="mt-2 max-w-2xl text-slate-600">
            {t('confirmation.subtitle.line1')}
            <br />
            {t('confirmation.subtitle.line2')}
          </p>
        </div>
      </header>

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        <section className="card-lg p-6 lg:row-span-2">
          <div className="mb-4 flex items-center gap-2">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand-500/10 text-brand-600">
              <UserMiniIcon />
            </div>
            <h2 className="text-base font-semibold text-slate-800">
              {t('confirmation.summaryTitle')}
            </h2>
          </div>
          <dl className="grid gap-4 sm:grid-cols-2">
            <SummaryItem label={t('register.field.nombre')} value={a?.nombre} />
            <SummaryItem label={t('register.field.email')} value={a?.email} />
            <SummaryItem label={t('register.field.telefono')} value={a?.telefono} />
            <SummaryItem
              label={t('register.field.insuranceType')}
              value={a?.insuranceType ? t(`insurance.${a.insuranceType}`) : undefined}
            />
            <SummaryItem
              label={t('confirmation.registeredAt')}
              value={a?.createdAt ? formatDateTime(a.createdAt, locale) : undefined}
            />
          </dl>
        </section>

        <section className="card-lg relative overflow-hidden p-6 text-center">
          <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-brand-300/70 to-transparent" />
          <div className="text-sm font-semibold text-slate-600">
            {t('confirmation.numberLabel')}
          </div>
          <div className="mt-3 font-mono text-7xl font-extrabold tracking-tight text-brand-500">
            {formatParticipantNumber(participantNumber)}
          </div>
          <p className="mt-4 text-sm text-slate-600">
            {t('confirmation.numberNotice')}
          </p>
        </section>

        <section className="card-lg relative overflow-hidden p-6">
          <div className="relative flex flex-col items-center text-center">
            <EnvelopeIllustration className="h-24 w-auto" />
            <h2 className="mt-4 text-base font-semibold text-slate-800">
              {t('confirmation.email.title')}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {t('confirmation.email.body')}
            </p>
            <div className="mt-4 rounded-lg border border-brand-400/20 bg-brand-500/10 px-3 py-2 text-xs text-brand-700">
              <InfoIcon className="mr-1 inline h-3.5 w-3.5" />
              {t('confirmation.email.spam')}
            </div>
          </div>
        </section>

        <section className="card-lg space-y-4 p-6 lg:col-span-2">
          <NoticeRow
            icon={<TeamMiniIcon />}
            title={t('confirmation.notice1.title')}
            body={t('confirmation.notice1.body')}
          />
          <NoticeRow
            icon={<GiftMiniIcon />}
            title={t('confirmation.notice2.title')}
            body={t('confirmation.notice2.body')}
          />
          <NoticeRow
            icon={<SendMiniIcon />}
            title={t('confirmation.notice3.title')}
            body={t('confirmation.notice3.body')}
          />
        </section>
      </div>

      <div className="mt-8">
        <Link to="/events" className="btn-secondary w-full py-3 text-base sm:w-auto">
          <HomeIcon /> {t('confirmation.backHome')}
        </Link>
      </div>
    </>
  );
}

function SummaryItem({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium text-slate-800">{value ?? '—'}</dd>
    </div>
  );
}

function NoticeRow({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-500/10 text-brand-600">
        {icon}
      </div>
      <div>
        <div className="font-semibold text-slate-800">{title}</div>
        <p className="text-sm text-slate-600">{body}</p>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth="3">
      <path d="M5 12.5l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function UserMiniIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
    </svg>
  );
}
function TeamMiniIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="9" cy="9" r="3" />
      <circle cx="17" cy="10" r="2.5" />
      <path d="M3 20c0-3 3-5 6-5s6 2 6 5M14 20c0-2 2-4 4-4s4 2 4 4" />
    </svg>
  );
}
function GiftMiniIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="8" width="18" height="13" rx="2" />
      <path d="M3 12h18M12 8v13" />
    </svg>
  );
}
function SendMiniIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 11l18-8-8 18-2-8-8-2z" strokeLinejoin="round" />
    </svg>
  );
}
function EnvelopeIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 90" className={className} aria-hidden="true">
      <rect x="20" y="22" width="80" height="54" rx="6" fill="#0b1220" stroke="#1747c4" strokeOpacity="0.35" />
      <path d="M20 28 L 60 56 L 100 28" fill="none" stroke="#4f7cf0" strokeWidth="2" />
      <rect x="28" y="14" width="64" height="40" rx="4" fill="#101b30" stroke="#565c63" />
      <path d="M34 24 h 52 M34 32 h 40 M34 40 h 30" stroke="#c9ced4" strokeWidth="2" strokeLinecap="round" />
      <circle cx="92" cy="68" r="10" fill="#1747c4" />
      <path d="M87 68 l 4 4 l 7 -8" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function InfoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zm1 10h-2v-6h2v6z" />
    </svg>
  );
}
function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 11l9-8 9 8M5 10v10h14V10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
