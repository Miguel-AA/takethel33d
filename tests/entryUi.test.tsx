// Frontend behaviour of the participants screen.
//
// Read-only by design, so the interesting assertions are about what it does NOT
// do: no export, no editing, no date of birth in the table, and no value
// rendered as anything other than text.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { ApiError } from '../src/lib/api';
import type {
  EventEntryAnswer,
  EventEntryDetail,
  EventEntryListResponse,
  EventEntrySummary,
  EventFormVersionDetailResponse,
} from '../shared/types';

const mocks = vi.hoisted(() => ({
  listEventEntries: vi.fn(),
  getEventEntry: vi.fn(),
  getFormVersion: vi.fn(),
  me: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const { ManagerEventParticipantsPage } = await import(
  '../src/routes/ManagerEventParticipantsPage'
);

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const QUESTION_ID = '44444444-4444-4444-8444-444444444444';

function summary(overrides: Partial<EventEntrySummary> = {}): EventEntrySummary {
  return {
    entryId: ENTRY_ID,
    participantId: 'p-1',
    firstName: 'Ana',
    lastName: 'Lopez',
    email: 'ana@example.com',
    submittedAt: '2026-05-01T10:00:00.000Z',
    status: 'ELIGIBLE',
    calculatedAge: 21,
    overallEligible: true,
    eligibilityReason: 'ELIGIBLE',
    formVersionId: VERSION_ID,
    formVersionNumber: 1,
    answerCount: 3,
    ...overrides,
  };
}

function listResponse(
  items: EventEntrySummary[],
  overrides: Partial<EventEntryListResponse> = {},
): EventEntryListResponse {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 25,
    eventStatus: 'OPEN',
    acceptingEntries: true,
    ...overrides,
  };
}

function answer(overrides: Partial<EventEntryAnswer> = {}): EventEntryAnswer {
  return {
    id: `a-${overrides.questionKey ?? 'x'}`,
    entryId: ENTRY_ID,
    questionId: QUESTION_ID,
    questionKey: 'first_name',
    questionLabel: 'First name',
    type: 'SHORT_TEXT',
    value: 'Ana',
    ...overrides,
  };
}

function detailResponse(
  answers: EventEntryAnswer[],
  entry: Partial<EventEntryDetail['entry']> = {},
): EventEntryDetail {
  return {
    entry: {
      id: ENTRY_ID,
      eventId: EVENT_ID,
      participantId: 'p-1',
      formVersionId: VERSION_ID,
      status: 'ELIGIBLE',
      calculatedAge: 21,
      ageEligible: true,
      overallEligible: true,
      eligibilityReason: 'ELIGIBLE',
      ...entry,
      submittedAt: '2026-05-01T10:00:00.000Z',
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
      ...entry,
    },
    participant: {
      id: 'p-1',
      email: 'ana@example.com',
      normalizedEmail: 'ana@example.com',
      firstName: 'Ana',
      lastName: 'Lopez',
      phone: '555-0100',
      dateOfBirth: '1990-03-15',
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
    },
    formVersion: {
      id: VERSION_ID,
      versionNumber: 1,
      publishedAt: '2026-04-01T00:00:00.000Z',
    },
    answers,
  };
}

/** A version carrying the option labels the renderer resolves against. */
function versionResponse(): EventFormVersionDetailResponse {
  const AT = '2026-04-01T00:00:00.000Z';
  return {
    version: {
      id: VERSION_ID,
      eventId: EVENT_ID,
      versionNumber: 1,
      sourceDraftRevision: 1,
      publishedBy: 'admin-1',
      publishedAt: AT,
      createdAt: AT,
      steps: [
        {
          id: 's-1',
          ownerType: 'VERSION',
          ownerId: VERSION_ID,
          title: 'About you',
          description: null,
          sortOrder: 0,
          questions: [
            {
              id: QUESTION_ID,
              ownerType: 'VERSION',
              ownerId: VERSION_ID,
              stepId: 's-1',
              key: 'diet',
              systemField: 'NONE',
              type: 'MULTI_SELECT',
              label: 'Diet',
              description: null,
              placeholder: null,
              required: false,
              active: true,
              exportable: true,
              sortOrder: 0,
              validation: null,
              options: [
                {
                  id: 'o-1',
                  questionId: QUESTION_ID,
                  value: 'vegan',
                  label: 'Vegan',
                  sortOrder: 0,
                  active: true,
                  createdAt: AT,
                  updatedAt: AT,
                },
                {
                  id: 'o-2',
                  questionId: QUESTION_ID,
                  value: 'halal',
                  label: 'Halal',
                  sortOrder: 1,
                  active: true,
                  createdAt: AT,
                  updatedAt: AT,
                },
              ],
              createdAt: AT,
              updatedAt: AT,
            },
          ],
          createdAt: AT,
          updatedAt: AT,
        },
      ],
    },
    currentPublished: true,
    snapshot: { snapshotVersion: 1 } as never,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={[`/manager/events/${EVENT_ID}/participants`]}>
          <Routes>
            <Route
              path="/manager/events/:eventId/participants"
              element={<ManagerEventParticipantsPage />}
            />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getFormVersion.mockResolvedValue(versionResponse());
});

// ---------------------------------------------------------------------------
describe('the list', () => {
  it('renders one row per participation', async () => {
    mocks.listEventEntries.mockResolvedValue(
      listResponse([summary(), summary({ entryId: 'e-2', firstName: 'Bob', email: 'bob@x.com' })]),
    );
    renderPage();

    expect(await screen.findByText('Ana Lopez')).toBeInTheDocument();
    expect(screen.getByText('bob@x.com')).toBeInTheDocument();
    expect(screen.getAllByText('v1')).toHaveLength(2);
  });

  it('says so when nobody has entered yet', async () => {
    mocks.listEventEntries.mockResolvedValue(listResponse([]));
    renderPage();
    expect(await screen.findByText(/nobody has entered/i)).toBeInTheDocument();
  });

  it('shows a loading state, then the data', async () => {
    let resolve!: (value: EventEntryListResponse) => void;
    mocks.listEventEntries.mockReturnValue(
      new Promise<EventEntryListResponse>((r) => {
        resolve = r;
      }),
    );
    renderPage();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    resolve(listResponse([summary()]));
    expect(await screen.findByText('Ana Lopez')).toBeInTheDocument();
  });

  it('reports a failure instead of rendering an empty table', async () => {
    mocks.listEventEntries.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'boom'));
    renderPage();
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('searches by name, debounced', async () => {
    const user = userEvent.setup();
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()]));
    renderPage();
    await screen.findByText('Ana Lopez');

    await user.type(screen.getByLabelText(/search participants/i), 'lop');
    await waitFor(() =>
      expect(mocks.listEventEntries).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({ search: 'lop' }),
      ),
    );
  });

  it('pages through a larger list', async () => {
    const user = userEvent.setup();
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()], { total: 60 }));
    renderPage();
    await screen.findByText('Ana Lopez');

    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(mocks.listEventEntries).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({ page: 2 }),
      ),
    );
  });

  it('keeps the date of birth OUT of the table', async () => {
    // It belongs in the detail, behind a click. A screen left open on a shared
    // desk should not put everyone's date of birth on a wall.
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()]));
    renderPage();
    await screen.findByText('Ana Lopez');
    expect(screen.queryByText('1990-03-15')).not.toBeInTheDocument();
  });

  it('offers no export and no editing', async () => {
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()]));
    renderPage();
    await screen.findByText('Ana Lopez');

    for (const forbidden of [/export/i, /download/i, /csv/i, /edit/i, /delete/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).not.toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------
describe('the detail', () => {
  async function openDetail(answers: EventEntryAnswer[]) {
    const user = userEvent.setup();
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()]));
    mocks.getEventEntry.mockResolvedValue(detailResponse(answers));
    renderPage();
    await screen.findByText('Ana Lopez');
    await user.click(screen.getByRole('button', { name: /view/i }));
    return within(await screen.findByRole('dialog'));
  }

  it('shows the identity, including the fields the table withholds', async () => {
    const dialog = await openDetail([answer()]);
    expect(dialog.getByText('ana@example.com')).toBeInTheDocument();
    expect(dialog.getByText('555-0100')).toBeInTheDocument();
    expect(dialog.getByText('1990-03-15')).toBeInTheDocument();
  });

  it('labels each answer as the form read WHEN IT WAS ANSWERED', async () => {
    const dialog = await openDetail([answer({ questionLabel: 'What we asked back then' })]);
    expect(dialog.getByText('What we asked back then')).toBeInTheDocument();
  });

  it('renders every answer shape', async () => {
    const dialog = await openDetail([
      answer({ questionKey: 'notes', type: 'LONG_TEXT', value: 'line one\nline two' }),
      answer({ questionKey: 'age', type: 'NUMBER', value: 42 }),
      answer({ questionKey: 'terms', type: 'CONSENT', value: true }),
      answer({ questionKey: 'smoker', type: 'YES_NO', value: false }),
      answer({ questionKey: 'dob', type: 'DATE', value: '1990-03-15' }),
      answer({ questionKey: 'diet', type: 'MULTI_SELECT', value: ['vegan', 'halal'] }),
    ]);

    expect(dialog.getByText(/line one/)).toBeInTheDocument();
    expect(dialog.getByText('42')).toBeInTheDocument();
    // "Yes" appears twice: the consent answer, and the age-requirement row the
    // eligibility phase added above it. Both are meant to be there.
    expect(dialog.getAllByText('Yes')).toHaveLength(2);
    expect(dialog.getByText('No')).toBeInTheDocument();
    // Option LABELS, resolved from the immutable version rather than stored a
    // second time on the answer row.
    expect(dialog.getByText('Vegan')).toBeInTheDocument();
    expect(dialog.getByText('Halal')).toBeInTheDocument();
  });

  it('falls back to the stored value when the version cannot be read', async () => {
    mocks.getFormVersion.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'boom'));
    const dialog = await openDetail([
      answer({ questionKey: 'diet', type: 'MULTI_SELECT', value: ['vegan'] }),
    ]);
    // Showing the raw value is honest; inventing a label would not be.
    expect(await dialog.findByText('vegan')).toBeInTheDocument();
  });

  it('says so when an entry has no answers', async () => {
    const dialog = await openDetail([]);
    expect(dialog.getByText(/no answers/i)).toBeInTheDocument();
  });

  it('renders an answer that looks like markup as TEXT', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const dialog = await openDetail([
      answer({ questionKey: 'notes', type: 'LONG_TEXT', value: hostile }),
    ]);
    expect(dialog.getByText(hostile)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('reports a 404 as an entry that is not this event’s', async () => {
    const user = userEvent.setup();
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()]));
    mocks.getEventEntry.mockRejectedValue(
      new ApiError(404, 'EVENT_ENTRY_NOT_FOUND', 'not found'),
    );
    renderPage();
    await screen.findByText('Ana Lopez');
    await user.click(screen.getByRole('button', { name: /view/i }));

    const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByText(/does not belong to this event/i)).toBeInTheDocument();
  });

  it('closes without leaving the dialog behind', async () => {
    const user = userEvent.setup();
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()]));
    mocks.getEventEntry.mockResolvedValue(detailResponse([answer()]));
    renderPage();
    await screen.findByText('Ana Lopez');
    await user.click(screen.getByRole('button', { name: /view/i }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('is announced as a dialog, with a name', async () => {
    const dialog = await openDetail([answer()]);
    const element = dialog.getByText(/participation/i);
    expect(element).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label');
  });
});

// ---------------------------------------------------------------------------
describe('the decision on screen', () => {
  it('shows the verdict, the age at submission and the reason', async () => {
    mocks.listEventEntries.mockResolvedValue(
      listResponse([
        summary({
          firstName: 'Maria',
          lastName: 'D',
          email: 'maria@example.com',
          status: 'INELIGIBLE',
          calculatedAge: 20,
          overallEligible: false,
          eligibilityReason: 'AGE_REQUIREMENT_NOT_MET',
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText('Maria D')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('Ineligible')).toBeInTheDocument();
    // The REASON, translated. An operator explaining an exclusion should not
    // have to decode `AGE_REQUIREMENT_NOT_MET` in their head.
    expect(screen.getByText('Below the minimum age')).toBeInTheDocument();
    expect(screen.queryByText('AGE_REQUIREMENT_NOT_MET')).not.toBeInTheDocument();
  });

  it('shows an eligible participation as eligible', async () => {
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()]));
    renderPage();
    // The badge and the reason both read "Eligible" — the verdict and why.
    expect(await screen.findAllByText('Eligible')).toHaveLength(2);
    expect(screen.getByText('21')).toBeInTheDocument();
  });

  it('still renders a historical SUBMITTED row rather than hiding it', async () => {
    // Entries recorded before eligibility existed were never judged. They are
    // deliberately not recomputed, so the screen has to be able to show them.
    mocks.listEventEntries.mockResolvedValue(
      listResponse([
        summary({
          status: 'SUBMITTED',
          calculatedAge: null,
          overallEligible: null,
          eligibilityReason: null,
        }),
      ]),
    );
    renderPage();
    // The column header also reads "Submitted"; the badge is the one in a cell.
    const cells = await screen.findAllByText('Submitted');
    expect(cells.some((node) => node.tagName !== 'TH')).toBe(true);
    // No age, no reason — shown as absent rather than invented.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('keeps the date of birth out of the table but shows the age', async () => {
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()]));
    renderPage();
    await screen.findByText('Ana Lopez');
    expect(screen.queryByText('1990-03-15')).not.toBeInTheDocument();
    expect(screen.getByText('21')).toBeInTheDocument();
  });

  it('labels the detail as AT SUBMISSION, not as current', async () => {
    const user = userEvent.setup();
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()]));
    mocks.getEventEntry.mockResolvedValue(detailResponse([answer()]));
    renderPage();
    await screen.findByText('Ana Lopez');
    await user.click(screen.getByRole('button', { name: /view/i }));

    const dialog = within(await screen.findByRole('dialog'));
    // A decision belongs to the moment it was taken; the label must say so.
    expect(dialog.getByText(/age at submission/i)).toBeInTheDocument();
    expect(dialog.getByText(/eligibility at submission/i)).toBeInTheDocument();
    expect(dialog.queryByText(/current age/i)).not.toBeInTheDocument();
  });

  it('says "no age requirement" rather than "no" when nothing was judged', async () => {
    const user = userEvent.setup();
    mocks.listEventEntries.mockResolvedValue(listResponse([summary()]));
    mocks.getEventEntry.mockResolvedValue(
      detailResponse([answer()], { ageEligible: null, calculatedAge: 30 }),
    );
    renderPage();
    await screen.findByText('Ana Lopez');
    await user.click(screen.getByRole('button', { name: /view/i }));

    const dialog = within(await screen.findByRole('dialog'));
    // `null` is not `false`: an event with no age limit did not fail anybody.
    expect(dialog.getByText(/no age requirement/i)).toBeInTheDocument();
  });

  it('renders an unknown reason code as text rather than blank', async () => {
    // Showing something true and ugly beats showing nothing.
    mocks.listEventEntries.mockResolvedValue(
      listResponse([
        summary({
          eligibilityReason: 'SOMETHING_NEW' as never,
          status: 'INELIGIBLE',
          overallEligible: false,
        }),
      ]),
    );
    renderPage();
    expect(await screen.findByText('SOMETHING_NEW')).toBeInTheDocument();
  });
});
