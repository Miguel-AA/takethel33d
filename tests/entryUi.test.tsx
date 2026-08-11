// Frontend behaviour of the participants screen.
//
// Phase 10 turned this from a read-only list into an administrative surface, so
// the suite now covers disposition as well — but every property the read-only
// version asserted is still here, because none of them stopped mattering: no
// date of birth in the table, no value rendered as anything but text, answers
// labelled as the form read WHEN THEY WERE GIVEN, and a decision presented as
// something that happened at a moment rather than something true now.
//
// What is new: the two-column distinction between the historical verdict and
// the current disposition, the actions the shared rules permit, and what
// happens when two administrators act on the same row.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { ApiError } from '../src/lib/api';
import type {
  AdminEventParticipant,
  AdminParticipantListResponse,
  AdminParticipantSummary,
  AdminParticipantSummaryResponse,
  EventEntryAnswer,
  EventFormVersionDetailResponse,
} from '../shared/types';

const mocks = vi.hoisted(() => ({
  listAdminParticipants: vi.fn(),
  getAdminParticipantSummary: vi.fn(),
  getAdminParticipant: vi.fn(),
  disqualifyParticipant: vi.fn(),
  reinstateParticipant: vi.fn(),
  listFormVersions: vi.fn(),
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function row(overrides: Partial<AdminParticipantSummary> = {}): AdminParticipantSummary {
  return {
    entryId: ENTRY_ID,
    revision: 1,
    participantId: 'p-1',
    firstName: 'Ana',
    lastName: 'Lopez',
    email: 'ana@example.com',
    status: 'ELIGIBLE',
    overallEligible: true,
    calculatedAge: 21,
    eligibilityReason: 'ELIGIBLE',
    submittedAt: '2026-05-01T10:00:00.000Z',
    formVersionId: VERSION_ID,
    formVersionNumber: 1,
    answerCount: 3,
    disqualifiedAt: null,
    ...overrides,
  };
}

function listResponse(
  items: AdminParticipantSummary[],
  overrides: Partial<AdminParticipantListResponse> = {},
): AdminParticipantListResponse {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 25,
    eventStatus: 'OPEN',
    administrationAllowed: true,
    ...overrides,
  };
}

function summaryResponse(
  overrides: Partial<AdminParticipantSummaryResponse['summary']> = {},
): AdminParticipantSummaryResponse {
  return {
    summary: {
      total: 1,
      eligible: 1,
      ineligible: 0,
      submitted: 0,
      disqualified: 0,
      drawEligible: 1,
      ...overrides,
    },
    eventStatus: 'OPEN',
    administrationAllowed: true,
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

function participant(
  answers: EventEntryAnswer[],
  overrides: Partial<AdminEventParticipant['entry']> = {},
  actions: Partial<AdminEventParticipant['actions']> = {},
): AdminEventParticipant {
  return {
    entryId: ENTRY_ID,
    entryRevision: 1,
    participant: {
      id: 'p-1',
      firstName: 'Ana',
      lastName: 'Lopez',
      email: 'ana@example.com',
      phone: '555-0100',
      dateOfBirth: '1990-03-15',
    },
    entry: {
      status: 'ELIGIBLE',
      submittedAt: '2026-05-01T10:00:00.000Z',
      formVersionId: VERSION_ID,
      formVersionNumber: 1,
      calculatedAge: 21,
      ageEligible: true,
      overallEligible: true,
      eligibilityReason: 'ELIGIBLE',
      disposition: null,
      ...overrides,
    },
    answers,
    actions: { available: ['DISQUALIFY'], blocked: [], reinstatesTo: null, ...actions },
  };
}

function versionResponse(
  questions: Array<Record<string, unknown>> = [],
): EventFormVersionDetailResponse {
  return {
    version: {
      id: VERSION_ID,
      eventId: EVENT_ID,
      versionNumber: 1,
      sourceDraftRevision: 1,
      publishedBy: 'u-1',
      publishedAt: '2026-04-01T00:00:00.000Z',
      createdAt: '2026-04-01T00:00:00.000Z',
      steps: [
        {
          id: 's-1',
          ownerType: 'VERSION',
          ownerId: VERSION_ID,
          title: 'About you',
          description: null,
          sortOrder: 0,
          questions: questions as never,
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
      ],
    },
    currentPublished: true,
    snapshot: {} as never,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
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
  vi.clearAllMocks();
  mocks.listAdminParticipants.mockResolvedValue(listResponse([row()]));
  mocks.getAdminParticipantSummary.mockResolvedValue(summaryResponse());
  mocks.listFormVersions.mockResolvedValue({ items: [], currentVersionId: null });
  mocks.getAdminParticipant.mockResolvedValue({
    participant: participant([answer()]),
    eventStatus: 'OPEN',
  });
  mocks.getFormVersion.mockResolvedValue(versionResponse());
});

/** Opens the detail panel for the first row. */
async function openDetail(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /view|ver/i }));
  return screen.findByRole('dialog');
}

// ---------------------------------------------------------------------------
describe('the list', () => {
  it('renders one row per participation', async () => {
    mocks.listAdminParticipants.mockResolvedValue(
      listResponse([
        row(),
        row({ entryId: 'e-2', participantId: 'p-2', firstName: 'Bea', email: 'bea@example.com' }),
      ]),
    );
    renderPage();

    expect(await screen.findByText('Ana Lopez')).toBeInTheDocument();
    expect(screen.getByText('Bea Lopez')).toBeInTheDocument();
  });

  it('says so when nobody has entered yet', async () => {
    mocks.listAdminParticipants.mockResolvedValue(listResponse([]));
    renderPage();
    expect(await screen.findByText(/No participants yet|Todavía no hay/i)).toBeInTheDocument();
  });

  it('distinguishes an empty event from a filter that matched nothing', async () => {
    // Telling an operator the event is empty when their filter is simply too
    // narrow sends them looking for a bug that is not there.
    const user = userEvent.setup();
    mocks.listAdminParticipants.mockResolvedValue(listResponse([]));
    renderPage();

    await screen.findByText(/No participants yet|Todavía no hay/i);
    await user.type(screen.getByLabelText(/Search participants|Buscar/i), 'zzz');

    expect(
      await screen.findByText(/No participants match|Ningún participante coincide/i),
    ).toBeInTheDocument();
  });

  it('shows a loading state, then the data', async () => {
    let release: (value: AdminParticipantListResponse) => void = () => {};
    mocks.listAdminParticipants.mockReturnValue(
      new Promise<AdminParticipantListResponse>((resolve) => {
        release = resolve;
      }),
    );
    renderPage();

    expect(await screen.findByText(/Loading|Cargando/i)).toBeInTheDocument();
    release(listResponse([row()]));
    expect(await screen.findByText('Ana Lopez')).toBeInTheDocument();
  });

  it('reports a failure instead of rendering an empty table', async () => {
    mocks.listAdminParticipants.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'boom'));
    renderPage();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('searches by name, debounced and on the SERVER', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ana Lopez');

    await user.type(screen.getByLabelText(/Search participants|Buscar/i), 'bea');

    await waitFor(() => {
      expect(mocks.listAdminParticipants).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({ search: 'bea', page: 1 }),
      );
    });
    // Debounced: not one request per keystroke.
    expect(mocks.listAdminParticipants.mock.calls.length).toBeLessThan(4);
  });

  it('pages through a larger list', async () => {
    const user = userEvent.setup();
    mocks.listAdminParticipants.mockResolvedValue(listResponse([row()], { total: 60 }));
    renderPage();
    await screen.findByText('Ana Lopez');

    await user.click(screen.getByRole('button', { name: /next|siguiente/i }));

    await waitFor(() => {
      expect(mocks.listAdminParticipants).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({ page: 2 }),
      );
    });
  });

  it('sends filters to the server rather than filtering locally', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Ana Lopez');

    await user.selectOptions(
      screen.getByLabelText(/Current status|Estado actual/i),
      'DISQUALIFIED',
    );

    await waitFor(() => {
      expect(mocks.listAdminParticipants).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({ status: 'DISQUALIFIED', page: 1 }),
      );
    });
  });

  it('keeps the date of birth and the phone number OUT of the table', async () => {
    // A table is a screen left open on a shared desk.
    renderPage();
    await screen.findByText('Ana Lopez');

    expect(screen.queryByText('1990-03-15')).toBeNull();
    expect(screen.queryByText('555-0100')).toBeNull();
  });

  it('offers no export and no way to edit an answer', async () => {
    renderPage();
    await screen.findByText('Ana Lopez');

    expect(screen.queryByRole('button', { name: /export|csv|descargar/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit answer|editar respuesta/i })).toBeNull();
  });

  it('shows the historical verdict and the current status as SEPARATE columns', async () => {
    // Somebody who qualified and was later disqualified reads "Qualified /
    // Disqualified", which is the truth and is not expressible in one column.
    mocks.listAdminParticipants.mockResolvedValue(
      listResponse([
        row({
          status: 'DISQUALIFIED',
          overallEligible: true,
          disqualifiedAt: '2026-05-02T10:00:00.000Z',
        }),
      ]),
    );
    renderPage();

    const cells = await screen.findAllByRole('cell');
    const text = cells.map((cell) => cell.textContent).join(' | ');
    expect(text).toMatch(/Qualified|Cumplía/);
    expect(text).toMatch(/Disqualified|Descalificad/);
  });
});

// ---------------------------------------------------------------------------
describe('the summary', () => {
  it('shows eligible-at-submission and draw-eligible as different figures', async () => {
    mocks.getAdminParticipantSummary.mockResolvedValue(
      summaryResponse({ total: 10, eligible: 6, ineligible: 3, disqualified: 2, drawEligible: 4 }),
    );
    renderPage();

    expect(await screen.findByTestId('participant-count-eligible')).toHaveTextContent('6');
    // Two of the six qualified people have since been disqualified.
    expect(screen.getByTestId('participant-count-drawEligible')).toHaveTextContent('4');
    expect(screen.getByTestId('participant-count-disqualified')).toHaveTextContent('2');
  });

  it('labels them distinctly rather than calling both "eligible"', async () => {
    renderPage();
    await screen.findByTestId('participant-count-eligible');

    expect(screen.getByText(/Eligible at submission|Elegibles al inscribirse/i)).toBeInTheDocument();
    expect(screen.getByText(/Eligible for the draw|Elegibles para el sorteo/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('the detail', () => {
  it('shows the identity, including the fields the table withholds', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByText('555-0100')).toBeInTheDocument();
    expect(within(dialog).getByText('1990-03-15')).toBeInTheDocument();
  });

  it('labels each answer as the form read WHEN IT WAS ANSWERED', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant([
        answer({ questionLabel: 'What was your name in 2026?', value: 'Ana' }),
      ]),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByText('What was your name in 2026?')).toBeInTheDocument();
  });

  it('says which form version was used', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDetail(user);
    expect(within(dialog).getByText(/form v1|versión v1/i)).toBeInTheDocument();
  });

  it('reads the answers against the ENTRY’s version, not the current one', async () => {
    const user = userEvent.setup();
    renderPage();
    await openDetail(user);

    await waitFor(() => {
      expect(mocks.getFormVersion).toHaveBeenCalledWith(EVENT_ID, VERSION_ID);
    });
  });

  it('renders every answer shape', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant([
        answer({ id: 'a1', questionKey: 'name', value: 'Ana' }),
        answer({ id: 'a2', questionKey: 'age', type: 'NUMBER', value: 30 }),
        answer({ id: 'a3', questionKey: 'agree', type: 'CONSENT', value: true }),
        answer({ id: 'a4', questionKey: 'picks', type: 'MULTI_SELECT', value: ['a', 'b'] }),
      ]),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByText('Ana')).toBeInTheDocument();
    expect(within(dialog).getByText('30')).toBeInTheDocument();
  });

  it('falls back to the stored value when the version cannot be read', async () => {
    const user = userEvent.setup();
    mocks.getFormVersion.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'gone'));
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant([
        answer({ questionKey: 'picks', type: 'SINGLE_SELECT', value: 'stored_value' }),
      ]),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(await within(dialog).findByText(/stored_value/)).toBeInTheDocument();
  });

  it('says so when an entry has no answers', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant([]),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByText(/No answers|No hay respuestas/i)).toBeInTheDocument();
  });

  it('renders an answer that looks like markup as TEXT', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant([
        answer({ value: '<img src=x onerror=alert(1)>' }),
      ]),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });

  it('reports a 404 as an entry that is not this event’s', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockRejectedValue(
      new ApiError(404, 'EVENT_ENTRY_NOT_FOUND', 'nope'),
    );
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
  });

  it('closes without leaving the dialog behind', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDetail(user);

    await user.click(within(dialog).getByRole('button', { name: /close|cerrar/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('is announced as a dialog, with a name', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDetail(user);

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName();
  });
});

// ---------------------------------------------------------------------------
describe('the decision on screen', () => {
  it('shows the verdict, the age at submission and the reason', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByText('21')).toBeInTheDocument();
    expect(within(dialog).getByText(/Age at submission|Edad al inscribirse/i)).toBeInTheDocument();
  });

  it('still renders a historical SUBMITTED row rather than hiding it', async () => {
    mocks.listAdminParticipants.mockResolvedValue(
      listResponse([
        row({
          status: 'SUBMITTED',
          overallEligible: null,
          calculatedAge: null,
          eligibilityReason: null,
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText('Ana Lopez')).toBeInTheDocument();
    expect(screen.getByText(/Not judged|Sin evaluar/i)).toBeInTheDocument();
  });

  it('labels the detail as AT SUBMISSION, not as current', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDetail(user);

    expect(
      within(dialog).getByText(/Eligibility at submission|Elegibilidad al inscribirse/i),
    ).toBeInTheDocument();
  });

  it('says "no age requirement" rather than "no" when nothing was judged', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant([answer()], { ageEligible: null, calculatedAge: null }),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).queryByText(/^No$/)).toBeNull();
  });

  it('renders an unknown reason code as text rather than blank', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant([answer()], {
        eligibilityReason: 'SOMETHING_NEW' as never,
      }),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByText('SOMETHING_NEW')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('administrative disposition', () => {
  it('offers only the actions the shared rules permit', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant([answer()], {}, { available: ['DISQUALIFY'] }),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByRole('button', { name: /Disqualify|Descalificar/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Reinstate|Readmitir/i })).toBeNull();
  });

  it('offers NOTHING when the event state forbids it', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant(
        [answer()],
        {},
        {
          available: [],
          blocked: [{ action: 'DISQUALIFY', blocker: 'EVENT_STATE_FORBIDS' }],
        },
      ),
      eventStatus: 'DRAW_COMPLETED',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).queryByRole('button', { name: /Disqualify|Descalificar/i })).toBeNull();
    expect(
      within(dialog).getByText(/cannot be administered|No se pueden administrar/i),
    ).toBeInTheDocument();
  });

  it('requires a reason before it will submit', async () => {
    const user = userEvent.setup();
    renderPage();
    const detail = await openDetail(user);
    await user.click(within(detail).getByRole('button', { name: /Disqualify|Descalificar/i }));

    const dialogs = await screen.findAllByRole('dialog');
    const confirm = within(dialogs.at(-1)!).getByRole('button', { name: /Confirm|Confirmar/i });
    expect(confirm).toBeDisabled();
    expect(mocks.disqualifyParticipant).not.toHaveBeenCalled();
  });

  it('sends the reason and the revision it was shown', async () => {
    const user = userEvent.setup();
    mocks.disqualifyParticipant.mockResolvedValue({
      participant: participant([answer()], { status: 'DISQUALIFIED' }),
    });
    renderPage();
    const detail = await openDetail(user);
    await user.click(within(detail).getByRole('button', { name: /Disqualify|Descalificar/i }));

    const dialogs = await screen.findAllByRole('dialog');
    const dialog = dialogs.at(-1)!;
    await user.type(within(dialog).getByLabelText(/Reason|Motivo/i), 'Entered twice');
    await user.click(within(dialog).getByRole('button', { name: /Confirm|Confirmar/i }));

    await waitFor(() => {
      expect(mocks.disqualifyParticipant).toHaveBeenCalledWith(EVENT_ID, ENTRY_ID, {
        expectedRevision: 1,
        reason: 'Entered twice',
      });
    });
  });

  it('names where a reinstatement will land, rather than implying "eligible"', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant(
        [answer()],
        {
          status: 'DISQUALIFIED',
          overallEligible: false,
          disposition: {
            disqualifiedAt: '2026-05-02T10:00:00.000Z',
            disqualifiedByAdminId: 'u-1',
            disqualifiedByName: 'Ada',
            reason: 'Entered twice',
            preDisqualificationStatus: 'INELIGIBLE',
          },
        },
        { available: ['REINSTATE'], reinstatesTo: 'INELIGIBLE' },
      ),
      eventStatus: 'OPEN',
    });
    renderPage();
    const detail = await openDetail(user);
    await user.click(within(detail).getByRole('button', { name: /Reinstate|Readmitir/i }));

    const dialogs = await screen.findAllByRole('dialog');
    // The entry never qualified, so it returns to INELIGIBLE — saying
    // "reinstate" without naming the destination would imply otherwise.
    expect(within(dialogs.at(-1)!).getByText(/INELIGIBLE|No elegible/i)).toBeInTheDocument();
  });

  it('does not offer disqualification to an already-disqualified entry', async () => {
    // The mirror of the first test in this block, and not redundant with it:
    // that one proves REINSTATE is hidden when only DISQUALIFY is available,
    // this one proves DISQUALIFY is hidden when only REINSTATE is. Without
    // both, a renderer that ignored `available` for one of the two buttons
    // would go unnoticed.
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant(
        [answer()],
        {
          status: 'DISQUALIFIED',
          disposition: {
            disqualifiedAt: '2026-05-02T10:00:00.000Z',
            disqualifiedByAdminId: 'u-1',
            disqualifiedByName: 'Ada',
            reason: 'Entered twice',
            preDisqualificationStatus: 'ELIGIBLE',
          },
        },
        { available: ['REINSTATE'], reinstatesTo: 'ELIGIBLE' },
      ),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByRole('button', { name: /Reinstate|Readmitir/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Disqualify|Descalificar/i })).toBeNull();
  });

  it('shows the disposition, including who recorded it and why', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant(
        [answer()],
        {
          status: 'DISQUALIFIED',
          disposition: {
            disqualifiedAt: '2026-05-02T10:00:00.000Z',
            disqualifiedByAdminId: 'u-1',
            disqualifiedByName: 'Ada Lovelace',
            reason: 'Entered twice',
            preDisqualificationStatus: 'ELIGIBLE',
          },
        },
        { available: ['REINSTATE'], reinstatesTo: 'ELIGIBLE' },
      ),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(dialog).getByText('Entered twice')).toBeInTheDocument();
  });

  it('renders a disqualification reason that looks like markup as TEXT', async () => {
    const user = userEvent.setup();
    mocks.getAdminParticipant.mockResolvedValue({
      participant: participant(
        [answer()],
        {
          status: 'DISQUALIFIED',
          disposition: {
            disqualifiedAt: '2026-05-02T10:00:00.000Z',
            disqualifiedByAdminId: 'u-1',
            disqualifiedByName: 'Ada',
            reason: '<script>alert(1)</script>',
            preDisqualificationStatus: 'ELIGIBLE',
          },
        },
        { available: ['REINSTATE'], reinstatesTo: 'ELIGIBLE' },
      ),
      eventStatus: 'OPEN',
    });
    renderPage();
    const dialog = await openDetail(user);

    expect(within(dialog).getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });

  it('reports a revision conflict instead of pretending it worked', async () => {
    const user = userEvent.setup();
    mocks.disqualifyParticipant.mockRejectedValue(
      new ApiError(409, 'ENTRY_REVISION_CONFLICT', 'moved', { currentRevision: '2' }),
    );
    renderPage();
    const detail = await openDetail(user);
    await user.click(within(detail).getByRole('button', { name: /Disqualify|Descalificar/i }));

    const dialogs = await screen.findAllByRole('dialog');
    const dialog = dialogs.at(-1)!;
    await user.type(within(dialog).getByLabelText(/Reason|Motivo/i), 'Entered twice');
    await user.click(within(dialog).getByRole('button', { name: /Confirm|Confirmar/i }));

    expect(
      await within(dialog).findByText(/changed while you were|cambió mientras/i),
    ).toBeInTheDocument();
  });

  it('closes on Escape without submitting anything', async () => {
    const user = userEvent.setup();
    renderPage();
    const detail = await openDetail(user);
    await user.click(within(detail).getByRole('button', { name: /Disqualify|Descalificar/i }));
    await screen.findAllByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByLabelText(/Reason|Motivo/i)).toBeNull();
    });
    expect(mocks.disqualifyParticipant).not.toHaveBeenCalled();
  });
});
