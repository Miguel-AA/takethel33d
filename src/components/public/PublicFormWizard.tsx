import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../i18n/I18nProvider';
import { PublicQuestionRenderer } from './PublicQuestionRenderer';
import { validateAnswerForQuestion, isEmptyAnswer } from '@shared/formAnswers';
import type { AnswerValue, SubmittedAnswer } from '@shared/formAnswers';
import type { PublicFormDTO, PublicQuestionDTO } from '@shared/types';

/**
 * The participant's form, generated entirely from a published VERSION.
 *
 * STATE IS KEYED BY QUESTION ID, never by key. The key is a human-readable
 * handle an operator can change; the id is what the submission names and what
 * the server matches against the version. Keying by anything else would break
 * the moment somebody renamed a question.
 *
 * WHY PLAIN REACT STATE RATHER THAN REACT HOOK FORM. The repository uses RHF
 * with `zodResolver` in `RegisterForm`, and that is the right tool there: a
 * fixed schema known at build time. Here the schema is DATA — the questions,
 * their types and their constraints arrive at runtime — so a static resolver
 * has nothing to resolve, and building a Zod schema at runtime would be a
 * second, parallel expression of rules that `validateAnswerForQuestion` already
 * states. A record keyed by id, validated by the shared function, is both
 * simpler and impossible to get out of step with the server.
 *
 * THE CLIENT IS NOT THE AUTHORITY. Every check here also runs on the server,
 * against the frozen version, inside the transaction. This exists so somebody
 * is told about a typo before they submit, not to decide anything.
 *
 * NOTHING IS PERSISTED TO `localStorage`. A refresh loses the form, and that is
 * the accepted trade: the answers include names, email addresses and dates of
 * birth, and leaving those in a shared browser is a privacy cost far larger
 * than the convenience of surviving a reload.
 */

export interface PublicFormWizardProps {
  form: PublicFormDTO;
  submitting: boolean;
  /** Rendered above the actions — a refusal from the server. */
  submissionError: string | null;
  onSubmit: (answers: SubmittedAnswer[]) => void;
}

type Answers = Record<string, AnswerValue | null>;
type Errors = Record<string, string>;

export function PublicFormWizard({
  form,
  submitting,
  submissionError,
  onSubmit,
}: PublicFormWizardProps) {
  const { t } = useTranslation();
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Errors>({});
  const firstInvalid = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const step = form.steps[stepIndex];
  const isLast = stepIndex === form.steps.length - 1;

  const setAnswer = useCallback((questionId: string, value: AnswerValue | null) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
    // The error clears as soon as the field is touched: leaving a stale message
    // under a field somebody has just corrected reads as though the correction
    // did not work.
    setErrors((current) => {
      if (!(questionId in current)) return current;
      const next = { ...current };
      delete next[questionId];
      return next;
    });
  }, []);

  /** Validates one step with the SAME function the server will use. */
  const validateStep = useCallback(
    (questions: readonly PublicQuestionDTO[]): Errors => {
      const found: Errors = {};

      for (const question of questions) {
        // Collects nothing, so there is nothing to check.
        if (question.type === 'INFORMATION') continue;

        const value = answers[question.id] ?? null;
        const empty = isEmptyAnswer(value, question.type);

        if (empty) {
          if (question.required) {
            found[question.id] =
              question.type === 'CONSENT'
                ? t('public.validation.CONSENT_REQUIRED')
                : t('public.validation.REQUIRED');
          }
          continue;
        }

        const check = validateAnswerForQuestion(
          question,
          question.options.map((option) => ({
            id: option.value,
            questionId: question.id,
            value: option.value,
            label: option.label,
            sortOrder: 0,
            active: true,
            createdAt: '',
            updatedAt: '',
          })),
          value,
        );
        if (!check.ok) {
          found[question.id] = t(`public.validation.${check.problem}`);
        }
      }

      return found;
    },
    [answers, t],
  );

  const focusFirstInvalid = useCallback(() => {
    // Announcing "please review the fields" without moving focus leaves a
    // keyboard or screen-reader user to hunt for which one.
    window.requestAnimationFrame(() => firstInvalid.current?.focus());
  }, []);

  const goNext = useCallback(() => {
    const found = validateStep(step.questions);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid();
      return;
    }
    setStepIndex((index) => Math.min(index + 1, form.steps.length - 1));
    // Moving the heading into focus is what tells a screen reader the page
    // changed; without it a step transition is silent.
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }, [focusFirstInvalid, form.steps.length, step, validateStep]);

  const goBack = useCallback(() => {
    // Answers are kept: going back to check something must not cost the work.
    setErrors({});
    setStepIndex((index) => Math.max(index - 1, 0));
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }, []);

  const submit = useCallback(() => {
    // The WHOLE form is revalidated, not only the last step. A question can be
    // required on step one and left empty by a browser restoring a session.
    const everything = form.steps.flatMap((s) => s.questions);
    const found = validateStep(everything);
    setErrors(found);

    if (Object.keys(found).length > 0) {
      const firstBadStep = form.steps.findIndex((s) =>
        s.questions.some((question) => found[question.id]),
      );
      if (firstBadStep >= 0 && firstBadStep !== stepIndex) setStepIndex(firstBadStep);
      focusFirstInvalid();
      return;
    }

    // Only answered questions travel. Sending nulls for every unanswered
    // optional question would make the payload claim they were answered.
    const payload: SubmittedAnswer[] = everything
      .filter((question) => question.type !== 'INFORMATION')
      .filter((question) => !isEmptyAnswer(answers[question.id] ?? null, question.type))
      .map((question) => ({ questionId: question.id, value: answers[question.id]! }));

    onSubmit(payload);
  }, [answers, focusFirstInvalid, form.steps, onSubmit, stepIndex, validateStep]);

  const invalidIds = useMemo(() => new Set(Object.keys(errors)), [errors]);
  let firstInvalidAssigned = false;

  return (
    <section className="card-lg p-6 sm:p-8" aria-labelledby="public-form-heading">
      <PublicFormProgress current={stepIndex + 1} total={form.steps.length} />

      <h2
        id="public-form-heading"
        ref={headingRef}
        tabIndex={-1}
        className="mt-4 text-xl font-semibold text-slate-900 outline-none sm:text-2xl"
      >
        {step.title}
      </h2>
      {step.description && (
        <p className="mt-1 text-sm text-slate-600">{step.description}</p>
      )}

      <div className="mt-6 space-y-6">
        {step.questions.map((question) => {
          const isFirstInvalid = !firstInvalidAssigned && invalidIds.has(question.id);
          if (isFirstInvalid) firstInvalidAssigned = true;

          return (
            <PublicQuestionRenderer
              key={question.id}
              question={question}
              value={answers[question.id] ?? null}
              error={errors[question.id] ?? null}
              onChange={(value) => setAnswer(question.id, value)}
              inputRef={
                isFirstInvalid
                  ? (element) => {
                      firstInvalid.current = element;
                    }
                  : undefined
              }
            />
          );
        })}
      </div>

      {Object.keys(errors).length > 0 && (
        <p className="mt-6 text-sm text-red-700" role="alert">
          {t('public.form.errorSummary')}
        </p>
      )}

      {submissionError && (
        <p className="mt-6 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">
          {submissionError}
        </p>
      )}

      <div className="mt-8 flex flex-col gap-3 sm:flex-row-reverse sm:justify-start">
        {isLast ? (
          <button
            type="button"
            className="btn-primary w-full sm:w-auto"
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? t('public.form.submitting') : t('public.form.submit')}
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary w-full sm:w-auto"
            onClick={goNext}
            disabled={submitting}
          >
            {t('public.form.next')}
          </button>
        )}

        {stepIndex > 0 && (
          <button
            type="button"
            className="btn-secondary w-full sm:w-auto"
            onClick={goBack}
            disabled={submitting}
          >
            {t('public.form.back')}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Progress, stated in words as well as drawn.
 *
 * A bar alone conveys nothing to a screen reader, and "Step 2 of 3" is what a
 * person actually wants to know.
 */
export function PublicFormProgress({ current, total }: { current: number; total: number }) {
  const { t } = useTranslation();
  if (total <= 1) return null;

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {t('public.form.stepOf', { current, total })}
      </p>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-900/10"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={current}
        aria-label={t('public.form.progress')}
      >
        <div
          className="h-full rounded-full bg-brand-600 transition-all"
          style={{ width: `${(current / total) * 100}%` }}
        />
      </div>
    </div>
  );
}
