// Frontend behaviour of the form builder.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { queryKeys } from '../src/lib/queryKeys';
import { ApiError } from '../src/lib/api';
import type {
  EventFormDraft,
  EventFormDraftResponse,
  FormPreviewResponse,
  FormPublishValidationResponse,
  FormQuestion,
  FormStep,
} from '../shared/types';

const mocks = vi.hoisted(() => ({
  getFormDraft: vi.fn(),
  createFormDraft: vi.fn(),
  saveFormDraft: vi.fn(),
  previewFormDraft: vi.fn(),
  createFormStep: vi.fn(),
  updateFormStep: vi.fn(),
  deleteFormStep: vi.fn(),
  reorderFormSteps: vi.fn(),
  createFormQuestion: vi.fn(),
  updateFormQuestion: vi.fn(),
  deleteFormQuestion: vi.fn(),
  duplicateFormQuestion: vi.fn(),
  reorderFormQuestions: vi.fn(),
  createFormOption: vi.fn(),
  updateFormOption: vi.fn(),
  deleteFormOption: vi.fn(),
  reorderFormOptions: vi.fn(),
  validatePublishForm: vi.fn(),
  publishForm: vi.fn(),
  listFormVersions: vi.fn(),
  getFormVersion: vi.fn(),
  getPublishedForm: vi.fn(),
  me: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const { ManagerEventFormBuilderPage } = await import(
  '../src/routes/ManagerEventFormBuilderPage'
);
const { useCreateFormStep } = await import('../src/hooks/useFormDraft');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const STEP_A = '22222222-2222-4222-8222-222222222222';
const STEP_B = '33333333-3333-4333-8333-333333333333';
const QUESTION_A = '44444444-4444-4444-8444-444444444444';
const OPTION_A = '55555555-5555-4555-8555-555555555555';

function makeQuestion(overrides: Partial<FormQuestion> = {}): FormQuestion {
  return {
    id: QUESTION_A,
    ownerType: 'DRAFT',
    ownerId: 'draft-1',
    stepId: STEP_A,
    key: 'do_you_smoke',
    systemField: 'NONE',
    type: 'SHORT_TEXT',
    label: 'Do you smoke?',
    description: null,
    placeholder: null,
    required: false,
    active: true,
    exportable: true,
    sortOrder: 0,
    validation: null,
    options: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeStep(overrides: Partial<FormStep> = {}): FormStep {
  return {
    id: STEP_A,
    ownerType: 'DRAFT',
    ownerId: 'draft-1',
    title: 'About you',
    description: null,
    sortOrder: 0,
    questions: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDraft(steps: FormStep[], revision = 3): EventFormDraft {
  return {
    id: 'draft-1',
    eventId: EVENT_ID,
    revision,
    steps,
    updatedBy: 'admin-1',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
  };
}

function draftResponse(
  steps: FormStep[] | null,
  overrides: Partial<EventFormDraftResponse> = {},
): EventFormDraftResponse {
  return {
    publishedVersionNumber: null,
    publishedVersionId: null,
    publishedAt: null,
    hasUnpublishedChanges: steps !== null,
    draft: steps === null ? null : makeDraft(steps),
    eventStatus: 'DRAFT',
    editable: true,
    availableSystemFields: ['FIRST_NAME', 'EMAIL'],
    ...overrides,
  };
}

function renderPage(ui: ReactNode = <ManagerEventFormBuilderPage />) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={[`/manager/events/${EVENT_ID}/form`]}>
          <Routes>
            <Route path="/manager/events/:eventId/form" element={ui} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.me.mockResolvedValue({ admin: { id: 'admin-1' } });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
describe('loading and layout', () => {
  it('shows the three panels once the draft arrives', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    renderPage();

    expect(await screen.findByText('Steps')).toBeInTheDocument();
    expect(screen.getByText('Properties')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add step/i })).toBeInTheDocument();
    // The canvas shows the first step's questions without being asked.
    expect(screen.getByText('Do you smoke?')).toBeInTheDocument();
  });

  it('reports a failed load instead of rendering an empty builder', async () => {
    mocks.getFormDraft.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'boom'));
    renderPage();
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('renders read-only once the event has closed', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })], {
        editable: false,
        eventStatus: 'CLOSED',
      }),
    );
    renderPage();

    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save draft/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /add step/i })).toBeDisabled();
  });

  it('shows an empty state rather than a dead canvas when there are no steps', async () => {
    mocks.getFormDraft.mockResolvedValue(draftResponse([]));
    renderPage();
    expect(await screen.findByText(/no steps yet/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('creating the form', () => {
  it('asks before bringing one into existence, and never on a page visit', async () => {
    mocks.getFormDraft.mockResolvedValue(draftResponse(null));
    mocks.createFormDraft.mockResolvedValue(draftResponse([]));
    const user = userEvent.setup();
    renderPage();

    // Visiting the builder created nothing.
    expect(await screen.findByText(/no registration form yet/i)).toBeInTheDocument();
    expect(mocks.createFormDraft).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /create the form/i }));
    await waitFor(() => expect(mocks.createFormDraft).toHaveBeenCalledWith(EVENT_ID));
    expect(await screen.findByText('Steps')).toBeInTheDocument();
  });

  it('does not offer creation once the event has closed', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse(null, { editable: false, eventStatus: 'CLOSED' }),
    );
    renderPage();

    expect(await screen.findByRole('button', { name: /create the form/i })).toBeDisabled();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('steps', () => {
  it('creates one, sending the revision it loaded with', async () => {
    mocks.getFormDraft.mockResolvedValue(draftResponse([makeStep()]));
    mocks.createFormStep.mockResolvedValue({ draft: makeDraft([makeStep()], 4) });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add step/i }));
    await user.type(screen.getByLabelText(/^step title$/i), 'Contact details');
    await user.click(screen.getByRole('button', { name: /^add step$/i }));

    await waitFor(() =>
      expect(mocks.createFormStep).toHaveBeenCalledWith(EVENT_ID, {
        expectedRevision: 3,
        title: 'Contact details',
      }),
    );
  });

  it('offers move buttons, not drag alone', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep(), makeStep({ id: STEP_B, title: 'Second', sortOrder: 1 })]),
    );
    mocks.reorderFormSteps.mockResolvedValue({ draft: makeDraft([], 4) });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('About you');
    const down = screen.getAllByRole('button', { name: /move down/i });
    await user.click(down[0]);

    await waitFor(() =>
      expect(mocks.reorderFormSteps).toHaveBeenCalledWith(EVENT_ID, 3, [
        { id: STEP_B, sortOrder: 0 },
        { id: STEP_A, sortOrder: 1 },
      ]),
    );
  });

  it('refuses to offer deletion for a step that still holds questions', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('About you'));
    expect(screen.getByRole('button', { name: /delete step/i })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
describe('questions', () => {
  it('adds one from a type and a label, with no JSON in sight', async () => {
    mocks.getFormDraft.mockResolvedValue(draftResponse([makeStep()]));
    mocks.createFormQuestion.mockResolvedValue({ draft: makeDraft([makeStep()], 4) });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('About you');
    await user.selectOptions(screen.getByLabelText(/^type$/i), 'SINGLE_SELECT');
    await user.type(screen.getByLabelText(/^label$/i), 'Do you drink?');
    await user.click(screen.getByRole('button', { name: /add question/i }));

    await waitFor(() =>
      expect(mocks.createFormQuestion).toHaveBeenCalledWith(EVENT_ID, {
        expectedRevision: 3,
        stepId: STEP_A,
        type: 'SINGLE_SELECT',
        label: 'Do you drink?',
      }),
    );
  });

  it('places a standard field with its pinned type and marker', async () => {
    mocks.getFormDraft.mockResolvedValue(draftResponse([makeStep()]));
    mocks.createFormQuestion.mockResolvedValue({ draft: makeDraft([makeStep()], 4) });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('About you');
    await user.click(screen.getByRole('button', { name: /\+ Email/i }));

    await waitFor(() =>
      expect(mocks.createFormQuestion).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({
          systemField: 'EMAIL',
          type: 'EMAIL',
          required: true,
          stepId: STEP_A,
        }),
      ),
    );
  });

  it('duplicates and deletes through the canvas', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    // The answer keeps the question: the cache is replaced wholesale, so a
    // fixture that dropped it would just be testing the fixture.
    mocks.duplicateFormQuestion.mockResolvedValue({
      draft: makeDraft([makeStep({ questions: [makeQuestion()] })], 4),
    });
    mocks.deleteFormQuestion.mockResolvedValue({ draft: makeDraft([makeStep()], 5) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /duplicate question/i }));
    await waitFor(() =>
      expect(mocks.duplicateFormQuestion).toHaveBeenCalledWith(EVENT_ID, QUESTION_A, 3),
    );

    // The delete carries the revision the duplicate left behind, not the one
    // the page loaded with: every answer replaces the whole draft.
    await user.click(screen.getByRole('button', { name: /delete question/i }));
    await waitFor(() =>
      expect(mocks.deleteFormQuestion).toHaveBeenCalledWith(EVENT_ID, QUESTION_A, 4),
    );
  });

  it('refuses to delete a required standard field, without calling the server', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([
        makeStep({
          questions: [makeQuestion({ systemField: 'EMAIL', type: 'EMAIL', required: true })],
        }),
      ]),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /delete question/i }));
    expect(mocks.deleteFormQuestion).not.toHaveBeenCalled();
    expect(await screen.findByText(/not allowed on a standard field/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('the properties panel', () => {
  it('prompts until a question is selected', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(/select a question to edit it/i)).toBeInTheDocument();
    await user.click(screen.getByText('Do you smoke?'));
    expect(await screen.findByLabelText(/answer key/i)).toHaveValue('do_you_smoke');
  });

  it('commits an edit on blur, not on every keystroke', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    mocks.updateFormQuestion.mockResolvedValue({ draft: makeDraft([], 4) });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Do you smoke?'));
    const label = await screen.findByLabelText(/^label$/i, { selector: '#question-label' });
    await user.clear(label);
    await user.type(label, 'Do you smoke daily?');
    expect(mocks.updateFormQuestion).not.toHaveBeenCalled();

    await user.tab();
    await waitFor(() =>
      expect(mocks.updateFormQuestion).toHaveBeenCalledWith(EVENT_ID, QUESTION_A, {
        expectedRevision: 3,
        label: 'Do you smoke daily?',
      }),
    );
  });

  it('locks the identity of a standard field but not its wording', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([
        makeStep({
          questions: [makeQuestion({ systemField: 'EMAIL', type: 'EMAIL', key: 'email' })],
        }),
      ]),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Do you smoke?'));
    expect(await screen.findByLabelText(/answer key/i)).toBeDisabled();
    expect(screen.getByLabelText(/^label$/i, { selector: '#question-label' })).not.toBeDisabled();
    expect(screen.getByText(/standard field: email/i)).toBeInTheDocument();
  });

  it('offers only the validation a type understands', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([
        makeStep({ questions: [makeQuestion({ type: 'NUMBER', label: 'How many?' })] }),
      ]),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('How many?'));
    expect(await screen.findByLabelText(/^minimum$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/minimum length/i)).not.toBeInTheDocument();
  });

  it('moves a question to another step from the panel', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([
        makeStep({ questions: [makeQuestion()] }),
        makeStep({ id: STEP_B, title: 'Second', sortOrder: 1 }),
      ]),
    );
    mocks.updateFormQuestion.mockResolvedValue({ draft: makeDraft([], 4) });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Do you smoke?'));
    await user.selectOptions(await screen.findByLabelText(/^step$/i), STEP_B);

    await waitFor(() =>
      expect(mocks.updateFormQuestion).toHaveBeenCalledWith(EVENT_ID, QUESTION_A, {
        expectedRevision: 3,
        stepId: STEP_B,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
describe('options', () => {
  const selectQuestion = makeQuestion({
    type: 'SINGLE_SELECT',
    label: 'Pick one',
    options: [
      {
        id: OPTION_A,
        questionId: QUESTION_A,
        value: 'yes',
        label: 'Yes',
        sortOrder: 0,
        active: true,
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    ],
  });

  it('adds one, deriving the stored value from the label', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [selectQuestion] })]),
    );
    mocks.createFormOption.mockResolvedValue({ draft: makeDraft([], 4) });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Pick one'));
    await user.type(await screen.findByLabelText(/new option label/i), 'No thanks');
    await user.click(screen.getByRole('button', { name: /add option/i }));

    await waitFor(() =>
      expect(mocks.createFormOption).toHaveBeenCalledWith(EVENT_ID, QUESTION_A, {
        expectedRevision: 3,
        value: 'no-thanks',
        label: 'No thanks',
      }),
    );
  });

  it('warns when a choice question has no choices', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([
        makeStep({ questions: [{ ...selectQuestion, options: [] }] }),
      ]),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Pick one'));
    expect(await screen.findByText(/needs at least one option/i)).toBeInTheDocument();
  });

  it('hides the option editor for a type that takes none', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Do you smoke?'));
    await screen.findByLabelText(/answer key/i);
    expect(screen.queryByRole('button', { name: /add option/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('preview', () => {
  const preview: FormPreviewResponse = {
    eventId: EVENT_ID,
    revision: 3,
    steps: [
      {
        id: STEP_A,
        title: 'About you',
        description: null,
        questions: [
          {
            id: QUESTION_A,
            key: 'do_you_smoke',
            type: 'SINGLE_SELECT',
            label: 'Do you smoke?',
            description: null,
            placeholder: null,
            required: true,
            validation: null,
            options: [{ value: 'yes', label: 'Yes' }],
          },
        ],
      },
    ],
    problems: [],
  };

  it('renders the form as a participant would meet it, with nothing enabled', async () => {
    mocks.getFormDraft.mockResolvedValue(draftResponse([makeStep()]));
    mocks.previewFormDraft.mockResolvedValue(preview);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /preview/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Step 1 of 1')).toBeInTheDocument();
    expect(within(dialog).getByText('Do you smoke?')).toBeInTheDocument();
    // Nothing here can be filled in: this phase stores no answers.
    expect(within(dialog).getByRole('radio')).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });

  it('lists the problems publishing will refuse', async () => {
    mocks.getFormDraft.mockResolvedValue(draftResponse([makeStep()]));
    mocks.previewFormDraft.mockResolvedValue({
      ...preview,
      problems: [
        { code: 'SELECT_WITHOUT_OPTIONS', stepId: STEP_A, questionId: QUESTION_A, detail: 'Pick' },
      ],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /preview/i }));
    expect(await screen.findByText(/no active options/i)).toBeInTheDocument();
  });

  it('closes on Escape and returns focus to what opened it', async () => {
    mocks.getFormDraft.mockResolvedValue(draftResponse([makeStep()]));
    mocks.previewFormDraft.mockResolvedValue(preview);
    const user = userEvent.setup();
    renderPage();

    const open = await screen.findByRole('button', { name: /preview/i });
    open.focus();
    await user.click(open);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(open);
  });
});

// ---------------------------------------------------------------------------
describe('out-of-order responses', () => {
  it('never lets a slow answer rewind the form to an older revision', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    queryClient.setQueryData(queryKeys.eventFormDraft(EVENT_ID), draftResponse([makeStep()]));

    const { result } = renderHook(() => useCreateFormStep(EVENT_ID), { wrapper });

    // The newer answer lands first...
    mocks.createFormStep.mockResolvedValueOnce({
      draft: makeDraft([makeStep(), makeStep({ id: STEP_B })], 5),
    });
    await result.current.mutateAsync({ expectedRevision: 3, title: 'Second' });
    expect(
      queryClient.getQueryData<EventFormDraftResponse>(queryKeys.eventFormDraft(EVENT_ID))?.draft
        ?.revision,
    ).toBe(5);

    // ...and a slower request, issued earlier, answers afterwards with an
    // older revision. It must be dropped, not applied.
    mocks.createFormStep.mockResolvedValueOnce({ draft: makeDraft([makeStep()], 4) });
    await result.current.mutateAsync({ expectedRevision: 3, title: 'First' });

    const cached = queryClient.getQueryData<EventFormDraftResponse>(
      queryKeys.eventFormDraft(EVENT_ID),
    );
    expect(cached?.draft?.revision).toBe(5);
    expect(cached?.draft?.steps).toHaveLength(2);
  });

  it('refreshing the event detail does not discard the draft that was just saved', async () => {
    // The detail key is a PREFIX of the draft key; a non-exact invalidation
    // would refetch the draft and undo the answer that had just arrived.
    mocks.getFormDraft.mockResolvedValue(draftResponse([makeStep()]));
    mocks.createFormStep.mockResolvedValue({
      draft: makeDraft([makeStep(), makeStep({ id: STEP_B, title: 'Second' })], 4),
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add step/i }));
    await user.type(screen.getByLabelText(/^step title$/i), 'Second');
    await user.click(screen.getByRole('button', { name: /^add step$/i }));

    expect(await screen.findByText('Second')).toBeInTheDocument();
    // The read was made once, on mount: the mutation did not trigger another.
    expect(mocks.getFormDraft).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('publishing', () => {
  const READY: FormPublishValidationResponse = {
    publishable: true,
    errors: [],
    warnings: [],
    draftRevision: 3,
    publishedVersionNumber: null,
    hasUnpublishedChanges: true,
  };

  function published(overrides: Partial<EventFormDraftResponse> = {}) {
    return draftResponse([makeStep({ questions: [makeQuestion()] })], {
      publishedVersionNumber: 2,
      publishedVersionId: 'version-2',
      publishedAt: '2026-05-03T00:00:00.000Z',
      hasUnpublishedChanges: false,
      ...overrides,
    });
  }

  it('shows what is published and whether anything is waiting', async () => {
    mocks.getFormDraft.mockResolvedValue(published());
    renderPage();
    expect(await screen.findByText('Published v2')).toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    expect(screen.queryByText('Unpublished changes')).not.toBeInTheDocument();
  });

  it('says so when the draft has moved past the published version', async () => {
    mocks.getFormDraft.mockResolvedValue(published({ hasUnpublishedChanges: true }));
    renderPage();
    expect(await screen.findByText('Unpublished changes')).toBeInTheDocument();
  });

  it('says "not published" until there is a version', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    renderPage();
    expect(await screen.findByText('Not published')).toBeInTheDocument();
  });

  it('validates before asking, and never publishes optimistically', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    mocks.validatePublishForm.mockResolvedValue(READY);
    mocks.publishForm.mockResolvedValue({
      version: { id: 'v1', versionNumber: 1 },
      draft: makeDraft([makeStep()], 3),
      eventId: EVENT_ID,
      publishedVersionId: 'v1',
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /^publish$/i }));
    await waitFor(() => expect(mocks.validatePublishForm).toHaveBeenCalledWith(EVENT_ID, 3));
    // Nothing is published until the operator confirms.
    expect(mocks.publishForm).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/can never be changed/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /publish version 1/i }));
    await waitFor(() => expect(mocks.publishForm).toHaveBeenCalledWith(EVENT_ID, 3));
  });

  it('lists what is wrong and refuses to offer the button', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    mocks.validatePublishForm.mockResolvedValue({
      ...READY,
      publishable: false,
      errors: [
        { code: 'MISSING_SYSTEM_FIELD', subject: 'EMAIL' },
        { code: 'EMPTY_STEP', stepId: STEP_B, subject: 'Second' },
      ],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /^publish$/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/required standard field is missing/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/step has no questions/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /publish version/i })).toBeDisabled();
  });

  it('walks the builder to the issue that needs fixing', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([
        makeStep({ questions: [makeQuestion()] }),
        makeStep({ id: STEP_B, title: 'Second', sortOrder: 1 }),
      ]),
    );
    mocks.validatePublishForm.mockResolvedValue({
      ...READY,
      publishable: false,
      errors: [{ code: 'EMPTY_STEP', stepId: STEP_B, subject: 'Second' }],
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /^publish$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /go to issue/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The canvas is now showing the offending step.
    expect(await screen.findByText(/this step has no questions/i)).toBeInTheDocument();
  });

  it('never publishes over a save that is still in flight', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    // A save that never settles keeps the mutation pending.
    mocks.createFormStep.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add step/i }));
    await user.type(screen.getByLabelText(/^step title$/i), 'Slow');
    await user.click(screen.getByRole('button', { name: /^add step$/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^publish$/i })).toBeDisabled(),
    );
    expect(await screen.findByText(/waiting for your last change to save/i)).toBeInTheDocument();
  });

  it('surfaces a revision conflict from the publish itself', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    mocks.validatePublishForm.mockResolvedValue(READY);
    mocks.publishForm.mockRejectedValue(
      new ApiError(409, 'FORM_DRAFT_REVISION_CONFLICT', 'stale'),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /^publish$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /publish version 1/i }));

    expect(
      await within(dialog).findByText(/changed since you reviewed it/i),
    ).toBeInTheDocument();
    // The dialog stays open so the operator can reload and retry.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('version history', () => {
  it('lists versions and opens one read-only', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })], {
        publishedVersionNumber: 1,
        publishedVersionId: 'v1',
        publishedAt: '2026-05-03T00:00:00.000Z',
        hasUnpublishedChanges: false,
      }),
    );
    mocks.listFormVersions.mockResolvedValue({
      currentVersionId: 'v1',
      items: [
        {
          id: 'v1',
          versionNumber: 1,
          sourceDraftRevision: 3,
          publishedBy: 'admin-1',
          publishedByName: 'Ada Lovelace',
          publishedAt: '2026-05-03T00:00:00.000Z',
          currentPublished: true,
          stepCount: 1,
          questionCount: 1,
        },
      ],
    });
    mocks.getFormVersion.mockResolvedValue({
      currentPublished: true,
      snapshot: { snapshotVersion: 1 },
      version: {
        id: 'v1',
        eventId: EVENT_ID,
        versionNumber: 1,
        sourceDraftRevision: 3,
        publishedBy: 'admin-1',
        publishedAt: '2026-05-03T00:00:00.000Z',
        createdAt: '2026-05-03T00:00:00.000Z',
        steps: [makeStep({ questions: [makeQuestion()] })],
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /version history/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('v1')).toBeInTheDocument();
    expect(within(dialog).getByText('Current')).toBeInTheDocument();
    expect(within(dialog).getByText(/Ada Lovelace/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /^open$/i }));
    expect(await within(dialog).findByText(/published and read-only/i)).toBeInTheDocument();
    // A published version offers nothing that could change it.
    expect(
      within(dialog).queryByRole('button', { name: /move down/i }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: /delete question/i }),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /duplicate/i })).not.toBeInTheDocument();
  });

  it('says so when nothing has been published', async () => {
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    mocks.listFormVersions.mockResolvedValue({ items: [], currentVersionId: null });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /version history/i }));
    expect(await screen.findByText(/nothing has been published yet/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('conflicts and i18n', () => {
  it('surfaces a revision conflict instead of losing it', async () => {
    mocks.getFormDraft.mockResolvedValue(draftResponse([makeStep()]));
    mocks.createFormStep.mockRejectedValue(
      new ApiError(409, 'FORM_REVISION_CONFLICT', 'stale'),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add step/i }));
    await user.type(screen.getByLabelText(/^step title$/i), 'Doomed');
    await user.click(screen.getByRole('button', { name: /^add step$/i }));

    expect(await screen.findByText(/changed since you loaded it/i)).toBeInTheDocument();
  });

  it('translates to Spanish', async () => {
    localStorage.setItem('gg.locale', 'es');
    mocks.getFormDraft.mockResolvedValue(
      draftResponse([makeStep({ questions: [makeQuestion()] })]),
    );
    renderPage();

    expect(await screen.findByText('Pasos')).toBeInTheDocument();
    expect(screen.getByText('Propiedades')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /guardar borrador/i })).toBeInTheDocument();
  });
});
