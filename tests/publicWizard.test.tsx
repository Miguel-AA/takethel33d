// @vitest-environment jsdom
//
// The dynamic wizard: rendered entirely from a published VERSION.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { PublicFormWizard } from '../src/components/public/PublicFormWizard';
import { PublicSubmissionResult } from '../src/components/public/PublicSubmissionResult';
import { PublicPrizeList } from '../src/components/public/PublicPrizeList';
import type {
  PublicFormDTO,
  PublicFormStepDTO,
  PublicQuestionDTO,
} from '../shared/types';

afterEach(cleanup);

function question(overrides: Partial<PublicQuestionDTO> = {}): PublicQuestionDTO {
  return {
    id: 'q-text',
    key: 'nickname',
    systemField: 'NONE',
    type: 'SHORT_TEXT',
    label: 'Nickname',
    description: null,
    placeholder: null,
    required: false,
    sortOrder: 0,
    validation: null,
    options: [],
    ...overrides,
  };
}

function form(steps: PublicFormStepDTO[]): PublicFormDTO {
  return { versionNumber: 1, steps };
}

function step(questions: PublicQuestionDTO[], overrides: Partial<PublicFormStepDTO> = {}) {
  return {
    id: 's1',
    title: 'About you',
    description: null,
    sortOrder: 0,
    questions,
    ...overrides,
  };
}

function renderWizard(dto: PublicFormDTO, onSubmit = vi.fn()) {
  render(
    <I18nProvider>
      <PublicFormWizard
        form={dto}
        submitting={false}
        submissionError={null}
        onSubmit={onSubmit}
      />
    </I18nProvider>,
  );
  return onSubmit;
}

// ---------------------------------------------------------------------------

describe('every question type renders a usable control', () => {
  const cases: Array<[PublicQuestionDTO['type'], Partial<PublicQuestionDTO>]> = [
    ['SHORT_TEXT', {}],
    ['LONG_TEXT', {}],
    ['EMAIL', {}],
    ['PHONE', {}],
    ['DATE', {}],
    ['NUMBER', {}],
    ['YES_NO', {}],
    ['CONSENT', {}],
    [
      'SINGLE_SELECT',
      { options: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }] },
    ],
    [
      'MULTI_SELECT',
      { options: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }] },
    ],
    [
      'DROPDOWN',
      { options: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }] },
    ],
    ['INFORMATION', {}],
  ];

  for (const [type, extra] of cases) {
    it(`renders ${type}`, () => {
      renderWizard(form([step([question({ type, label: `A ${type} question`, ...extra })])]));
      expect(screen.getByText(`A ${type} question`)).toBeTruthy();
    });
  }

  it('renders INFORMATION as copy with no control', () => {
    renderWizard(
      form([
        step([
          question({ id: 'info', type: 'INFORMATION', label: 'Please read this' }),
          question({ id: 'real', type: 'SHORT_TEXT', label: 'Your answer' }),
        ]),
      ]),
    );

    const note = screen.getByRole('note');
    expect(within(note).getByText('Please read this')).toBeTruthy();
    // One control on the page, belonging to the other question.
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('the wire format', () => {
  it('sends a NUMBER as a number, not a string', async () => {
    const user = userEvent.setup();
    const onSubmit = renderWizard(
      form([step([question({ id: 'n', type: 'NUMBER', label: 'How many?' })])]),
    );

    await user.type(screen.getByLabelText(/How many/), '42');
    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'n', value: 42 }]);
  });

  it('sends YES_NO as a boolean', async () => {
    const user = userEvent.setup();
    const onSubmit = renderWizard(
      form([step([question({ id: 'yn', type: 'YES_NO', label: 'Agree?' })])]),
    );

    await user.click(screen.getByLabelText('Yes'));
    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'yn', value: true }]);
  });

  it('sends a DATE as a civil date, never a timestamp', async () => {
    const user = userEvent.setup();
    const onSubmit = renderWizard(
      form([step([question({ id: 'd', type: 'DATE', label: 'Date of birth' })])]),
    );

    await user.type(screen.getByLabelText(/Date of birth/), '2000-05-17');
    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'd', value: '2000-05-17' }]);
  });

  it('sends MULTI_SELECT as an array of option values with no duplicates', async () => {
    const user = userEvent.setup();
    const onSubmit = renderWizard(
      form([
        step([
          question({
            id: 'ms',
            type: 'MULTI_SELECT',
            label: 'Pick some',
            options: [
              { value: 'a', label: 'Option A' },
              { value: 'b', label: 'Option B' },
            ],
          }),
        ]),
      ]),
    );

    await user.click(screen.getByLabelText('Option A'));
    await user.click(screen.getByLabelText('Option B'));
    await user.click(screen.getByLabelText('Option A'));
    await user.click(screen.getByLabelText('Option A'));
    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'ms', value: ['b', 'a'] }]);
  });

  it('omits questions nobody answered', async () => {
    const user = userEvent.setup();
    const onSubmit = renderWizard(
      form([
        step([
          question({ id: 'a', label: 'Answered' }),
          question({ id: 'b', label: 'Skipped' }),
        ]),
      ]),
    );

    await user.type(screen.getByLabelText(/Answered/), 'value');
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // Sending a null for an unanswered optional question would claim it was
    // answered with nothing.
    expect(onSubmit).toHaveBeenCalledWith([{ questionId: 'a', value: 'value' }]);
  });
});

// ---------------------------------------------------------------------------

describe('navigation', () => {
  const twoSteps = form([
    step([question({ id: 'a', label: 'First answer', required: true })], {
      id: 's1',
      title: 'Step one',
    }),
    step([question({ id: 'b', label: 'Second answer' })], {
      id: 's2',
      title: 'Step two',
      sortOrder: 1,
    }),
  ]);

  it('shows the step position in words', () => {
    renderWizard(twoSteps);
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
  });

  it('exposes progress to assistive technology', () => {
    renderWizard(twoSteps);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('2');
  });

  it('refuses to advance while the current step is invalid', async () => {
    const user = userEvent.setup();
    renderWizard(twoSteps);

    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('moves focus to the first invalid field', async () => {
    const user = userEvent.setup();
    renderWizard(twoSteps);

    await user.click(screen.getByRole('button', { name: /continue/i }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(document.activeElement).toBe(screen.getByLabelText(/First answer/));
  });

  it('advances once the step is valid and keeps answers on the way back', async () => {
    const user = userEvent.setup();
    renderWizard(twoSteps);

    await user.type(screen.getByLabelText(/First answer/), 'Ana');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('Step 2 of 2')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /back/i }));
    // Going back to check something must not cost the work.
    expect((screen.getByLabelText(/First answer/) as HTMLInputElement).value).toBe('Ana');
  });

  it('offers submit only on the last step', async () => {
    const user = userEvent.setup();
    renderWizard(twoSteps);

    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull();
    await user.type(screen.getByLabelText(/First answer/), 'Ana');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('button', { name: /submit/i })).toBeTruthy();
  });

  it('returns to the offending step when the whole form fails on submit', async () => {
    const user = userEvent.setup();
    const onSubmit = renderWizard(
      form([
        step([question({ id: 'a', label: 'First answer' })], { id: 's1', title: 'One' }),
        step([question({ id: 'b', label: 'Second answer' })], {
          id: 's2',
          title: 'Two',
          sortOrder: 1,
        }),
      ]),
    );

    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByLabelText(/Second answer/), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('validation reuses the shared rules', () => {
  it('rejects a malformed email with the shared problem code', async () => {
    const user = userEvent.setup();
    const onSubmit = renderWizard(
      form([step([question({ id: 'e', type: 'EMAIL', label: 'Email', required: true })])]),
    );

    await user.type(screen.getByLabelText(/Email/), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
  });

  it('marks a required field as invalid for assistive technology', async () => {
    const user = userEvent.setup();
    renderWizard(
      form([step([question({ id: 'r', label: 'Your name', required: true })])]),
    );

    await user.click(screen.getByRole('button', { name: /submit/i }));

    const input = screen.getByLabelText(/Your name/);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      'This field is required.',
    );
  });

  it('clears the message as soon as the field is corrected', async () => {
    const user = userEvent.setup();
    renderWizard(
      form([step([question({ id: 'r', label: 'Your name', required: true })])]),
    );

    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(screen.getByText('This field is required.')).toBeTruthy();

    await user.type(screen.getByLabelText(/Your name/), 'A');
    expect(screen.queryByText('This field is required.')).toBeNull();
  });

  it('requires a CONSENT question to be ticked', async () => {
    const user = userEvent.setup();
    const onSubmit = renderWizard(
      form([
        step([question({ id: 'c', type: 'CONSENT', label: 'I agree', required: true })]),
      ]),
    );

    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('You must agree to continue.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('accessibility of grouped controls', () => {
  it('wraps a select group in a fieldset with a legend', () => {
    renderWizard(
      form([
        step([
          question({
            id: 'ss',
            type: 'SINGLE_SELECT',
            label: 'Do you smoke?',
            options: [
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ],
          }),
        ]),
      ]),
    );

    const group = screen.getByRole('group', { name: /Do you smoke/ });
    expect(within(group).getByLabelText('Yes')).toBeTruthy();
    expect(within(group).getByLabelText('No')).toBeTruthy();
  });

  it('gives every option its own id so its label points somewhere', () => {
    renderWizard(
      form([
        step([
          question({
            id: 'ss',
            type: 'SINGLE_SELECT',
            label: 'Pick',
            options: [{ value: 'a', label: 'Option A' }],
          }),
        ]),
      ]),
    );

    const option = screen.getByLabelText('Option A') as HTMLInputElement;
    expect(option.id).toBe('q-ss-a');
  });

  it('sets autocomplete from the system field, not the label', () => {
    renderWizard(
      form([
        step([
          question({ id: 'f', systemField: 'FIRST_NAME', label: 'Nombre' }),
          question({ id: 'l', systemField: 'LAST_NAME', label: 'Apellido' }),
          question({ id: 'e', systemField: 'EMAIL', type: 'EMAIL', label: 'Correo' }),
          question({ id: 'p', systemField: 'PHONE', type: 'PHONE', label: 'Teléfono' }),
          question({ id: 'd', systemField: 'DATE_OF_BIRTH', type: 'DATE', label: 'Nacimiento' }),
        ]),
      ]),
    );

    // Labels are operator free text in any language; the system field is the
    // only reliable signal.
    expect(screen.getByLabelText('Nombre').getAttribute('autocomplete')).toBe('given-name');
    expect(screen.getByLabelText('Apellido').getAttribute('autocomplete')).toBe('family-name');
    expect(screen.getByLabelText('Correo').getAttribute('autocomplete')).toBe('email');
    expect(screen.getByLabelText('Teléfono').getAttribute('autocomplete')).toBe('tel');
    expect(screen.getByLabelText('Nacimiento').getAttribute('autocomplete')).toBe('bday');
  });

  it('does not announce a consent label twice', () => {
    renderWizard(
      form([
        step([
          question({
            id: 'c',
            type: 'CONSENT',
            label: 'I agree to the terms',
            required: true,
          }),
        ]),
      ]),
    );
    expect(screen.getAllByText('I agree to the terms')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('nothing personal is persisted to the browser', () => {
  it('writes no answers to localStorage', async () => {
    const user = userEvent.setup();
    renderWizard(
      form([step([question({ id: 'e', type: 'EMAIL', label: 'Email' })])]),
    );

    await user.type(screen.getByLabelText(/Email/), 'private@example.com');

    const dump = JSON.stringify({ ...localStorage });
    expect(dump).not.toContain('private@example.com');
  });
});

// ---------------------------------------------------------------------------

describe('the result screen', () => {
  it('shows the operator’s configured copy when there is any', () => {
    render(
      <I18nProvider>
        <PublicSubmissionResult
          result={{
            result: 'ELIGIBLE',
            reason: null,
            message: { title: 'You are in', body: 'Good luck' },
          }}
        />
      </I18nProvider>,
    );
    expect(screen.getByText('You are in')).toBeTruthy();
    expect(screen.getByText('Good luck')).toBeTruthy();
  });

  it('falls back to translated copy when the operator left it empty', () => {
    render(
      <I18nProvider>
        <PublicSubmissionResult
          result={{ result: 'ELIGIBLE', reason: null, message: { title: '', body: '' } }}
        />
      </I18nProvider>,
    );
    expect(screen.getByText('You are entered')).toBeTruthy();
  });

  it('explains an ineligible outcome without revealing an age', () => {
    render(
      <I18nProvider>
        <PublicSubmissionResult
          result={{
            result: 'INELIGIBLE',
            reason: 'AGE_REQUIREMENT_NOT_MET',
            message: { title: '', body: '' },
          }}
        />
      </I18nProvider>,
    );

    expect(screen.getByText('This event has a minimum age requirement.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b\d{1,3} years old\b/);
  });

  it('renders an unrecognised reason as nothing rather than a raw code', () => {
    render(
      <I18nProvider>
        <PublicSubmissionResult
          result={{
            result: 'INELIGIBLE',
            reason: 'DISQUALIFIED_BY_RULE',
            message: { title: 'No', body: 'Sorry' },
          }}
        />
      </I18nProvider>,
    );
    expect(document.body.textContent).not.toContain('DISQUALIFIED_BY_RULE');
  });
});

// ---------------------------------------------------------------------------

describe('prizes', () => {
  it('renders nothing at all when there are none', () => {
    const { container } = render(
      <I18nProvider>
        <PublicPrizeList prizes={[]} />
      </I18nProvider>,
    );
    expect(container.textContent).toBe('');
  });

  it('shows name, description and quantity', () => {
    render(
      <I18nProvider>
        <PublicPrizeList
          prizes={[
            {
              name: 'A bike',
              description: 'Blue',
              imageUrl: null,
              quantity: 3,
              sortOrder: 0,
            },
          ]}
        />
      </I18nProvider>,
    );
    expect(screen.getByText('A bike')).toBeTruthy();
    expect(screen.getByText('Blue')).toBeTruthy();
    expect(screen.getByText('3 available')).toBeTruthy();
  });

  it('renders operator text as text, never as markup', () => {
    render(
      <I18nProvider>
        <PublicPrizeList
          prizes={[
            {
              name: '<script>alert(1)</script>',
              description: null,
              imageUrl: null,
              quantity: 1,
              sortOrder: 0,
            },
          ]}
        />
      </I18nProvider>,
    );

    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
  });
});
