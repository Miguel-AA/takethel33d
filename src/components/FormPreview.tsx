import type { FormPreviewResponse } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';

/**
 * The draft as a participant would meet it.
 *
 * Every control is DISABLED and nothing is submitted: this phase builds the
 * form and stops there. No participant exists, no answer is stored, and there
 * is no endpoint here that would accept one.
 */
export function FormPreview({ preview }: { preview: FormPreviewResponse }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      {preview.problems.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
            {t('form.preview.problems')}
          </p>
          <ul className="mt-2 space-y-1">
            {preview.problems.map((problem, index) => (
              <li key={`${problem.code}-${index}`} className="text-sm text-amber-900">
                {t(`form.problem.${problem.code}`)}
                {problem.detail ? ` — ${problem.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.steps.length === 0 ? (
        <p className="text-sm text-slate-500">{t('form.preview.empty')}</p>
      ) : (
        preview.steps.map((step, index) => (
          <section key={step.id} className="rounded-lg border border-slate-900/10 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              {t('form.preview.stepOf', { current: index + 1, total: preview.steps.length })}
            </p>
            {/* Operator input, rendered as text. */}
            <h3 className="mt-1 text-lg font-semibold text-slate-900">{step.title}</h3>
            {step.description && (
              <p className="mt-1 text-sm text-slate-600">{step.description}</p>
            )}

            <div className="mt-4 space-y-4">
              {step.questions.length === 0 ? (
                <p className="text-sm text-slate-400">{t('form.preview.noQuestions')}</p>
              ) : (
                step.questions.map((question) => (
                  <PreviewField key={question.id} question={question} />
                ))
              )}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

type PreviewQuestion = FormPreviewResponse['steps'][number]['questions'][number];

function PreviewField({ question }: { question: PreviewQuestion }) {
  const { t } = useTranslation();
  const id = `preview-${question.id}`;

  if (question.type === 'INFORMATION') {
    return (
      <div className="rounded-lg bg-slate-900/5 p-3">
        <p className="font-medium text-slate-900">{question.label}</p>
        {question.description && (
          <p className="mt-1 text-sm text-slate-600">{question.description}</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <label className="label" htmlFor={id}>
        {question.label}
        {question.required && (
          <span className="ml-1 text-red-600" aria-label={t('form.field.required')}>
            *
          </span>
        )}
      </label>
      {question.description && (
        <p className="mb-1 text-xs text-slate-500">{question.description}</p>
      )}
      <PreviewControl id={id} question={question} />
    </div>
  );
}

function PreviewControl({ id, question }: { id: string; question: PreviewQuestion }) {
  const { t } = useTranslation();
  const common = 'input h-11 rounded-lg';
  const placeholder = question.placeholder ?? undefined;

  switch (question.type) {
    case 'LONG_TEXT':
      return (
        <textarea id={id} rows={3} className="input rounded-lg" placeholder={placeholder} disabled />
      );
    case 'NUMBER':
      return <input id={id} type="number" className={common} placeholder={placeholder} disabled />;
    case 'DATE':
      return <input id={id} type="date" className={common} disabled />;
    case 'EMAIL':
      return <input id={id} type="email" className={common} placeholder={placeholder} disabled />;
    case 'PHONE':
      return <input id={id} type="tel" className={common} placeholder={placeholder} disabled />;
    case 'YES_NO':
      return (
        <div className="flex gap-4">
          {['yes', 'no'].map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm text-slate-700">
              <input type="radio" name={id} disabled /> {t(`form.preview.${value}`)}
            </label>
          ))}
        </div>
      );
    case 'CONSENT':
      return (
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" disabled className="mt-1" />
          <span>{question.label}</span>
        </label>
      );
    case 'SINGLE_SELECT':
      return (
        <div className="space-y-1">
          {question.options.map((option) => (
            <label
              key={option.value}
              className="flex items-center gap-2 text-sm text-slate-700"
            >
              <input type="radio" name={id} disabled /> {option.label}
            </label>
          ))}
        </div>
      );
    case 'MULTI_SELECT':
      return (
        <div className="space-y-1">
          {question.options.map((option) => (
            <label
              key={option.value}
              className="flex items-center gap-2 text-sm text-slate-700"
            >
              <input type="checkbox" disabled /> {option.label}
            </label>
          ))}
        </div>
      );
    case 'DROPDOWN':
      return (
        <select id={id} className={common} disabled defaultValue="">
          <option value="">{placeholder ?? t('form.preview.choose')}</option>
          {question.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    default:
      return <input id={id} type="text" className={common} placeholder={placeholder} disabled />;
  }
}
