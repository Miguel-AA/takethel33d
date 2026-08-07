import { useState } from 'react';
import type { FormStep, ReorderFormItem } from '@shared/types';
import { FORM_STEPS_MAX } from '@shared/limits';
import { useTranslation } from '../i18n/I18nProvider';

/**
 * The pages of the wizard.
 *
 * Reordering offers BOTH drag-and-drop and move buttons. The buttons are not a
 * fallback: they are the only path that works from a keyboard, so they are
 * always present rather than appearing on hover.
 */
export function StepList({
  steps,
  selectedId,
  disabled,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onReorder,
}: {
  steps: FormStep[];
  selectedId: string | null;
  disabled: boolean;
  onSelect: (stepId: string) => void;
  onCreate: (title: string) => void;
  onRename: (stepId: string, title: string) => void;
  onDelete: (stepId: string) => void;
  onReorder: (items: ReorderFormItem[]) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);

  const full = steps.length >= FORM_STEPS_MAX;

  function reorderTo(fromIndex: number, toIndex: number) {
    if (toIndex < 0 || toIndex >= steps.length || fromIndex === toIndex) return;
    const next = [...steps];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onReorder(next.map((step, position) => ({ id: step.id, sortOrder: position })));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-700">
          {t('form.steps.title')}
        </h2>
        <span className="text-xs text-slate-500">
          {steps.length}/{FORM_STEPS_MAX}
        </span>
      </div>

      <ul className="space-y-2">
        {steps.map((step, index) => (
          <li
            key={step.id}
            draggable={!disabled}
            onDragStart={() => setDragging(step.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (!dragging) return;
              reorderTo(steps.findIndex((candidate) => candidate.id === dragging), index);
              setDragging(null);
            }}
            className={`rounded-lg border p-2 ${
              step.id === selectedId
                ? 'border-brand-500 bg-brand-500/5'
                : 'border-slate-900/10'
            }`}
          >
            <div className="flex items-start gap-1">
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
                  disabled={disabled || index === steps.length - 1}
                  aria-label={t('form.action.moveDown')}
                  onClick={() => reorderTo(index, index + 1)}
                >
                  ↓
                </button>
              </div>

              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                aria-current={step.id === selectedId ? 'true' : undefined}
                onClick={() => onSelect(step.id)}
              >
                {/* Operator input, rendered as text. */}
                <span className="block break-words text-sm font-medium text-slate-900">
                  {step.title}
                </span>
                <span className="text-xs text-slate-500">
                  {t('form.steps.questionCount', { count: step.questions.length })}
                </span>
              </button>
            </div>

            {step.id === selectedId && !disabled && (
              <div className="mt-2 flex flex-wrap gap-1">
                <input
                  className="input h-8 flex-1 rounded-lg text-xs"
                  aria-label={t('form.steps.rename')}
                  defaultValue={step.title}
                  key={`title-${step.id}-${step.title}`}
                  onBlur={(event) => {
                    const next = event.target.value.trim();
                    if (next.length > 0 && next !== step.title) onRename(step.id, next);
                  }}
                />
                <button
                  type="button"
                  className="btn-ghost text-xs text-red-700"
                  // Only an EMPTY page can go: losing a page of configuration
                  // to one click is not a thing this system does.
                  disabled={step.questions.length > 0}
                  title={
                    step.questions.length > 0 ? t('form.steps.deleteBlocked') : undefined
                  }
                  aria-label={t('form.steps.delete')}
                  onClick={() => onDelete(step.id)}
                >
                  {t('form.action.delete')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {steps.length === 0 && <p className="text-xs text-slate-500">{t('form.steps.empty')}</p>}

      {adding ? (
        <div className="space-y-2">
          <label className="label" htmlFor="new-step-title">
            {t('form.steps.newTitle')}
          </label>
          <input
            id="new-step-title"
            className="input h-9 rounded-lg text-sm"
            value={title}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={title.trim().length === 0}
              onClick={() => {
                onCreate(title.trim());
                setTitle('');
                setAdding(false);
              }}
            >
              {t('form.steps.add')}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => {
                setTitle('');
                setAdding(false);
              }}
            >
              {t('form.action.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn-secondary w-full text-xs"
          disabled={disabled || full}
          onClick={() => setAdding(true)}
        >
          {t('form.steps.add')}
        </button>
      )}
      {full && <p className="text-xs text-amber-700">{t('form.steps.full')}</p>}
    </div>
  );
}
