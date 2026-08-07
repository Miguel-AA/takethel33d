import type { FormQuestion, FormQuestionValidation, FormStep } from '@shared/types';
import {
  VALIDATION_KEYS_BY_TYPE,
  editableQuestionFields,
  isNamedSystemField,
  questionTypeCollectsAnswer,
  questionTypeSupportsOptions,
  questionTypeSupportsPlaceholder,
} from '@shared/formLifecycle';
import { useTranslation } from '../i18n/I18nProvider';

/**
 * The properties panel.
 *
 * Fields commit on blur rather than on every keystroke: each edit is a request
 * that moves the form's revision, and one per character would be both wasteful
 * and a guaranteed conflict.
 */
export function QuestionEditor({
  question,
  steps,
  disabled,
  onPatch,
  children,
}: {
  question: FormQuestion;
  steps: Array<Omit<FormStep, 'questions'>>;
  disabled: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
  /** The option editor, when the type takes options. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();

  const editable = editableQuestionFields(question.systemField);
  const isSystem = isNamedSystemField(question.systemField);
  const can = (field: string) => !disabled && editable.includes(field);
  const validationKeys = VALIDATION_KEYS_BY_TYPE[question.type];

  function patchValidation(key: keyof FormQuestionValidation, raw: string) {
    const next: FormQuestionValidation = { ...(question.validation ?? {}) };
    if (raw.trim().length === 0) delete next[key];
    else if (key === 'minDate' || key === 'maxDate') {
      // A date input yields `YYYY-MM-DD`; the contract stores a full instant.
      next[key] = `${raw}T00:00:00.000Z`;
    } else {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return;
      next[key] = numeric as never;
    }
    onPatch({ validation: Object.keys(next).length > 0 ? next : null });
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">
          {t(`form.type.${question.type}`)}
        </p>
        {isSystem && (
          <p className="mt-1 text-xs text-brand-700">
            {t('form.field.systemField', { field: t(`form.systemField.${question.systemField}`) })}
          </p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="question-label">
          {t('form.field.label')}
        </label>
        <input
          id="question-label"
          className="input h-11 rounded-lg"
          defaultValue={question.label}
          disabled={!can('label')}
          key={`label-${question.id}-${question.label}`}
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (next.length > 0 && next !== question.label) onPatch({ label: next });
          }}
        />
      </div>

      <div>
        <label className="label" htmlFor="question-key">
          {t('form.field.key')}
        </label>
        <input
          id="question-key"
          className="input h-11 rounded-lg font-mono text-sm"
          defaultValue={question.key}
          disabled={!can('key')}
          key={`key-${question.id}-${question.key}`}
          onBlur={(event) => {
            const next = event.target.value.trim().toLowerCase();
            if (next.length > 0 && next !== question.key) onPatch({ key: next });
          }}
        />
        <p className="mt-1 text-xs text-slate-500">
          {isSystem ? t('form.field.keyFixed') : t('form.field.keyHint')}
        </p>
      </div>

      <div>
        <label className="label" htmlFor="question-description">
          {t('form.field.help')}
        </label>
        <textarea
          id="question-description"
          rows={2}
          className="input rounded-lg"
          defaultValue={question.description ?? ''}
          disabled={!can('description')}
          key={`description-${question.id}-${question.description ?? ''}`}
          onBlur={(event) => {
            const next = event.target.value.trim();
            const value = next.length === 0 ? null : next;
            if (value !== question.description) onPatch({ description: value });
          }}
        />
      </div>

      {questionTypeSupportsPlaceholder(question.type) && (
        <div>
          <label className="label" htmlFor="question-placeholder">
            {t('form.field.placeholder')}
          </label>
          <input
            id="question-placeholder"
            className="input h-11 rounded-lg"
            defaultValue={question.placeholder ?? ''}
            disabled={!can('placeholder')}
            key={`placeholder-${question.id}-${question.placeholder ?? ''}`}
            onBlur={(event) => {
              const next = event.target.value.trim();
              const value = next.length === 0 ? null : next;
              if (value !== question.placeholder) onPatch({ placeholder: value });
            }}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        {questionTypeCollectsAnswer(question.type) && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={question.required}
              disabled={!can('required')}
              onChange={(event) => onPatch({ required: event.target.checked })}
            />
            {t('form.field.requiredLabel')}
          </label>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={question.active}
            disabled={!can('active')}
            onChange={(event) => onPatch({ active: event.target.checked })}
          />
          {t('form.field.active')}
        </label>
        {questionTypeCollectsAnswer(question.type) && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={question.exportable}
              disabled={!can('exportable')}
              onChange={(event) => onPatch({ exportable: event.target.checked })}
            />
            {t('form.field.exportable')}
          </label>
        )}
      </div>

      <div>
        <label className="label" htmlFor="question-step">
          {t('form.field.step')}
        </label>
        <select
          id="question-step"
          className="input h-11 rounded-lg"
          value={question.stepId}
          disabled={disabled}
          onChange={(event) => onPatch({ stepId: event.target.value })}
        >
          {steps.map((step) => (
            <option key={step.id} value={step.id}>
              {step.title}
            </option>
          ))}
        </select>
      </div>

      {validationKeys.length > 0 && (
        <fieldset className="rounded-lg border border-slate-900/10 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('form.validation.title')}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {validationKeys
              .filter((key) => key !== 'integerOnly')
              .map((key) => {
                const isDate = key === 'minDate' || key === 'maxDate';
                const stored = question.validation?.[key as keyof FormQuestionValidation];
                return (
                  <div key={key}>
                    <label className="label" htmlFor={`validation-${key}`}>
                      {t(`form.validation.${key}`)}
                    </label>
                    <input
                      id={`validation-${key}`}
                      type={isDate ? 'date' : 'number'}
                      className="input h-9 rounded-lg text-sm"
                      defaultValue={
                        stored === undefined
                          ? ''
                          : isDate
                            ? String(stored).slice(0, 10)
                            : String(stored)
                      }
                      key={`validation-${question.id}-${key}-${String(stored ?? '')}`}
                      disabled={disabled}
                      onBlur={(event) =>
                        patchValidation(key as keyof FormQuestionValidation, event.target.value)
                      }
                    />
                  </div>
                );
              })}
            {validationKeys.includes('integerOnly') && (
              <label className="flex items-center gap-2 self-end text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={question.validation?.integerOnly ?? false}
                  disabled={disabled}
                  onChange={(event) => {
                    const next = { ...(question.validation ?? {}) };
                    if (event.target.checked) next.integerOnly = true;
                    else delete next.integerOnly;
                    onPatch({ validation: Object.keys(next).length > 0 ? next : null });
                  }}
                />
                {t('form.validation.integerOnly')}
              </label>
            )}
          </div>
        </fieldset>
      )}

      {questionTypeSupportsOptions(question.type) && children}
    </div>
  );
}
