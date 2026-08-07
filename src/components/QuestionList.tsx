import { useState } from 'react';
import type { FormQuestion, FormStep, ReorderFormItem } from '@shared/types';
import {
  FORM_QUESTION_TYPES,
  SYSTEM_FIELD_LABEL,
  SYSTEM_FIELD_TYPE,
  type FormQuestionType,
  type NamedSystemField,
} from '@shared/formLifecycle';
import { useTranslation } from '../i18n/I18nProvider';

/**
 * The canvas: the questions on the selected page.
 *
 * Adding one is a type and a label — no JSON, no schema, no deploy. The system
 * fields are offered as one-click adds because their type and key are fixed and
 * typing them again would only be a chance to get them wrong.
 */
export function QuestionList({
  step,
  selectedId,
  availableSystemFields,
  disabled,
  onSelect,
  onCreate,
  onAddSystemField,
  onDuplicate,
  onDelete,
  onReorder,
}: {
  step: FormStep;
  selectedId: string | null;
  availableSystemFields: NamedSystemField[];
  disabled: boolean;
  onSelect: (questionId: string) => void;
  onCreate: (input: { type: FormQuestionType; label: string }) => void;
  onAddSystemField: (field: NamedSystemField) => void;
  onDuplicate: (questionId: string) => void;
  onDelete: (question: FormQuestion) => void;
  onReorder: (items: ReorderFormItem[]) => void;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<FormQuestionType>('SHORT_TEXT');
  const [label, setLabel] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);

  const questions = step.questions;

  function reorderTo(fromIndex: number, toIndex: number) {
    if (toIndex < 0 || toIndex >= questions.length || fromIndex === toIndex) return;
    const next = [...questions];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onReorder(next.map((question, position) => ({ id: question.id, sortOrder: position })));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-700">
          {step.title}
        </h2>
        {step.description && <p className="mt-1 text-sm text-slate-600">{step.description}</p>}
      </div>

      <ul className="space-y-2">
        {questions.map((question, index) => (
          <li
            key={question.id}
            draggable={!disabled}
            onDragStart={() => setDragging(question.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (!dragging) return;
              reorderTo(questions.findIndex((c) => c.id === dragging), index);
              setDragging(null);
            }}
            className={`flex items-start gap-2 rounded-lg border p-3 ${
              question.id === selectedId
                ? 'border-brand-500 bg-brand-500/5'
                : 'border-slate-900/10'
            } ${question.active ? '' : 'opacity-60'}`}
          >
            <div className="flex flex-col">
              <button
                type="button"
                className="btn-ghost px-1 text-xs"
                disabled={disabled || index === 0}
                aria-label={t('form.action.moveUp')}
                onClick={() => reorderTo(index, index - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn-ghost px-1 text-xs"
                disabled={disabled || index === questions.length - 1}
                aria-label={t('form.action.moveDown')}
                onClick={() => reorderTo(index, index + 1)}
              >
                ↓
              </button>
            </div>

            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              aria-current={question.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(question.id)}
            >
              <span className="block break-words font-medium text-slate-900">
                {question.label}
                {question.required && <span className="ml-1 text-red-600">*</span>}
              </span>
              <span className="text-xs text-slate-500">
                {t(`form.type.${question.type}`)} · <code>{question.key}</code>
                {question.systemField !== 'NONE' && ` · ${t('form.field.system')}`}
                {!question.active && ` · ${t('form.field.inactive')}`}
              </span>
            </button>

            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                className="btn-ghost text-xs"
                disabled={disabled}
                aria-label={t('form.questions.duplicate')}
                onClick={() => onDuplicate(question.id)}
              >
                {t('form.action.duplicate')}
              </button>
              <button
                type="button"
                className="btn-ghost text-xs text-red-700"
                disabled={disabled}
                aria-label={t('form.questions.delete')}
                onClick={() => onDelete(question)}
              >
                {t('form.action.delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {questions.length === 0 && (
        <p className="text-sm text-slate-500">{t('form.questions.empty')}</p>
      )}

      <div className="rounded-lg border border-dashed border-slate-900/20 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('form.questions.add')}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="new-question-type">
              {t('form.field.type')}
            </label>
            <select
              id="new-question-type"
              className="input h-9 rounded-lg text-sm"
              value={type}
              disabled={disabled}
              onChange={(event) => setType(event.target.value as FormQuestionType)}
            >
              {FORM_QUESTION_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`form.type.${value}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[10rem] flex-1">
            <label className="label" htmlFor="new-question-label">
              {t('form.field.label')}
            </label>
            <input
              id="new-question-label"
              className="input h-9 rounded-lg text-sm"
              value={label}
              disabled={disabled}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn-primary text-xs"
            disabled={disabled || label.trim().length === 0}
            onClick={() => {
              onCreate({ type, label: label.trim() });
              setLabel('');
            }}
          >
            {t('form.questions.addAction')}
          </button>
        </div>

        {availableSystemFields.length > 0 && (
          <div className="mt-3 border-t border-slate-900/10 pt-3">
            <p className="mb-2 text-xs text-slate-500">{t('form.questions.systemFields')}</p>
            <div className="flex flex-wrap gap-1">
              {availableSystemFields.map((field) => (
                <button
                  key={field}
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={disabled}
                  title={t(`form.type.${SYSTEM_FIELD_TYPE[field]}`)}
                  onClick={() => onAddSystemField(field)}
                >
                  + {t(`form.systemField.${field}`) || SYSTEM_FIELD_LABEL[field]}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
