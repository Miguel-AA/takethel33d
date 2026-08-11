import { useTranslation } from '../../i18n/I18nProvider';
import type { PublicQuestionDTO } from '@shared/types';
import type { AnswerValue } from '@shared/formAnswers';

/**
 * One question, rendered from configuration.
 *
 * NOTHING HERE KNOWS ANY PARTICULAR QUESTION. There is no `smoker_status`, no
 * `drinker_status` and no branch on any key: the switch is over the twelve
 * TYPES the form builder can produce, and a client adding a question tomorrow
 * gets a working input without a deploy.
 *
 * This is a sibling of `FormPreview`, not a replacement for it. Preview renders
 * the DRAFT with every control disabled, for an operator checking their work;
 * this collects real answers from a real participant. Making one component do
 * both would mean a component whose every control is conditionally interactive
 * — and the administrative one is certified.
 *
 * ACCESSIBILITY IS PART OF THE CONTRACT, not a later pass:
 *   * grouped controls are a `fieldset` with a `legend`, so a screen reader
 *     announces the question before the options rather than reading five
 *     unattached radio labels;
 *   * every option has its own `id`, so its `<label htmlFor>` actually points
 *     somewhere — the preview's labels do not, which is fine for a disabled
 *     mockup and not for an input somebody must click;
 *   * an invalid field carries `aria-invalid` and an `aria-describedby` that
 *     names its error, so the message is announced when focus lands on it.
 */

export interface QuestionRendererProps {
  question: PublicQuestionDTO;
  value: AnswerValue | null;
  error: string | null;
  onChange: (value: AnswerValue | null) => void;
  /** Set on the first invalid control so navigation can focus it. */
  inputRef?: (element: HTMLElement | null) => void;
}

export function PublicQuestionRenderer(props: QuestionRendererProps) {
  const { question } = props;

  // Collects nothing, so it is copy rather than a control. `role="note"` gives
  // it a landmark a screen reader can reach instead of it being loose text.
  if (question.type === 'INFORMATION') {
    return (
      <div className="rounded-lg bg-slate-900/5 p-4" role="note">
        <p className="font-medium text-slate-900">{question.label}</p>
        {question.description && (
          <p className="mt-1 text-sm text-slate-600">{question.description}</p>
        )}
      </div>
    );
  }

  // A consent box labels ITSELF: the text a person is agreeing to is the label
  // of the checkbox, not a heading above it. Rendering both — as the admin
  // preview does — makes a screen reader announce the same sentence twice.
  if (question.type === 'CONSENT') return <ConsentField {...props} />;

  const grouped =
    question.type === 'YES_NO' ||
    question.type === 'SINGLE_SELECT' ||
    question.type === 'MULTI_SELECT';

  // A group's label must be a `legend` inside a `fieldset`; a single control's
  // must be a `label` bound to it. Using the wrong one silently breaks the
  // association a screen reader relies on.
  //
  // Optional fields carry no "(optional)" suffix: the required ones are marked,
  // and adding a word to every other label makes the form louder without
  // telling anybody anything the asterisks do not.
  return grouped ? <GroupedField {...props} /> : <SingleField {...props} />;
}

function ConsentField({ question, value, error, onChange, inputRef }: QuestionRendererProps) {
  const { t } = useTranslation();
  const id = `q-${question.id}`;
  const errorId = `${id}-error`;

  return (
    <div>
      <label className="flex items-start gap-3 text-sm text-slate-700" htmlFor={id}>
        <input
          id={id}
          ref={inputRef as never}
          type="checkbox"
          className="mt-0.5 h-5 w-5 shrink-0"
          checked={value === true}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => onChange(e.target.checked ? true : null)}
        />
        <span>
          {question.label}
          {question.required && (
            <span className="ml-1 text-red-600" aria-label={t('public.form.required')}>
              *
            </span>
          )}
        </span>
      </label>
      {question.description && (
        <p className="mt-1 pl-8 text-xs text-slate-500">{question.description}</p>
      )}
      <ErrorText id={errorId} error={error} />
    </div>
  );
}

function ErrorText({ id, error }: { id: string; error: string | null }) {
  if (!error) return null;
  return (
    <p id={id} className="mt-1 text-sm text-red-700" role="alert">
      {error}
    </p>
  );
}

function SingleField({
  question,
  value,
  error,
  onChange,
  inputRef,
}: QuestionRendererProps) {
  const { t } = useTranslation();
  const id = `q-${question.id}`;
  const errorId = `${id}-error`;
  const describedBy = [question.description ? `${id}-hint` : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  const common = {
    id,
    className: 'input h-12 rounded-lg',
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
    required: question.required,
  } as const;

  return (
    <div>
      <label className="label" htmlFor={id}>
        {question.label}
        {question.required && (
          <span className="ml-1 text-red-600" aria-label={t('public.form.required')}>
            *
          </span>
        )}
      </label>
      {question.description && (
        <p id={`${id}-hint`} className="mb-1 text-xs text-slate-500">
          {question.description}
        </p>
      )}

      {question.type === 'LONG_TEXT' ? (
        <textarea
          {...common}
          ref={inputRef as never}
          className="input rounded-lg"
          rows={4}
          maxLength={question.validation?.maxLength}
          placeholder={question.placeholder ?? undefined}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        />
      ) : question.type === 'DROPDOWN' ? (
        <select
          {...common}
          ref={inputRef as never}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">{question.placeholder ?? t('public.form.choose')}</option>
          {question.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...common}
          ref={inputRef as never}
          type={inputTypeFor(question)}
          inputMode={inputModeFor(question)}
          autoComplete={autoCompleteFor(question)}
          placeholder={question.placeholder ?? undefined}
          maxLength={question.validation?.maxLength}
          min={question.type === 'NUMBER' ? question.validation?.min : undefined}
          max={question.type === 'NUMBER' ? question.validation?.max : undefined}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => onChange(coerce(question, e.target.value))}
        />
      )}

      <ErrorText id={errorId} error={error} />
    </div>
  );
}

function GroupedField({ question, value, error, onChange, inputRef }: QuestionRendererProps) {
  const { t } = useTranslation();
  const id = `q-${question.id}`;
  const errorId = `${id}-error`;

  const options =
    question.type === 'YES_NO'
      ? [
          { value: 'true', label: t('public.form.yes') },
          { value: 'false', label: t('public.form.no') },
        ]
      : question.options;

  const selected = Array.isArray(value) ? value : [];
  const multi = question.type === 'MULTI_SELECT';

  return (
    <fieldset
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="label">
        {question.label}
        {question.required && (
          <span className="ml-1 text-red-600" aria-label={t('public.form.required')}>
            *
          </span>
        )}
      </legend>
      {question.description && (
        <p className="mb-2 text-xs text-slate-500">{question.description}</p>
      )}

      <div className="space-y-2">
        {options.map((option, index) => {
          const optionId = `${id}-${option.value}`;
          const checked = multi
            ? selected.includes(option.value)
            : question.type === 'YES_NO'
              ? String(value) === option.value
              : value === option.value;

          return (
            <div key={option.value} className="flex items-center gap-3">
              <input
                id={optionId}
                // Only the FIRST control of a group takes the focus ref: focus
                // belongs on the group's entry point, not its last option.
                ref={index === 0 ? (inputRef as never) : undefined}
                type={multi ? 'checkbox' : 'radio'}
                name={id}
                className="h-5 w-5"
                checked={checked}
                onChange={(e) => {
                  if (multi) {
                    const next = e.target.checked
                      ? [...selected, option.value]
                      : selected.filter((item) => item !== option.value);
                    onChange(next.length > 0 ? next : null);
                  } else if (question.type === 'YES_NO') {
                    onChange(option.value === 'true');
                  } else {
                    onChange(option.value);
                  }
                }}
              />
              <label className="text-sm text-slate-700" htmlFor={optionId}>
                {option.label}
              </label>
            </div>
          );
        })}
      </div>

      <ErrorText id={errorId} error={error} />
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

function inputTypeFor(question: PublicQuestionDTO): string {
  switch (question.type) {
    case 'EMAIL':
      return 'email';
    case 'PHONE':
      return 'tel';
    // A civil date, submitted as `YYYY-MM-DD` — which is exactly what a native
    // date input's `value` already is. No `Date` is constructed anywhere near
    // it, so no timezone can shift somebody's birthday by a day.
    case 'DATE':
      return 'date';
    case 'NUMBER':
      return 'number';
    default:
      return 'text';
  }
}

function inputModeFor(question: PublicQuestionDTO) {
  if (question.type === 'NUMBER') return 'numeric' as const;
  if (question.type === 'PHONE') return 'tel' as const;
  if (question.type === 'EMAIL') return 'email' as const;
  return undefined;
}

/**
 * Autofill hints, driven by the SYSTEM FIELD rather than the label.
 *
 * The label is operator-written free text in any language; the system field is
 * the form builder's own vocabulary and is the only reliable signal that this
 * box wants a surname.
 */
function autoCompleteFor(question: PublicQuestionDTO): string | undefined {
  switch (question.systemField) {
    case 'FIRST_NAME':
      return 'given-name';
    case 'LAST_NAME':
      return 'family-name';
    case 'EMAIL':
      return 'email';
    case 'PHONE':
      return 'tel';
    case 'DATE_OF_BIRTH':
      return 'bday';
    default:
      return undefined;
  }
}

/**
 * Turns the DOM's string into the value the API expects.
 *
 * The wire types are not negotiable: NUMBER travels as a number and YES_NO as a
 * boolean, because `validateAnswerForQuestion` refuses a string for either. An
 * unparseable number is passed through as the raw string so that validation
 * reports WRONG_TYPE rather than the field silently emptying itself.
 */
function coerce(question: PublicQuestionDTO, raw: string): AnswerValue | null {
  if (raw === '') return null;
  if (question.type === 'NUMBER') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}
