import { useState } from 'react';
import type { FormQuestion, ReorderFormItem } from '@shared/types';
import { FORM_OPTIONS_PER_QUESTION_MAX } from '@shared/limits';
import { useTranslation } from '../i18n/I18nProvider';

/**
 * The choices offered by a select-style question.
 *
 * Reordering is BUTTONS, not drag-only: a list that can only be rearranged by
 * dragging cannot be rearranged by keyboard at all.
 */
export function OptionEditor({
  question,
  disabled,
  onCreate,
  onUpdate,
  onDelete,
  onReorder,
}: {
  question: FormQuestion;
  disabled: boolean;
  onCreate: (input: { value: string; label: string }) => void;
  onUpdate: (optionId: string, input: { label?: string; active?: boolean }) => void;
  onDelete: (optionId: string) => void;
  onReorder: (items: ReorderFormItem[]) => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');

  const options = question.options;
  const full = options.length >= FORM_OPTIONS_PER_QUESTION_MAX;

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= options.length) return;
    const next = [...options];
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next.map((option, position) => ({ id: option.id, sortOrder: position })));
  }

  function submit() {
    const trimmedLabel = label.trim();
    if (trimmedLabel.length === 0) return;
    // The stored value defaults to a slug of the label, so an operator never
    // has to invent one — but may, when an export needs a specific token.
    const slug =
      value.trim().length > 0
        ? value.trim().toLowerCase()
        : trimmedLabel
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64) || 'option';
    onCreate({ value: slug, label: trimmedLabel });
    setLabel('');
    setValue('');
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {t('form.options.title')} ({options.length})
      </p>

      <ul className="space-y-2">
        {options.map((option, index) => (
          <li key={option.id} className="flex items-center gap-2">
            <div className="flex flex-col">
              <button
                type="button"
                className="btn-ghost px-1 text-xs"
                disabled={disabled || index === 0}
                aria-label={t('form.action.moveUp')}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn-ghost px-1 text-xs"
                disabled={disabled || index === options.length - 1}
                aria-label={t('form.action.moveDown')}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
            </div>

            <input
              className="input h-9 flex-1 rounded-lg text-sm"
              aria-label={t('form.options.label')}
              defaultValue={option.label}
              disabled={disabled}
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (next.length > 0 && next !== option.label) {
                  onUpdate(option.id, { label: next });
                }
              }}
            />
            <code className="shrink-0 text-xs text-slate-500">{option.value}</code>

            <label className="flex shrink-0 items-center gap-1 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={option.active}
                disabled={disabled}
                onChange={(event) => onUpdate(option.id, { active: event.target.checked })}
              />
              {t('form.field.active')}
            </label>

            <button
              type="button"
              className="btn-ghost shrink-0 text-xs text-red-700"
              disabled={disabled}
              aria-label={t('form.options.delete')}
              onClick={() => onDelete(option.id)}
            >
              {t('form.action.delete')}
            </button>
          </li>
        ))}
      </ul>

      {options.length === 0 && (
        <p className="text-xs text-amber-700">{t('form.options.none')}</p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[8rem] flex-1">
          <label className="label" htmlFor="new-option-label">
            {t('form.options.newLabel')}
          </label>
          <input
            id="new-option-label"
            className="input h-9 rounded-lg text-sm"
            value={label}
            disabled={disabled || full}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="min-w-[6rem] flex-1">
          <label className="label" htmlFor="new-option-value">
            {t('form.options.value')}
          </label>
          <input
            id="new-option-value"
            className="input h-9 rounded-lg text-sm"
            placeholder={t('form.options.valueHint')}
            value={value}
            disabled={disabled || full}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={disabled || full || label.trim().length === 0}
          onClick={submit}
        >
          {t('form.options.add')}
        </button>
      </div>
      {full && <p className="text-xs text-amber-700">{t('form.options.full')}</p>}
    </div>
  );
}
