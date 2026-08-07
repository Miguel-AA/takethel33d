import type { EventFormDraft, EventFormVersion, FormPreviewResponse } from '@shared/types';

/**
 * Renders a published version through the same preview shape the draft uses.
 *
 * One renderer, two sources. Duplicating `FormPreview` for versions would mean
 * a published form could start LOOKING different from the draft it came from,
 * which is exactly the confusion versioning exists to remove.
 *
 * Inactive questions are dropped here, as they are for a draft preview: they
 * travel into the version for the historical record, but nobody is shown them.
 */
export function versionToPreview(version: EventFormVersion): FormPreviewResponse {
  return {
    eventId: version.eventId,
    revision: version.sourceDraftRevision,
    steps: version.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      questions: step.questions
        .filter((question) => question.active)
        .map((question) => ({
          id: question.id,
          key: question.key,
          type: question.type,
          label: question.label,
          description: question.description,
          placeholder: question.placeholder,
          required: question.required,
          validation: question.validation,
          options: question.options
            .filter((option) => option.active)
            .map((option) => ({ value: option.value, label: option.label })),
        })),
    })),
    problems: [],
  };
}

export interface FormDifference {
  steps: number;
  questions: number;
  options: number;
  requiredQuestions: number;
}

/**
 * A shape summary of the current draft.
 *
 * Deliberately a COUNT, not a diff. A line-by-line comparison of two forms is a
 * lot of machinery for a question an operator asks once — "roughly how big is
 * what I am about to publish?" — and the authoritative answer to "has anything
 * changed at all?" is already the revision comparison. Nothing here is stored.
 */
export function summarizeFormDifference(draft: EventFormDraft): FormDifference {
  const questions = draft.steps.flatMap((step) => step.questions);
  return {
    steps: draft.steps.length,
    questions: questions.length,
    options: questions.reduce((sum, question) => sum + question.options.length, 0),
    requiredQuestions: questions.filter((question) => question.required).length,
  };
}
