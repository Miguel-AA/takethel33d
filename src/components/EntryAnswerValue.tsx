import type { EventEntryAnswer, FormStep } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';

/**
 * Renders one stored answer.
 *
 * EVERYTHING here is untrusted input a member of the public typed, so every
 * value is rendered as TEXT. There is no `dangerouslySetInnerHTML`, no markdown
 * pass and no link autodetection anywhere in this file — an answer that looks
 * like markup must look like markup on screen, not become it.
 *
 * Option LABELS are resolved from the published version rather than stored a
 * second time on the answer row. The version is immutable, so the label it
 * carries is exactly the label the person was shown — duplicating it onto the
 * answer would add a column whose only job is to agree with one that cannot
 * change.
 */
export function EntryAnswerValue({
  answer,
  steps,
}: {
  answer: EventEntryAnswer;
  steps: FormStep[] | undefined;
}) {
  const { t } = useTranslation();

  const optionLabel = (value: string): string => {
    const question = steps
      ?.flatMap((step) => step.questions)
      .find((candidate) => candidate.id === answer.questionId);
    const option = question?.options.find((candidate) => candidate.value === value);
    // Falls back to the stored value when the version cannot be read: showing
    // the raw value is honest, and inventing a label would not be.
    return option?.label ?? value;
  };

  switch (answer.type) {
    case 'YES_NO':
    case 'CONSENT':
      return (
        <span className="font-medium text-slate-900">
          {answer.value === true ? t('common.yes') : t('common.no')}
        </span>
      );

    case 'MULTI_SELECT': {
      const values = Array.isArray(answer.value) ? answer.value : [];
      if (values.length === 0) {
        return <span className="text-slate-400">{t('entries.answer.none')}</span>;
      }
      return (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((value) => (
            <li
              key={value}
              className="rounded-full bg-slate-900/5 px-2 py-0.5 text-xs font-medium text-slate-700"
            >
              {optionLabel(value)}
            </li>
          ))}
        </ul>
      );
    }

    case 'SINGLE_SELECT':
    case 'DROPDOWN':
      return (
        <span className="font-medium text-slate-900">
          {optionLabel(String(answer.value))}
        </span>
      );

    case 'LONG_TEXT':
      // `whitespace-pre-wrap` keeps the paragraphs somebody typed, and
      // `break-words` stops a single long token from widening the layout.
      return (
        <p className="whitespace-pre-wrap break-words font-medium text-slate-900">
          {String(answer.value)}
        </p>
      );

    case 'NUMBER':
      return <span className="font-medium tabular-nums text-slate-900">{String(answer.value)}</span>;

    default:
      return (
        <span className="break-words font-medium text-slate-900">{String(answer.value)}</span>
      );
  }
}
