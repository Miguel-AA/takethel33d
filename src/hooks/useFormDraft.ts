import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type {
  CreateFormOptionInput,
  CreateFormQuestionInput,
  CreateFormStepInput,
  EventFormDraftResponse,
  FormDraftMutationResponse,
  ReorderFormItem,
  UpdateFormOptionInput,
  UpdateFormQuestionInput,
  UpdateFormStepInput,
} from '@shared/types';

/**
 * The draft, fetched once and replaced wholesale by every mutation.
 *
 * The server answers each mutation with the complete draft at its new revision,
 * so the cache is SET rather than invalidated: a three-panel builder that
 * refetched after every keystroke-sized edit would flicker, and one that merged
 * partial responses would drift out of step with the revision it must send next.
 */
export function useFormDraft(eventId: string) {
  return useQuery({
    queryKey: queryKeys.eventFormDraft(eventId),
    queryFn: () => api.getFormDraft(eventId),
    enabled: Boolean(eventId),
    retry: false,
  });
}

/**
 * Shared mutation wiring.
 *
 * On success the returned draft replaces the cached one. The EVENT detail is
 * invalidated too: an event that has gained a form can no longer be deleted,
 * and a stale detail page would keep offering the button.
 */
/**
 * Tags every draft mutation, so "is anything still saving?" is one question
 * rather than a growing list of `isPending` flags to keep in sync.
 */
const FORM_MUTATION_KEY = ['form-draft-mutation'] as const;

function useDraftMutation<TVariables>(
  eventId: string,
  mutationFn: (variables: TVariables) => Promise<FormDraftMutationResponse>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: FORM_MUTATION_KEY,
    mutationFn,
    onSuccess: (result) => {
      qc.setQueryData<EventFormDraftResponse>(queryKeys.eventFormDraft(eventId), (current) => {
        if (!current) return current;
        // Responses can arrive out of order — a slow request answering after a
        // fast one that already moved the form on. The revision says which is
        // newer, so an older answer is dropped rather than rewinding the
        // builder to a state the server has already left behind.
        if (current.draft && result.draft.revision <= current.draft.revision) return current;
        return { ...current, draft: result.draft };
      });
      void qc.invalidateQueries({ queryKey: queryKeys.eventFormPreview(eventId) });
      // EXACT: the event-detail key is a PREFIX of the draft's, so a prefix
      // invalidation would refetch the very draft that was just set — throwing
      // away the fresh answer and replacing it with whatever a request issued
      // moments earlier returns.
      void qc.invalidateQueries({ queryKey: queryKeys.eventDetail(eventId), exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
    },
  });
}

/**
 * Brings the form into existence.
 *
 * Separate from reading on purpose: a GET that created one could be fired by a
 * prefetch or a double render, and creating a form makes its event undeletable.
 */
export function useCreateFormDraft(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.createFormDraft(eventId),
    onSuccess: (result) => {
      qc.setQueryData<EventFormDraftResponse>(queryKeys.eventFormDraft(eventId), result);
      // Exact, for the same reason as above: the detail key is a prefix here.
      void qc.invalidateQueries({ queryKey: queryKeys.eventDetail(eventId), exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
    },
  });
}

export function useSaveFormDraft(eventId: string) {
  return useDraftMutation(eventId, (expectedRevision: number) =>
    api.saveFormDraft(eventId, expectedRevision),
  );
}

export function useCreateFormStep(eventId: string) {
  return useDraftMutation(eventId, (input: CreateFormStepInput) =>
    api.createFormStep(eventId, input),
  );
}

export function useUpdateFormStep(eventId: string) {
  return useDraftMutation(
    eventId,
    ({ stepId, input }: { stepId: string; input: UpdateFormStepInput }) =>
      api.updateFormStep(eventId, stepId, input),
  );
}

export function useDeleteFormStep(eventId: string) {
  return useDraftMutation(
    eventId,
    ({ stepId, expectedRevision }: { stepId: string; expectedRevision: number }) =>
      api.deleteFormStep(eventId, stepId, expectedRevision),
  );
}

export function useReorderFormSteps(eventId: string) {
  return useDraftMutation(
    eventId,
    ({
      expectedRevision,
      items,
    }: {
      expectedRevision: number;
      items: ReorderFormItem[];
    }) => api.reorderFormSteps(eventId, expectedRevision, items),
  );
}

export function useCreateFormQuestion(eventId: string) {
  return useDraftMutation(eventId, (input: CreateFormQuestionInput) =>
    api.createFormQuestion(eventId, input),
  );
}

export function useUpdateFormQuestion(eventId: string) {
  return useDraftMutation(
    eventId,
    ({ questionId, input }: { questionId: string; input: UpdateFormQuestionInput }) =>
      api.updateFormQuestion(eventId, questionId, input),
  );
}

export function useDeleteFormQuestion(eventId: string) {
  return useDraftMutation(
    eventId,
    ({ questionId, expectedRevision }: { questionId: string; expectedRevision: number }) =>
      api.deleteFormQuestion(eventId, questionId, expectedRevision),
  );
}

export function useDuplicateFormQuestion(eventId: string) {
  return useDraftMutation(
    eventId,
    ({ questionId, expectedRevision }: { questionId: string; expectedRevision: number }) =>
      api.duplicateFormQuestion(eventId, questionId, expectedRevision),
  );
}

export function useReorderFormQuestions(eventId: string) {
  return useDraftMutation(
    eventId,
    ({
      expectedRevision,
      stepId,
      items,
    }: {
      expectedRevision: number;
      stepId: string;
      items: ReorderFormItem[];
    }) => api.reorderFormQuestions(eventId, expectedRevision, stepId, items),
  );
}

export function useCreateFormOption(eventId: string) {
  return useDraftMutation(
    eventId,
    ({ questionId, input }: { questionId: string; input: CreateFormOptionInput }) =>
      api.createFormOption(eventId, questionId, input),
  );
}

export function useUpdateFormOption(eventId: string) {
  return useDraftMutation(
    eventId,
    ({
      questionId,
      optionId,
      input,
    }: {
      questionId: string;
      optionId: string;
      input: UpdateFormOptionInput;
    }) => api.updateFormOption(eventId, questionId, optionId, input),
  );
}

export function useDeleteFormOption(eventId: string) {
  return useDraftMutation(
    eventId,
    ({
      questionId,
      optionId,
      expectedRevision,
    }: {
      questionId: string;
      optionId: string;
      expectedRevision: number;
    }) => api.deleteFormOption(eventId, questionId, optionId, expectedRevision),
  );
}

export function useReorderFormOptions(eventId: string) {
  return useDraftMutation(
    eventId,
    ({
      questionId,
      expectedRevision,
      items,
    }: {
      questionId: string;
      expectedRevision: number;
      items: ReorderFormItem[];
    }) => api.reorderFormOptions(eventId, questionId, expectedRevision, items),
  );
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Whether anything is still in flight.
 *
 * Publishing freezes the draft AS THE SERVER HOLDS IT. If an edit is still on
 * its way, what gets frozen is not what is on screen — so the builder waits
 * rather than publishing a form the operator has not seen.
 */
export function useFormMutationsPending(): boolean {
  return useIsMutating({ mutationKey: FORM_MUTATION_KEY }) > 0;
}

export function useValidatePublish(eventId: string) {
  return useMutation({
    mutationFn: (expectedDraftRevision?: number) =>
      api.validatePublishForm(eventId, expectedDraftRevision),
  });
}

/**
 * Publishes, then refreshes everything a publication changes.
 *
 * The draft is refetched too: it did not change, but its PUBLICATION STATE did,
 * and that is what the badge reads.
 */
export function usePublishForm(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (expectedDraftRevision: number) =>
      api.publishForm(eventId, expectedDraftRevision),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.eventFormDraft(eventId), exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.formVersions(eventId) });
      void qc.invalidateQueries({ queryKey: queryKeys.publishedForm(eventId) });
      void qc.invalidateQueries({ queryKey: queryKeys.eventDetail(eventId), exact: true });
      void qc.invalidateQueries({ queryKey: queryKeys.eventsAll });
      void qc.invalidateQueries({ queryKey: queryKeys.auditAll });
    },
  });
}

export function useFormVersions(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.formVersions(eventId),
    queryFn: () => api.listFormVersions(eventId),
    enabled: Boolean(eventId) && enabled,
    retry: false,
  });
}

/** One published version. Immutable, so it never needs refetching. */
export function useFormVersion(eventId: string, versionId: string | null) {
  return useQuery({
    queryKey: queryKeys.formVersion(eventId, versionId ?? ''),
    queryFn: () => api.getFormVersion(eventId, versionId as string),
    enabled: Boolean(eventId && versionId),
    staleTime: Infinity,
    retry: false,
  });
}

export function usePublishedForm(eventId: string) {
  return useQuery({
    queryKey: queryKeys.publishedForm(eventId),
    queryFn: () => api.getPublishedForm(eventId),
    enabled: Boolean(eventId),
    retry: false,
  });
}

/**
 * The preview, fetched on demand.
 *
 * `enabled` is driven by the panel being open, so opening it is what asks the
 * server to compile the draft — nothing is computed while the operator edits.
 */
export function usePreviewForm(eventId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.eventFormPreview(eventId),
    queryFn: () => api.previewFormDraft(eventId),
    enabled: Boolean(eventId) && enabled,
    retry: false,
  });
}
