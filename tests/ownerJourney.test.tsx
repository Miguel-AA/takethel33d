// Can a person who has just signed in FIND the product?
//
// This is the test whose absence let twelve certified phases ship behind a
// landing page that advertised none of them. Every other UI suite mounts one
// page at a known route and asks whether that page works; each of them passed
// while the only route to event management was a URL you had to already know.
//
// So this one is deliberately different in two ways:
//
//   1. It renders the REAL <App /> — real Header, real route table, real
//      ProtectedRoute — driven through window.history, exactly as a browser
//      would. A route table that stops wiring a page fails here.
//   2. It starts at /manager, the page login redirects to, and NEVER mounts a
//      deeper route directly. Reachability is the property under test, so
//      navigating straight to the destination would assume away the question.
//
// Discoverability is asserted as "a link to it exists and points at it", not by
// visiting every page: the failure being guarded against is a missing entry
// point, and the pages themselves have their own suites.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import en from '../src/i18n/en.json';
import { ApiError } from '../src/lib/api';
import type {
  AdminMeResponse,
  Event,
  EventDetailResponse,
  EventStatus,
  Metrics,
} from '../shared/types';

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  listEvents: vi.fn(),
  getEvent: vi.fn(),
  listAuditLogs: vi.fn(),
  // The legacy surfaces, so opening that section resolves instead of retrying
  // against a network jsdom does not have.
  metrics: vi.fn(),
  listAttendees: vi.fn(),
  currentRaffle: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const { App } = await import('../src/App');

const t = (key: keyof typeof en) => en[key];

const EVENT_ID = '33333333-3333-4333-8333-333333333333';

const ADMIN: AdminMeResponse = {
  admin: {
    id: 'admin-1',
    email: 'owner@example.com',
    displayName: 'Ada Lovelace',
    role: 'ADMIN',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

function makeEvent(status: EventStatus = 'DRAFT'): Event {
  return {
    id: EVENT_ID,
    slug: 'grand-opening',
    name: 'Grand Opening',
    description: null,
    bannerUrl: null,
    locationName: 'Miami',
    timezone: 'America/New_York',
    registrationOpensAt: '2026-06-01T14:00:00.000Z',
    registrationClosesAt: '2026-06-05T14:00:00.000Z',
    startsAt: '2026-06-06T14:00:00.000Z',
    endsAt: '2026-06-07T14:00:00.000Z',
    minimumAge: 21,
    maxEntriesPerIdentity: 1,
    status,
    confirmationTitle: null,
    confirmationMessage: null,
    ineligibleTitle: null,
    ineligibleMessage: null,
    revision: 1,
    createdBy: 'admin-1',
    updatedBy: 'admin-1',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    publishedAt: null,
    openedAt: null,
    closedAt: null,
    cancelledAt: null,
    archivedAt: null,
  };
}

function seedEvents(events: Event[]) {
  mocks.listEvents.mockResolvedValue({
    items: events.map((event) => ({
      id: event.id,
      slug: event.slug,
      name: event.name,
      status: event.status,
      timezone: event.timezone,
      registrationOpensAt: event.registrationOpensAt,
      startsAt: event.startsAt,
      revision: event.revision,
      updatedAt: event.updatedAt,
      archivedAt: event.archivedAt,
    })),
    page: 1,
    pageSize: 25,
    total: events.length,
    totalPages: 1,
  });
}

function seedDetail(event: Event, overrides: Partial<EventDetailResponse> = {}) {
  mocks.getEvent.mockResolvedValue({
    event,
    availableActions: [],
    blockedActions: [],
    editableFields: ['name'],
    canDelete: false,
    actors: {
      createdBy: { id: 'admin-1', displayName: 'Ada Lovelace', email: 'owner@example.com' },
      updatedBy: { id: 'admin-1', displayName: 'Ada Lovelace', email: 'owner@example.com' },
    },
    ...overrides,
  } satisfies EventDetailResponse);
}

/** Renders the whole application at `route`, the way a browser arrives at it. */
function renderApp(route: string) {
  window.history.pushState({}, '', route);
  return render(<App />);
}

/**
 * The dashboard, after the session AND the event list have resolved.
 *
 * Waiting for the heading alone is not enough: it renders while the event query
 * is still in flight, and every assertion about what the dashboard offers
 * depends on which branch that query lands in.
 */
async function openDashboard() {
  renderApp('/manager');
  await screen.findByRole('heading', { level: 1, name: t('dashboard.title') });
  await waitFor(() => expect(screen.queryByText(t('common.loading'))).toBeNull());
}

/** The contents of one of the dashboard's labelled sections. */
function section(name: string) {
  return within(screen.getByRole('region', { name }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('gg.locale', 'en');
  for (const fn of Object.values(mocks)) fn.mockReset();

  mocks.me.mockResolvedValue(ADMIN);
  mocks.listAuditLogs.mockResolvedValue({
    items: [],
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
  });
  seedEvents([]);

  mocks.metrics.mockResolvedValue({
    total: 0,
    leadsToday: 0,
    byHousingStatus: { OWNER: 0, RENTER: 0, unknown: 0 },
    byVehicle: { yes: 0, no: 0, unknown: 0 },
    byBusinessOwner: { yes: 0, no: 0, unknown: 0 },
    byEducation: {},
    updatedAt: '2026-08-13T00:00:00.000Z',
  } satisfies Metrics);
  mocks.listAttendees.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 });
  // No winner drawn yet — the endpoint answers with null, not with an envelope.
  mocks.currentRaffle.mockResolvedValue(null);

  // jsdom has no media stack; the app's background video calls play() on mount.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});

// ---------------------------------------------------------------------------
describe('case 1 — the first screen of a production installation', () => {
  // Production had exactly this shape on delivery day: one administrator, zero
  // events. Whatever this state shows IS the product, as far as the owner knows.

  it('leads with events, not with the legacy lead-capture product', async () => {
    await openDashboard();

    const events = screen.getByRole('heading', { name: t('dashboard.section.events') });
    const legacy = screen.getByRole('heading', { name: t('dashboard.legacy.title') });

    // Events must come FIRST in the document, which is also reading order.
    expect(
      events.compareDocumentPosition(legacy) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // And the legacy surfaces must not even be mounted until asked for.
    expect(screen.queryByText(t('dashboard.metric.total'))).not.toBeInTheDocument();
    expect(screen.queryByText(t('dashboard.section.raffle'))).not.toBeInTheDocument();
  });

  it('says there are no events yet and explains what creating one gives you', async () => {
    await openDashboard();

    expect(screen.getByText(t('dashboard.events.empty.title'))).toBeInTheDocument();
    expect(screen.getByText(t('dashboard.events.empty.body'))).toBeInTheDocument();
  });

  it('offers Create event, pointing at the page that creates one', async () => {
    await openDashboard();

    const create = screen.getAllByRole('link', { name: t('events.action.new') });
    expect(create.length).toBeGreaterThan(0);
    for (const link of create) {
      expect(link).toHaveAttribute('href', '/manager/events/new');
    }
  });

  it('offers the full event list as well', async () => {
    await openDashboard();

    for (const link of screen.getAllByRole('link', { name: t('dashboard.events.viewAll') })) {
      expect(link).toHaveAttribute('href', '/manager/events');
    }
  });

  it('describes the seven steps of an event without inventing broken links', async () => {
    await openDashboard();

    const workflow = section(t('dashboard.section.workflow'));

    for (const key of [
      'create',
      'prizes',
      'form',
      'participants',
      'eligibility',
      'draw',
      'results',
    ] as const) {
      expect(
        workflow.getByText(t(`dashboard.workflow.step.${key}` as keyof typeof en)),
      ).toBeInTheDocument();
    }

    // With no event there is nothing to link the event-scoped steps to, so they
    // explain the step instead of pointing at a URL that cannot resolve. Only
    // step 1 — creating the event — is actionable from here.
    expect(workflow.getAllByRole('link')).toHaveLength(1);
    expect(workflow.getByRole('link')).toHaveAttribute('href', '/manager/events/new');
    expect(workflow.getAllByText(t('dashboard.workflow.locked'))).toHaveLength(6);
  });

  it('keeps the legacy product available, and clearly labelled as legacy', async () => {
    await openDashboard();

    const panel = () => document.getElementById('dashboard-legacy-panel') as HTMLElement;
    expect(panel().hidden).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: t('dashboard.legacy.show') }));

    expect(panel().hidden).toBe(false);
    for (const heading of [
      'dashboard.section.metrics',
      'dashboard.section.raffle',
      'dashboard.section.attendees',
    ] as const) {
      expect(within(panel()).getAllByRole('heading', { name: t(heading) }).length)
        .toBeGreaterThan(0);
    }
    expect(
      screen.getByRole('button', { name: t('dashboard.legacy.hide') }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('case 2 — reaching event creation by clicking, never by typing a URL', () => {
  it('dashboard → events → new event', async () => {
    await openDashboard();

    const nav = screen.getByRole('navigation', { name: t('nav.admin') });
    await userEvent.click(within(nav).getByRole('link', { name: t('events.nav') }));

    await screen.findByRole('heading', { level: 1, name: t('events.title') });
    expect(window.location.pathname).toBe('/manager/events');

    // The events list must offer creation too — it is where "View all events"
    // lands, and an operator who filtered their way to an empty table is one
    // click from a dead end otherwise.
    await userEvent.click(
      (await screen.findAllByRole('link', { name: t('events.action.new') }))[0],
    );

    await waitFor(() => expect(window.location.pathname).toBe('/manager/events/new'));
    await screen.findByRole('heading', { level: 1, name: t('events.new.title') });
  });

  it('the empty events list offers creation instead of blaming the filters', async () => {
    renderApp('/manager/events');

    await screen.findByRole('heading', { level: 1, name: t('events.title') });

    // No filter is narrowing anything, so this is a first run, not a bad search.
    expect(await screen.findByText(t('dashboard.events.empty.title'))).toBeInTheDocument();
    expect(screen.queryByText(t('events.empty'))).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('case 3 — every phase of an event is reachable from the dashboard', () => {
  it('the dashboard lists the event and links to it', async () => {
    seedEvents([makeEvent()]);
    await openDashboard();

    const link = await screen.findByRole('link', { name: /Grand Opening/ });
    expect(link).toHaveAttribute('href', `/manager/events/${EVENT_ID}`);
  });

  it('the event exposes prizes, the registration form and participants', async () => {
    const event = makeEvent('OPEN');
    seedEvents([event]);
    seedDetail(event);

    await openDashboard();
    await userEvent.click(await screen.findByRole('link', { name: /Grand Opening/ }));

    await screen.findByRole('heading', { level: 1, name: 'Grand Opening' });

    const expected: Array<[keyof typeof en, string]> = [
      ['prizes.nav', 'prizes'],
      ['form.nav', 'form'],
      ['entries.nav', 'participants'],
      ['event.action.edit', 'edit'],
    ];
    for (const [key, segment] of expected) {
      expect(screen.getByRole('link', { name: t(key) })).toHaveAttribute(
        'href',
        `/manager/events/${EVENT_ID}/${segment}`,
      );
    }
  });

  it('DRAW_READY makes the draw discoverable — and only then', async () => {
    const closed = makeEvent('CLOSED');
    seedEvents([closed]);
    seedDetail(closed);
    await openDashboard();
    await userEvent.click(await screen.findByRole('link', { name: /Grand Opening/ }));
    await screen.findByRole('heading', { level: 1, name: 'Grand Opening' });
    expect(screen.queryByRole('link', { name: t('draw.nav') })).toBeNull();

    // Same event, one lifecycle step later. Torn down first so the assertion
    // below cannot accidentally read the previous render.
    cleanup();
    mocks.getEvent.mockReset();
    const ready = makeEvent('DRAW_READY');
    seedEvents([ready]);
    seedDetail(ready);

    await openDashboard();
    await userEvent.click(await screen.findByRole('link', { name: /Grand Opening/ }));
    await screen.findByRole('heading', { level: 1, name: 'Grand Opening' });

    expect(screen.getByRole('link', { name: t('draw.nav') })).toHaveAttribute(
      'href',
      `/manager/events/${EVENT_ID}/draw`,
    );
  });

  it('DRAW_COMPLETED makes results discoverable, and keeps the draw', async () => {
    const done = makeEvent('DRAW_COMPLETED');
    seedEvents([done]);
    seedDetail(done);

    await openDashboard();
    await userEvent.click(await screen.findByRole('link', { name: /Grand Opening/ }));
    await screen.findByRole('heading', { level: 1, name: 'Grand Opening' });

    expect(screen.getByRole('link', { name: t('results.nav') })).toHaveAttribute(
      'href',
      `/manager/events/${EVENT_ID}/results`,
    );
    expect(screen.getByRole('link', { name: t('draw.nav') })).toHaveAttribute(
      'href',
      `/manager/events/${EVENT_ID}/draw`,
    );
  });

  it('the dashboard workflow cards link into the event once one exists', async () => {
    seedEvents([makeEvent('DRAW_COMPLETED')]);
    await openDashboard();

    const workflow = section(t('dashboard.section.workflow'));
    const step = (key: string, segment: string) => {
      const label = workflow.getByText(t(`dashboard.workflow.step.${key}` as keyof typeof en));
      expect(label.closest('a'), key).toHaveAttribute(
        'href',
        `/manager/events/${EVENT_ID}/${segment}`,
      );
    };

    step('prizes', 'prizes');
    step('form', 'form');
    step('participants', 'participants');
    step('eligibility', 'participants');
    step('draw', 'draw');
    step('results', 'results');
    expect(workflow.queryByText(t('dashboard.workflow.locked'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('case 4 — the global navigation', () => {
  it('gives a signed-in administrator the admin sections from any admin page', async () => {
    await openDashboard();

    const nav = screen.getByRole('navigation', { name: t('nav.admin') });
    expect(within(nav).getByRole('link', { name: t('nav.dashboard') })).toHaveAttribute(
      'href',
      '/manager',
    );
    expect(within(nav).getByRole('link', { name: t('events.nav') })).toHaveAttribute(
      'href',
      '/manager/events',
    );
    expect(within(nav).getByRole('link', { name: t('audit.nav') })).toHaveAttribute(
      'href',
      '/manager/audit',
    );
  });

  it('shows no admin navigation to somebody who is not signed in', async () => {
    // A visitor at the login page must not be handed a map of the admin surface.
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    renderApp('/manager/login');

    await screen.findByRole('heading', { level: 1, name: t('login.title') });

    expect(screen.queryByRole('navigation', { name: t('nav.admin') })).toBeNull();
    expect(screen.queryByRole('link', { name: t('nav.dashboard') })).toBeNull();
  });
});
