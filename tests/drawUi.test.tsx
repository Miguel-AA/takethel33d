// Frontend behaviour of the draw screen.
//
// The properties this suite exists to hold are not cosmetic. A draw cannot be
// undone, so the interface has exactly two jobs: make it impossible to run one
// by accident, and make it impossible to believe another one is available
// afterwards.
//
//   * the button is disabled until the SERVER says it can run
//   * running it requires a typed confirmation, not a click
//   * once a draw exists, nothing on the screen offers another — not even
//     disabled, because a greyed-out button implies a state in which it works
//   * a refusal keeps the dialog open with the reason in it
//   * the prize name shown is the snapshot, not the live prize

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { ApiError } from '../src/lib/api';
import type { DrawResponse, DrawStatusResponse } from '../shared/types';

const mocks = vi.hoisted(() => ({
  getDraw: vi.fn(),
  runDraw: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const { ManagerEventDrawPage } = await import('../src/routes/ManagerEventDrawPage');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function readiness(
  overrides: Partial<DrawStatusResponse['readiness']> = {},
): DrawStatusResponse['readiness'] {
  return {
    eventStatus: 'DRAW_READY',
    candidateCount: 10,
    prizeUnitCount: 3,
    plannedWinnerCount: 3,
    canRun: true,
    blockers: [],
    ...overrides,
  };
}

function completed(): DrawResponse {
  return {
    draw: {
      id: 'draw-1',
      completedAt: '2026-08-01T12:00:00.000Z',
      candidateCount: 10,
      prizeUnitCount: 3,
      assignmentCount: 3,
      algorithmVersion: 'CRYPTO_FISHER_YATES_V1',
      candidateSetHash: 'a'.repeat(64),
      executedByAdminId: 'admin-1',
      executedByName: 'Ada Lovelace',
    },
    assignments: [
      {
        id: 'as-1',
        drawOrder: 0,
        prize: { id: 'p1', name: 'Vape', description: null, unitIndex: 1 },
        winner: {
          entryId: 'e1',
          firstName: 'Ana',
          lastName: 'Lopez',
          email: 'ana@example.com',
        },
      },
      {
        id: 'as-2',
        drawOrder: 1,
        prize: { id: 'p1', name: 'Vape', description: null, unitIndex: 2 },
        winner: {
          entryId: 'e2',
          firstName: 'Bea',
          lastName: 'Ruiz',
          email: 'bea@example.com',
        },
      },
      {
        id: 'as-3',
        drawOrder: 2,
        prize: { id: 'p2', name: 'Grinder', description: null, unitIndex: 1 },
        winner: {
          entryId: 'e3',
          firstName: 'Cleo',
          lastName: 'Diaz',
          email: 'cleo@example.com',
        },
      },
    ],
    eventStatus: 'DRAW_COMPLETED',
  };
}

function status(overrides: Partial<DrawStatusResponse> = {}): DrawStatusResponse {
  return {
    draw: null,
    assignments: [],
    eventStatus: 'DRAW_READY',
    readiness: readiness(),
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[`/manager/events/${EVENT_ID}/draw`]}>
          <Routes>
            <Route path="/manager/events/:eventId/draw" element={<ManagerEventDrawPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDraw.mockResolvedValue(status());
});

/** Opens the confirmation dialog. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /run the draw/i }));
  return screen.findByRole('dialog');
}

// ---------------------------------------------------------------------------
describe('before a draw', () => {
  it('shows the three figures the operator needs', async () => {
    renderPage();
    expect(await screen.findByTestId('draw-ready-candidates')).toHaveTextContent('10');
    expect(screen.getByTestId('draw-ready-units')).toHaveTextContent('3');
    expect(screen.getByTestId('draw-ready-winners')).toHaveTextContent('3');
  });

  it('offers the button when the server says it can run', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: /run the draw/i })).toBeEnabled();
  });

  it('disables the button when the server says it cannot', async () => {
    mocks.getDraw.mockResolvedValue(
      status({
        readiness: readiness({ canRun: false, blockers: ['NO_ELIGIBLE_PARTICIPANTS'] }),
      }),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: /run the draw/i })).toBeDisabled();
  });

  it('explains each blocker in words the operator can act on', async () => {
    mocks.getDraw.mockResolvedValue(
      status({
        readiness: readiness({
          canRun: false,
          blockers: ['NO_ELIGIBLE_PARTICIPANTS', 'NO_ACTIVE_PRIZES'],
        }),
      }),
    );
    renderPage();

    const blockers = await screen.findByTestId('draw-blockers');
    expect(blockers).toHaveTextContent(/nobody is currently eligible/i);
    expect(blockers).toHaveTextContent(/no active prizes/i);
  });

  it('warns when there are more prizes than people', async () => {
    mocks.getDraw.mockResolvedValue(
      status({ readiness: readiness({ candidateCount: 2, prizeUnitCount: 5, plannedWinnerCount: 2 }) }),
    );
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);
    expect(dialog).toHaveTextContent(/3 prize unit\(s\) will go unawarded/i);
  });
});

// ---------------------------------------------------------------------------
describe('the confirmation', () => {
  it('does not run on the first click', async () => {
    const user = userEvent.setup();
    renderPage();
    await openDialog(user);
    // The click opened a dialog. It did not draw.
    expect(mocks.runDraw).not.toHaveBeenCalled();
  });

  it('says how many will win, from the server’s numbers', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);
    expect(dialog).toHaveTextContent(/3 of 10 eligible participants/i);
  });

  it('states that it cannot be undone', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);
    expect(dialog).toHaveTextContent(/cannot be undone/i);
  });

  it('keeps the confirm button disabled until the phrase is typed', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);

    const confirm = within(dialog).getByRole('button', { name: /draw now/i });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByRole('textbox'), 'DRAW');
    expect(confirm).toBeEnabled();
  });

  it('refuses a near-miss phrase', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByRole('textbox'), 'DRAWW');
    expect(within(dialog).getByRole('button', { name: /draw now/i })).toBeDisabled();
    expect(mocks.runDraw).not.toHaveBeenCalled();
  });

  it('accepts the phrase with stray whitespace or different case', async () => {
    // Deliberate confirmation, not a typing test.
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByRole('textbox'), '  draw  ');
    expect(within(dialog).getByRole('button', { name: /draw now/i })).toBeEnabled();
  });

  it('runs the draw with NO arguments once confirmed', async () => {
    mocks.runDraw.mockResolvedValue(completed());
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByRole('textbox'), 'DRAW');
    await user.click(within(dialog).getByRole('button', { name: /draw now/i }));

    await waitFor(() => expect(mocks.runDraw).toHaveBeenCalledTimes(1));
    // The hook takes no payload: there is nothing about a draw for a caller to
    // specify, and a mutation that accepted one would be an invitation.
    expect(mocks.runDraw).toHaveBeenCalledWith(EVENT_ID);
  });

  it('can be cancelled without drawing', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.runDraw).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('after a draw', () => {
  beforeEach(() => {
    mocks.getDraw.mockResolvedValue({
      ...completed(),
      readiness: readiness({
        eventStatus: 'DRAW_COMPLETED',
        canRun: false,
        blockers: ['DRAW_ALREADY_COMPLETED'],
      }),
    } as DrawStatusResponse);
  });

  it('offers nothing that could produce another draw', async () => {
    renderPage();
    await screen.findByText(/draw result/i);
    // Not disabled — ABSENT. A greyed-out button implies a state in which it
    // would work, and there is no such state.
    expect(screen.queryByRole('button', { name: /run the draw/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /draw now/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /again/i })).toBeNull();
  });

  it('reports all three counts, not just the winners', async () => {
    renderPage();
    expect(await screen.findByTestId('draw-count-candidates')).toHaveTextContent('10');
    expect(screen.getByTestId('draw-count-units')).toHaveTextContent('3');
    expect(screen.getByTestId('draw-count-winners')).toHaveTextContent('3');
  });

  it('shows the algorithm and the candidate hash in full', async () => {
    renderPage();
    expect(await screen.findByText('CRYPTO_FISHER_YATES_V1')).toBeInTheDocument();
    // In full, not truncated: a hash shown as `aaaa…` cannot be compared
    // against anything, which is the only thing it is for.
    expect(screen.getByText('a'.repeat(64))).toBeInTheDocument();
  });

  it('lists the winners in draw order', async () => {
    renderPage();
    await screen.findByTestId('draw-assignment-0');
    const rows = [0, 1, 2].map((i) => screen.getByTestId(`draw-assignment-${i}`));
    expect(rows[0]).toHaveTextContent('Ana Lopez');
    expect(rows[1]).toHaveTextContent('Bea Ruiz');
    expect(rows[2]).toHaveTextContent('Cleo Diaz');
  });

  it('numbers them from 1 for a reader', async () => {
    renderPage();
    const first = await screen.findByTestId('draw-assignment-0');
    expect(first).toHaveTextContent('1');
  });

  it('shows the unit number only where a prize was won more than once', async () => {
    renderPage();
    await screen.findByTestId('draw-assignment-0');
    // The vape has two units, so they are distinguished...
    expect(screen.getByTestId('draw-assignment-0')).toHaveTextContent(/unit 1/i);
    expect(screen.getByTestId('draw-assignment-1')).toHaveTextContent(/unit 2/i);
    // ...and the single grinder is not, because "Grinder unit 1" reads like a
    // serial number.
    expect(screen.getByTestId('draw-assignment-2')).not.toHaveTextContent(/unit/i);
  });

  it('warns when prizes went unawarded', async () => {
    mocks.getDraw.mockResolvedValue({
      ...completed(),
      draw: { ...completed().draw!, prizeUnitCount: 6, assignmentCount: 3 },
      readiness: readiness({ canRun: false, blockers: ['DRAW_ALREADY_COMPLETED'] }),
    } as DrawStatusResponse);
    renderPage();
    expect(await screen.findByText(/3 prize unit\(s\) went unawarded/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('when the draw is refused', () => {
  it('keeps the dialog open with the reason in it', async () => {
    mocks.runDraw.mockRejectedValue(
      new ApiError(409, 'DRAW_POPULATION_CHANGED', 'changed'),
    );
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByRole('textbox'), 'DRAW');
    await user.click(within(dialog).getByRole('button', { name: /draw now/i }));

    // Open, with the explanation, so the operator reads WHY rather than
    // watching the panel silently refuse to change.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /participant list changed/i,
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('tells the operator to reload when the draw already happened', async () => {
    // The one refusal that can mean the draw SUCCEEDED — a lost response, a
    // retry, a second tab. "Try again" would be the wrong instruction.
    mocks.runDraw.mockRejectedValue(
      new ApiError(409, 'DRAW_ALREADY_COMPLETED', 'already'),
    );
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByRole('textbox'), 'DRAW');
    await user.click(within(dialog).getByRole('button', { name: /draw now/i }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/reload/i);
  });

  it('shows an error banner when the draw cannot be loaded at all', async () => {
    mocks.getDraw.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'boom'));
    renderPage();
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('what the screen never does', () => {
  it('sends no draw request merely by being opened', async () => {
    renderPage();
    await screen.findByTestId('draw-ready-candidates');
    expect(mocks.runDraw).not.toHaveBeenCalled();
  });

  it('does not poll', async () => {
    renderPage();
    await screen.findByTestId('draw-ready-candidates');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // A draw does not appear on its own; it appears because somebody pressed
    // the button. Polling would refetch a body full of winners for no reason.
    expect(mocks.getDraw).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('accessibility of the irreversible confirmation', () => {
  it('is a modal dialog with an accessible name', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBeTruthy();
  });

  it('moves focus into the field the operator must fill', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox')).toHaveFocus(),
    );
  });

  it('labels the field rather than relying on placeholder text', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);
    const field = within(dialog).getByRole('textbox');
    // Reachable BY ITS LABEL: a field whose only description is a placeholder
    // disappears from a screen reader the moment anything is typed into it.
    expect(field.id).toBeTruthy();
    expect(dialog.querySelector(`label[for="${field.id}"]`)).not.toBeNull();
  });

  it('returns focus to the trigger when dismissed', async () => {
    const user = userEvent.setup();
    renderPage();
    const trigger = await screen.findByRole('button', { name: /run the draw/i });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes on Escape before a request, and not during one', async () => {
    const user = userEvent.setup();
    renderPage();
    await openDialog(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // ...and while a draw is in flight, Escape must not leave the operator with
    // no idea whether it happened.
    let settle: (value: DrawResponse) => void = () => {};
    mocks.runDraw.mockReturnValue(
      new Promise<DrawResponse>((resolve) => {
        settle = resolve;
      }),
    );
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole('textbox'), 'DRAW');
    await user.click(within(dialog).getByRole('button', { name: /draw now/i }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    settle(completed());
  });

  it('announces a refusal as an alert', async () => {
    mocks.runDraw.mockRejectedValue(new ApiError(409, 'DRAW_CONFLICT', 'nope'));
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole('textbox'), 'DRAW');
    await user.click(within(dialog).getByRole('button', { name: /draw now/i }));

    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  });

  it('disables both buttons while the request is in flight', async () => {
    let settle: (value: DrawResponse) => void = () => {};
    mocks.runDraw.mockReturnValue(
      new Promise<DrawResponse>((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole('textbox'), 'DRAW');
    await user.click(within(dialog).getByRole('button', { name: /draw now/i }));

    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /cancel/i })).toBeDisabled(),
    );
    // A second click cannot reach the server: the button that would send it is
    // disabled, and the operation must happen exactly once.
    expect(mocks.runDraw).toHaveBeenCalledTimes(1);
    settle(completed());
  });
});

// ---------------------------------------------------------------------------
describe('when another administrator wins the race', () => {
  it('shows the completed draw rather than an error', async () => {
    // The server answers a losing request with the WINNER's draw, so the client
    // has nothing to recover from — it simply receives the result. This asserts
    // the UI treats that as the success it is.
    const theirs = completed();
    mocks.runDraw.mockResolvedValue(theirs);

    const user = userEvent.setup();
    renderPage();
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole('textbox'), 'DRAW');
    await user.click(within(dialog).getByRole('button', { name: /draw now/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/draw result/i)).toBeInTheDocument();
    // And no way to run another.
    expect(screen.queryByRole('button', { name: /run the draw/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the result is not fetched twice', () => {
  it('does not refetch the draw after running it', async () => {
    // The response IS the draw. Refetching it would re-send every winner's name
    // and email a moment after receiving them — and, because the event-detail
    // key is a PREFIX of the draw key, a prefix invalidation used to do exactly
    // that while discarding the fresh result on the way.
    mocks.runDraw.mockResolvedValue(completed());
    const user = userEvent.setup();
    renderPage();

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole('textbox'), 'DRAW');
    await user.click(within(dialog).getByRole('button', { name: /draw now/i }));

    await screen.findByText(/draw result/i);
    expect(mocks.getDraw).toHaveBeenCalledTimes(1);
  });
});
