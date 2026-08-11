// Frontend behaviour of the results screens, administrative and public.
//
// The properties these tests exist to hold:
//
//   * the operator sees the abbreviated names BEFORE publishing, computed with
//     the same function that will write them
//   * publishing is confirmed, irreversible, and offers no way back afterwards
//   * archiving warns differently when it would discard an unpublished result
//   * the public page shows a name and a prize, and nothing that could identify
//     anybody who did not win

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { ApiError } from '../src/lib/api';
import type {
  AdminEventResults,
  PublicEventResultsDTO,
  PublishResultsResponse,
} from '../shared/types';

const mocks = vi.hoisted(() => ({
  getEventResults: vi.fn(),
  publishResults: vi.fn(),
  getPublicEventResults: vi.fn(),
  getEvent: vi.fn(),
  transitionEvent: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const { ManagerEventResultsPage } = await import('../src/routes/ManagerEventResultsPage');
const { PublicEventResultsPage } = await import('../src/routes/PublicEventResultsPage');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const SLUG = 'summer-giveaway';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function assignments(): AdminEventResults['assignments'] {
  return [
    {
      drawOrder: 0,
      prize: { nameSnapshot: 'Vape', descriptionSnapshot: null, unitIndex: 1 },
      winner: {
        entryId: 'e1',
        firstName: 'Miguel',
        lastName: 'Fuenmayor',
        email: 'miguel@example.com',
      },
    },
    {
      drawOrder: 1,
      prize: { nameSnapshot: 'Vape', descriptionSnapshot: null, unitIndex: 2 },
      winner: {
        entryId: 'e2',
        firstName: 'Maria',
        lastName: 'Del Barrio',
        email: 'maria@example.com',
      },
    },
  ];
}

function results(overrides: Partial<AdminEventResults> = {}): AdminEventResults {
  return {
    eventStatus: 'DRAW_COMPLETED',
    draw: {
      id: 'draw-1',
      completedAt: '2026-08-01T12:00:00.000Z',
      candidateCount: 10,
      prizeUnitCount: 5,
      assignmentCount: 2,
      algorithmVersion: 'CRYPTO_FISHER_YATES_V1',
      candidateSetHash: 'a'.repeat(64),
      executedByAdminId: 'admin-1',
      executedByName: 'Ada Lovelace',
    },
    assignments: assignments(),
    unassignedUnitCount: 3,
    publication: null,
    publicationState: 'UNPUBLISHED',
    canPublish: true,
    publishBlocker: null,
    canArchive: true,
    archivingWouldDiscardResults: true,
    archivedAt: null,
    ...overrides,
  };
}

function published(overrides: Partial<AdminEventResults> = {}): AdminEventResults {
  return results({
    publication: {
      id: 'pub-1',
      publishedAt: '2026-08-02T09:00:00.000Z',
      publishedByAdminId: 'admin-1',
      publishedByName: 'Ada Lovelace',
      winnerCount: 2,
    },
    publicationState: 'PUBLISHED',
    canPublish: false,
    publishBlocker: 'ALREADY_PUBLISHED',
    archivingWouldDiscardResults: false,
    ...overrides,
  });
}

function publicResults(): PublicEventResultsDTO {
  return {
    event: { slug: SLUG, name: 'Summer Giveaway' },
    results: {
      publishedAt: '2026-08-02T09:00:00.000Z',
      winners: [
        { displayName: 'Miguel F.', prizeName: 'Vape', prizeDescription: null, prizeUnitIndex: 1 },
        { displayName: 'Maria D.', prizeName: 'Vape', prizeDescription: null, prizeUnitIndex: 2 },
      ],
    },
  };
}

function renderAdmin() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[`/manager/events/${EVENT_ID}/results`]}>
          <Routes>
            <Route
              path="/manager/events/:eventId/results"
              element={<ManagerEventResultsPage />}
            />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function renderPublic() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[`/e/${SLUG}/results`]}>
          <Routes>
            <Route path="/e/:eventSlug/results" element={<PublicEventResultsPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEventResults.mockResolvedValue(results());
  mocks.getEvent.mockResolvedValue({
    event: { id: EVENT_ID, slug: SLUG, name: 'Summer Giveaway', status: 'DRAW_COMPLETED' },
    availableActions: [],
    blockedActions: [],
    editableFields: [],
    canDelete: false,
    actors: {},
  });
  mocks.getPublicEventResults.mockResolvedValue(publicResults());
});

async function openPublishDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /publish results/i }));
  return screen.findByRole('dialog');
}

// ---------------------------------------------------------------------------
describe('the administrative results screen', () => {
  it('reports the draw’s three counts and its unassigned units', async () => {
    renderAdmin();
    expect(await screen.findByTestId('results-count-candidates')).toHaveTextContent('10');
    expect(screen.getByTestId('results-count-units')).toHaveTextContent('5');
    expect(screen.getByTestId('results-count-winners')).toHaveTextContent('2');
    expect(screen.getByTestId('results-unassigned')).toHaveTextContent(/3 prize unit/i);
  });

  it('shows the candidate hash, which the public page never will', async () => {
    renderAdmin();
    expect(await screen.findByText('a'.repeat(64))).toBeInTheDocument();
  });

  it('names the winners with their email addresses', async () => {
    renderAdmin();
    const row = await screen.findByTestId('result-row-0');
    expect(row).toHaveTextContent('Miguel Fuenmayor');
    expect(row).toHaveTextContent('miguel@example.com');
  });

  it('previews the ABBREVIATED name before anything is published', async () => {
    renderAdmin();
    // Computed with the shared formatter, so what is previewed is what will be
    // written — there is no second implementation to disagree.
    expect(await screen.findByTestId('result-public-0')).toHaveTextContent('Miguel F.');
    expect(screen.getByTestId('result-public-1')).toHaveTextContent('Maria D.');
  });

  it('drops the preview column once the record exists', async () => {
    mocks.getEventResults.mockResolvedValue(published());
    renderAdmin();
    await screen.findByTestId('result-row-0');
    expect(screen.queryByTestId('result-public-0')).toBeNull();
  });

  it('shows nothing to publish before a draw', async () => {
    mocks.getEventResults.mockResolvedValue(
      results({ draw: null, assignments: [], canPublish: false, publishBlocker: 'EVENT_NOT_DRAWN' }),
    );
    renderAdmin();
    expect(await screen.findByText(/has not been drawn/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish results/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('publishing', () => {
  it('does not publish on the first click', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await openPublishDialog(user);
    expect(mocks.publishResults).not.toHaveBeenCalled();
  });

  it('warns that it cannot be undone, and says what will be shown', async () => {
    const user = userEvent.setup();
    renderAdmin();
    const dialog = await openPublishDialog(user);

    expect(dialog).toHaveTextContent(/cannot be undone/i);
    expect(dialog).toHaveTextContent(/abbreviated names only/i);
  });

  it('previews exactly the names that will be written', async () => {
    const user = userEvent.setup();
    renderAdmin();
    const dialog = await openPublishDialog(user);

    const preview = within(dialog).getByTestId('publish-preview');
    expect(preview).toHaveTextContent('Miguel F.');
    expect(preview).toHaveTextContent('Maria D.');
    // ...and never the full surname or the email.
    expect(preview).not.toHaveTextContent('Fuenmayor');
    expect(preview).not.toHaveTextContent('@example.com');
  });

  it('offers no way to edit a name', async () => {
    // A publication is a copy of a decision. An operator typing over one would
    // be publishing something nobody won.
    const user = userEvent.setup();
    renderAdmin();
    const dialog = await openPublishDialog(user);
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });

  it('publishes with NO arguments once confirmed', async () => {
    mocks.publishResults.mockResolvedValue({ results: published() } as PublishResultsResponse);
    const user = userEvent.setup();
    renderAdmin();
    const dialog = await openPublishDialog(user);

    await user.click(within(dialog).getByRole('button', { name: /publish now/i }));
    await waitFor(() => expect(mocks.publishResults).toHaveBeenCalledTimes(1));
    expect(mocks.publishResults).toHaveBeenCalledWith(EVENT_ID);
  });

  it('shows the record afterwards and offers no way to withdraw it', async () => {
    mocks.getEventResults.mockResolvedValue(published());
    renderAdmin();

    expect(await screen.findByTestId('publication-state')).toHaveTextContent(/published/i);
    // ABSENT, not disabled: a greyed-out control implies a state in which it
    // would work.
    expect(screen.queryByRole('button', { name: /publish results/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /unpublish|withdraw|retract/i })).toBeNull();
  });

  it('keeps the dialog open with the reason when it is refused', async () => {
    mocks.publishResults.mockRejectedValue(
      new ApiError(409, 'RESULTS_NOT_PUBLISHABLE', 'nope', { blocker: 'EVENT_ARCHIVED' }),
    );
    const user = userEvent.setup();
    renderAdmin();
    const dialog = await openPublishDialog(user);

    await user.click(within(dialog).getByRole('button', { name: /publish now/i }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/archived/i);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not refetch the results after publishing', async () => {
    // The response IS the new state. Refetching would re-send winners' names
    // and email addresses a moment after receiving them — and the event-detail
    // key is a PREFIX of the results key, which is how that used to happen by
    // accident.
    mocks.publishResults.mockResolvedValue({ results: published() } as PublishResultsResponse);
    const user = userEvent.setup();
    renderAdmin();
    const dialog = await openPublishDialog(user);

    await user.click(within(dialog).getByRole('button', { name: /publish now/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.getEventResults).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('publish dialog accessibility', () => {
  it('is a modal dialog with a name and a description', async () => {
    const user = userEvent.setup();
    renderAdmin();
    const dialog = await openPublishDialog(user);

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    const describedBy = dialog.getAttribute('aria-describedby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBeTruthy();
    expect(document.getElementById(describedBy)?.textContent).toBeTruthy();
  });

  it('moves focus in, and returns it on close', async () => {
    const user = userEvent.setup();
    renderAdmin();
    const trigger = await screen.findByRole('button', { name: /publish results/i });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /publish now/i })).toHaveFocus(),
    );

    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes on Escape before a request, and not during one', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await openPublishDialog(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    let settle: (value: PublishResultsResponse) => void = () => {};
    mocks.publishResults.mockReturnValue(
      new Promise<PublishResultsResponse>((resolve) => {
        settle = resolve;
      }),
    );
    const dialog = await openPublishDialog(user);
    await user.click(within(dialog).getByRole('button', { name: /publish now/i }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    settle({ results: published() });
  });

  it('disables both buttons while the request is in flight', async () => {
    let settle: (value: PublishResultsResponse) => void = () => {};
    mocks.publishResults.mockReturnValue(
      new Promise<PublishResultsResponse>((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    renderAdmin();
    const dialog = await openPublishDialog(user);

    await user.click(within(dialog).getByRole('button', { name: /publish now/i }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /cancel/i })).toBeDisabled(),
    );
    expect(mocks.publishResults).toHaveBeenCalledTimes(1);
    settle({ results: published() });
  });
});

// ---------------------------------------------------------------------------
describe('archiving', () => {
  it('warns that an unpublished result will be lost for good', async () => {
    const user = userEvent.setup();
    renderAdmin();
    await user.click(await screen.findByRole('button', { name: /archive event/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('archive-discard-warning')).toHaveTextContent(
      /without publishing/i,
    );
    expect(dialog).toHaveTextContent(/cannot be undone/i);
  });

  it('does not warn when the results are already public', async () => {
    mocks.getEventResults.mockResolvedValue(published());
    const user = userEvent.setup();
    renderAdmin();
    await user.click(await screen.findByRole('button', { name: /archive event/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('archive-discard-warning')).toBeNull();
  });

  it('archives through the lifecycle transition, not a status patch', async () => {
    mocks.transitionEvent.mockResolvedValue({ event: { id: EVENT_ID, status: 'ARCHIVED' } });
    const user = userEvent.setup();
    renderAdmin();
    await user.click(await screen.findByRole('button', { name: /archive event/i }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /archive now/i }));

    await waitFor(() => expect(mocks.transitionEvent).toHaveBeenCalledTimes(1));
    expect(mocks.transitionEvent).toHaveBeenCalledWith(EVENT_ID, 'archive', undefined);
  });

  it('offers nothing once the event is archived', async () => {
    mocks.getEventResults.mockResolvedValue(
      published({
        eventStatus: 'ARCHIVED',
        archivedAt: '2026-08-03T10:00:00.000Z',
        canArchive: false,
        canPublish: false,
        publishBlocker: 'ALREADY_PUBLISHED',
      }),
    );
    renderAdmin();

    expect(await screen.findByTestId('archive-state')).toHaveTextContent(/archived/i);
    expect(screen.queryByRole('button', { name: /archive event/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /unarchive|reopen|restore/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /publish results/i })).toBeNull();
    // ...and the history is still all there.
    expect(screen.getByTestId('result-row-0')).toHaveTextContent('Miguel Fuenmayor');
  });
});

// ---------------------------------------------------------------------------
describe('the public results page', () => {
  it('shows the abbreviated names and the prizes', async () => {
    renderPublic();
    const first = await screen.findByTestId('public-winner-0');
    expect(first).toHaveTextContent('Miguel F.');
    expect(first).toHaveTextContent('Vape');
    expect(screen.getByTestId('public-winner-1')).toHaveTextContent('Maria D.');
  });

  it('shows no email, no full surname and no identifier', async () => {
    renderPublic();
    await screen.findByTestId('public-winner-0');
    const body = document.body.textContent ?? '';
    for (const leak of ['@example.com', 'Fuenmayor', 'Del Barrio', 'draw-1', 'a'.repeat(64)]) {
      expect(body, leak).not.toContain(leak);
    }
  });

  it('pairs each winner with their prize as one unit', async () => {
    // `<dt>`/`<dd>`, so a screen reader announces "Miguel F., Vape" together
    // rather than reading a grid cell by cell.
    renderPublic();
    const first = await screen.findByTestId('public-winner-0');
    expect(first.querySelector('dt')?.textContent).toBe('Miguel F.');
    expect(first.querySelector('dd')?.textContent).toContain('Vape');
  });

  it('renders a hostile prize name as text', async () => {
    mocks.getPublicEventResults.mockResolvedValue({
      ...publicResults(),
      results: {
        publishedAt: '2026-08-02T09:00:00.000Z',
        winners: [
          {
            displayName: 'Miguel F.',
            prizeName: '<script>alert(1)</script>',
            prizeDescription: '<img src=x onerror=alert(2)>',
            prizeUnitIndex: 1,
          },
        ],
      },
    });
    renderPublic();

    expect(await screen.findByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('says nothing about whether a draw happened when there are no results', async () => {
    mocks.getPublicEventResults.mockRejectedValue(
      new ApiError(404, 'RESULTS_NOT_AVAILABLE', 'nope'),
    );
    renderPublic();

    expect(await screen.findByText(/not available/i)).toBeInTheDocument();
    const body = (document.body.textContent ?? '').toLowerCase();
    for (const leak of ['draw', 'winner', 'private', 'unpublished']) {
      expect(body, leak).not.toContain(leak);
    }
  });

  it('offers no administrative controls at all', async () => {
    renderPublic();
    await screen.findByTestId('public-winner-0');
    expect(screen.queryByRole('button', { name: /publish|archive/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the two results caches are different caches', () => {
  it('the public key never shares a namespace with the administrative one', async () => {
    // They carry different shapes of the same facts — one names winners with
    // their email addresses, the other shows "Maria D." — so a shared key would
    // eventually hand a component the wrong one. Asserted for the SAME
    // identifier, because that is the only case in which a collision could
    // happen at all.
    const { queryKeys } = await import('../src/lib/queryKeys');
    const identifier = 'same-string-for-both';

    const admin = queryKeys.eventResults(identifier) as readonly unknown[];
    const publicKey = queryKeys.publicEventResults(identifier) as readonly unknown[];

    expect(JSON.stringify(publicKey)).not.toBe(JSON.stringify(admin));
    // Not merely different — rooted in different namespaces, so no prefix
    // invalidation on one can ever reach the other.
    expect(publicKey[0]).not.toBe(admin[0]);
  });
});
