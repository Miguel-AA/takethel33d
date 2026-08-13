import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EventSummary } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';
import { useEvents } from '../hooks/useEvents';
import { MetricsGrid } from '../components/MetricsGrid';
import { AttendeeTable } from '../components/AttendeeTable';
import { RafflePanel } from '../components/RafflePanel';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { EventStatusBadge } from '../components/EventStatusBadge';
import { formatInEventZone } from '../lib/eventDateTime';

/**
 * The manager's landing page.
 *
 * WHAT THIS PAGE IS FOR: answering "what do I do here?" in the first screenful.
 * The answer is *manage events*, so events come first, the empty state carries
 * the primary call to action, and the earlier lead-capture product sits below in
 * a section that names itself as legacy.
 *
 * This ordering is not decoration. Until it existed, every page built in phases
 * 3–12 was reachable only by somebody who already knew the URLs: the dashboard
 * showed the lead-capture product and offered one small link to the real one.
 */

const RECENT_LIMIT = 5;

/**
 * The operator's path through an event, start to finish.
 *
 * Each step resolves its own destination from the event it is shown for, and
 * returns `null` when the lifecycle does not yet allow that page. A step with no
 * destination renders as text rather than as a link — offering a link to a page
 * whose only content would be a refusal teaches the operator to distrust the
 * navigation. The gates below are the same ones the event detail page applies.
 */
interface WorkflowStep {
  key: string;
  to: (event: EventSummary | null) => string | null;
}

const WORKFLOW: readonly WorkflowStep[] = [
  { key: 'create', to: () => '/manager/events/new' },
  { key: 'prizes', to: (e) => (e ? `/manager/events/${e.id}/prizes` : null) },
  { key: 'form', to: (e) => (e ? `/manager/events/${e.id}/form` : null) },
  { key: 'participants', to: (e) => (e ? `/manager/events/${e.id}/participants` : null) },
  { key: 'eligibility', to: (e) => (e ? `/manager/events/${e.id}/participants` : null) },
  {
    key: 'draw',
    to: (e) =>
      e && (e.status === 'DRAW_READY' || e.status === 'DRAW_COMPLETED')
        ? `/manager/events/${e.id}/draw`
        : null,
  },
  {
    key: 'results',
    to: (e) =>
      e && (e.status === 'DRAW_COMPLETED' || e.status === 'ARCHIVED')
        ? `/manager/events/${e.id}/results`
        : null,
  },
];

export function ManagerDashboardPage() {
  const { t } = useTranslation();

  // Most recently touched first: the event an operator returns to is almost
  // always the one they last worked on.
  const events = useEvents({
    page: 1,
    pageSize: RECENT_LIMIT,
    archived: 'active',
    sort: 'updatedAt',
    direction: 'desc',
  });

  const items = events.data?.items ?? [];
  const current = items[0] ?? null;
  const hasEvents = items.length > 0;

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            <span className="accent-underline">{t('dashboard.title')}</span>
          </h1>
          <p className="mt-2 max-w-2xl text-slate-600">{t('dashboard.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/manager/events/new" className="btn-primary w-fit">
            {t('events.action.new')}
          </Link>
          <Link to="/manager/events" className="btn-secondary w-fit text-xs">
            {t('dashboard.events.viewAll')}
          </Link>
          <Link to="/manager/audit" className="btn-secondary w-fit text-xs">
            {t('audit.nav')}
          </Link>
        </div>
      </header>

      <section aria-labelledby="dashboard-events">
        <h2
          id="dashboard-events"
          className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-700"
        >
          {t('dashboard.section.events')}
        </h2>

        {events.isError && <ErrorBanner message={t('common.error')} />}

        {events.isPending ? (
          <div className="card p-6 text-center text-slate-500">
            <Spinner /> <span className="ml-2">{t('common.loading')}</span>
          </div>
        ) : hasEvents ? (
          <div className="card overflow-hidden">
            <ul className="divide-y divide-slate-900/10">
              {items.map((event) => (
                <li key={event.id}>
                  <Link
                    to={`/manager/events/${event.id}`}
                    className="flex flex-col gap-1 px-4 py-3 transition hover:bg-slate-900/5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0">
                      {/* Text, not markup: an event name is untrusted input. */}
                      <span className="block break-words font-medium text-slate-900">
                        {event.name}
                      </span>
                      <span className="block font-mono text-xs text-slate-500">
                        /{event.slug}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="hidden text-xs text-slate-500 sm:inline">
                        {formatInEventZone(event.startsAt, event.timezone)}
                      </span>
                      <EventStatusBadge status={event.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="border-t border-slate-900/10 px-4 py-3">
              <Link to="/manager/events" className="btn-secondary w-fit text-xs">
                {t('dashboard.events.viewAll')}
              </Link>
            </div>
          </div>
        ) : (
          /* THE MOST IMPORTANT SCREEN IN THE APPLICATION. A brand-new
             installation has zero events, so this is what the owner sees first
             and it has to make the next action unmistakable. */
          <div className="card p-8 text-center">
            <h3 className="text-xl font-semibold text-slate-900">
              {t('dashboard.events.empty.title')}
            </h3>
            <p className="mx-auto mt-2 max-w-xl text-slate-600">
              {t('dashboard.events.empty.body')}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Link to="/manager/events/new" className="btn-primary w-fit">
                {t('events.action.new')}
              </Link>
              <Link to="/manager/events" className="btn-secondary w-fit text-xs">
                {t('dashboard.events.viewAll')}
              </Link>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="dashboard-workflow">
        <h2
          id="dashboard-workflow"
          className="mb-1 text-sm font-semibold uppercase tracking-wide text-brand-700"
        >
          {t('dashboard.section.workflow')}
        </h2>
        <p className="mb-3 max-w-2xl text-sm text-slate-600">
          {t('dashboard.workflow.subtitle')}
        </p>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {WORKFLOW.map((step, index) => {
            const to = step.to(current);
            const label = t(`dashboard.workflow.step.${step.key}`);
            const help = t(`dashboard.workflow.help.${step.key}`);

            const body = (
              <>
                {/* The number is text, so the sequence survives without colour. */}
                <span className="text-xs font-semibold text-brand-700">
                  {t('dashboard.workflow.step.number', { number: index + 1 })}
                </span>
                <span className="mt-1 block font-medium text-slate-900">{label}</span>
                <span className="mt-1 block text-xs text-slate-600">{help}</span>
              </>
            );

            return (
              <li key={step.key}>
                {to ? (
                  <Link
                    to={to}
                    className="card block h-full p-4 transition hover:border-brand-400/60 hover:bg-white/70"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="card block h-full p-4 opacity-70">
                    {body}
                    <span className="mt-2 block text-xs text-slate-500">
                      {t('dashboard.workflow.locked')}
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <LegacySection />
    </div>
  );
}

/**
 * The original lead-capture product.
 *
 * KEPT, NOT DELETED: it still works and its data is still there. It is last on
 * the page, named as legacy, and closed by default — mounting it also fires
 * three admin queries, and the landing page should not pay for a section nobody
 * asked to see.
 *
 * A button rather than <details> because the open state has to drive whether the
 * children mount at all.
 */
function LegacySection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <section aria-labelledby="dashboard-legacy" className="border-t border-slate-900/10 pt-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="dashboard-legacy" className="text-sm font-semibold text-slate-500">
            {t('dashboard.legacy.title')}
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-500">
            {t('dashboard.legacy.subtitle')}
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary w-fit shrink-0 text-xs"
          aria-expanded={open}
          aria-controls="dashboard-legacy-panel"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t('dashboard.legacy.hide') : t('dashboard.legacy.show')}
        </button>
      </div>

      <div id="dashboard-legacy-panel" hidden={!open}>
        {open && (
          <div className="mt-6 space-y-8">
            <section>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                {t('dashboard.section.metrics')}
              </h3>
              <MetricsGrid />
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                {t('dashboard.section.raffle')}
              </h3>
              <RafflePanel />
            </section>

            <section>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                {t('dashboard.section.attendees')}
              </h3>
              <AttendeeTable />
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
