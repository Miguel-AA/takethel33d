import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  CreateFormQuestionInput,
  FormQuestion,
  ReorderFormItem,
} from '@shared/types';
import {
  SYSTEM_FIELD_LABEL,
  SYSTEM_FIELD_TYPE,
  canDeleteQuestion,
  type FormQuestionType,
  type NamedSystemField,
} from '@shared/formLifecycle';
import { useTranslation } from '../i18n/I18nProvider';
import {
  useCreateFormOption,
  useCreateFormQuestion,
  useCreateFormStep,
  useDeleteFormOption,
  useDeleteFormQuestion,
  useDeleteFormStep,
  useDuplicateFormQuestion,
  useFormDraft,
  usePreviewForm,
  useReorderFormOptions,
  useReorderFormQuestions,
  useReorderFormSteps,
  useCreateFormDraft,
  useFormMutationsPending,
  useFormVersion,
  useFormVersions,
  usePublishForm,
  useSaveFormDraft,
  useValidatePublish,
  useUpdateFormOption,
  useUpdateFormQuestion,
  useUpdateFormStep,
} from '../hooks/useFormDraft';
import { ApiError } from '../lib/api';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { StepList } from '../components/StepList';
import { QuestionList } from '../components/QuestionList';
import { QuestionEditor } from '../components/QuestionEditor';
import { OptionEditor } from '../components/OptionEditor';
import { FormPreview } from '../components/FormPreview';
import { PublishDialog } from '../components/PublishDialog';
import { VersionHistory } from '../components/VersionHistory';
import { formatDateTime } from '../lib/format';

/**
 * The form builder.
 *
 * Three panels: the pages on the left, the questions of the selected page in
 * the middle, the properties of the selected question on the right. Every edit
 * is a request carrying the form's revision, and every response replaces the
 * whole draft — so what is on screen is what the server holds, and a second
 * administrator's save is detected rather than silently overwritten.
 */
export function ManagerEventFormBuilderPage() {
  const { t, locale } = useTranslation();
  const { eventId = '' } = useParams();

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);

  const draftQuery = useFormDraft(eventId);
  const createDraft = useCreateFormDraft(eventId);
  const preview = usePreviewForm(eventId, previewOpen && Boolean(draftQuery.data?.draft));

  const save = useSaveFormDraft(eventId);
  const createStep = useCreateFormStep(eventId);
  const updateStep = useUpdateFormStep(eventId);
  const deleteStep = useDeleteFormStep(eventId);
  const reorderSteps = useReorderFormSteps(eventId);
  const createQuestion = useCreateFormQuestion(eventId);
  const updateQuestion = useUpdateFormQuestion(eventId);
  const deleteQuestion = useDeleteFormQuestion(eventId);
  const duplicateQuestion = useDuplicateFormQuestion(eventId);
  const reorderQuestions = useReorderFormQuestions(eventId);
  const createOption = useCreateFormOption(eventId);
  const updateOption = useUpdateFormOption(eventId);
  const deleteOption = useDeleteFormOption(eventId);
  const reorderOptions = useReorderFormOptions(eventId);

  const validatePublish = useValidatePublish(eventId);
  const publish = usePublishForm(eventId);
  const versions = useFormVersions(eventId, historyOpen);
  const openVersion = useFormVersion(eventId, openVersionId);
  // Publishing freezes what the SERVER holds. If a save is still in flight,
  // that is not what is on screen, so the button waits.
  const savePending = useFormMutationsPending();

  const data = draftQuery.data;
  const draft = data?.draft;
  const editable = data?.editable ?? false;

  const steps = useMemo(() => draft?.steps ?? [], [draft]);

  // Keep the selection pointing at something that still exists: a step or
  // question can disappear because this operator deleted it, or because
  // another one did and the reload brought back a form without it.
  useEffect(() => {
    if (steps.length === 0) {
      setSelectedStepId(null);
      return;
    }
    if (!selectedStepId || !steps.some((step) => step.id === selectedStepId)) {
      setSelectedStepId(steps[0].id);
    }
  }, [steps, selectedStepId]);

  const selectedStep = steps.find((step) => step.id === selectedStepId) ?? null;
  const allQuestions = useMemo(
    () => steps.flatMap((step) => step.questions),
    [steps],
  );
  const selectedQuestion =
    allQuestions.find((question) => question.id === selectedQuestionId) ?? null;

  useEffect(() => {
    if (selectedQuestionId && !selectedQuestion) setSelectedQuestionId(null);
  }, [selectedQuestionId, selectedQuestion]);

  const busy =
    save.isPending ||
    createStep.isPending ||
    updateStep.isPending ||
    deleteStep.isPending ||
    reorderSteps.isPending ||
    createQuestion.isPending ||
    updateQuestion.isPending ||
    deleteQuestion.isPending ||
    duplicateQuestion.isPending ||
    reorderQuestions.isPending ||
    createOption.isPending ||
    updateOption.isPending ||
    deleteOption.isPending ||
    reorderOptions.isPending;

  function describeError(err: unknown): string {
    if (err instanceof ApiError) {
      switch (err.code) {
        case 'FORM_REVISION_CONFLICT':
          return t('form.error.revisionConflict');
        case 'FORM_NOT_EDITABLE':
          return t('form.error.notEditable', { status: err.fields?.eventStatus ?? '' });
        case 'FORM_STEP_NOT_EMPTY':
          return t('form.error.stepNotEmpty');
        case 'FORM_QUESTION_PROTECTED':
          return t('form.error.protected');
        case 'FORM_KEY_EXISTS':
          return t('form.error.keyExists');
        case 'FORM_SYSTEM_FIELD_EXISTS':
          return t('form.error.systemFieldExists');
        case 'FORM_LIMIT_REACHED':
          return t('form.error.limitReached', { limit: err.fields?.limit ?? '' });
        case 'FORM_QUESTION_INVALID':
          return t('form.error.invalidQuestion');
        case 'FORM_OPTION_NOT_ALLOWED':
          return t('form.error.optionsNotAllowed');
        case 'FORM_ORDER_INVALID':
          return t('form.error.orderInvalid');
        case 'FORM_DRAFT_REVISION_CONFLICT':
          return t('publish.error.revisionConflict');
        case 'FORM_NO_UNPUBLISHED_CHANGES':
          return t('publish.error.noChanges');
        case 'FORM_DRAFT_NOT_PUBLISHABLE':
          return t('publish.error.notPublishable');
        case 'FORM_VERSION_NUMBER_CONFLICT':
          return t('publish.error.raced');
        case 'FORM_PUBLISH_FAILED':
        case 'FORM_VERSION_INVALID':
          return t('publish.error.failed');
        case 'VALIDATION_ERROR':
          return t('form.error.validation');
        default:
          return t('common.error');
      }
    }
    return t('common.error');
  }

  /** Runs a mutation and surfaces a refusal instead of losing it. */
  async function run(action: () => Promise<unknown>): Promise<void> {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  const revision = draft?.revision ?? 0;

  function addQuestion(input: { type: FormQuestionType; label: string }) {
    if (!selectedStep) return;
    const payload: CreateFormQuestionInput = {
      expectedRevision: revision,
      stepId: selectedStep.id,
      type: input.type,
      label: input.label,
    };
    void run(async () => {
      const result = await createQuestion.mutateAsync(payload);
      // Select what was just added, so the properties panel is about it.
      const created = result.draft.steps
        .flatMap((step) => step.questions)
        .filter((question) => !allQuestions.some((existing) => existing.id === question.id));
      if (created.length === 1) setSelectedQuestionId(created[0].id);
    });
  }

  function addSystemField(field: NamedSystemField) {
    if (!selectedStep) return;
    void run(() =>
      createQuestion.mutateAsync({
        expectedRevision: revision,
        stepId: selectedStep.id,
        type: SYSTEM_FIELD_TYPE[field],
        systemField: field,
        label: t(`form.systemField.${field}`) || SYSTEM_FIELD_LABEL[field],
        required: true,
      }),
    );
  }

  function removeQuestion(question: FormQuestion) {
    if (!canDeleteQuestion(question.systemField, question.required)) {
      setActionError(t('form.error.protected'));
      return;
    }
    if (!window.confirm(t('form.confirm.deleteQuestion'))) return;
    void run(() =>
      deleteQuestion.mutateAsync({ questionId: question.id, expectedRevision: revision }),
    );
  }

  if (draftQuery.isPending) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-14 text-center text-slate-500 sm:px-6">
        <Spinner /> <span className="ml-2">{t('common.loading')}</span>
      </div>
    );
  }

  if (draftQuery.isError || !data) {
    const notFound = draftQuery.error instanceof ApiError && draftQuery.error.status === 404;
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-14 sm:px-6">
        <ErrorBanner
          message={notFound ? t('event.error.notFound') : describeError(draftQuery.error)}
        />
        <Link to="/manager/events" className="btn-secondary w-fit text-xs">
          {t('events.action.backToList')}
        </Link>
      </div>
    );
  }

  // No form yet. Creating one is an explicit act: it is what makes this event
  // undeletable, so it is not something a page visit should do on its own.
  if (!draft) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          <span className="accent-underline">{t('form.title')}</span>
        </h1>
        <p className="text-slate-600">{t('form.start.explain')}</p>
        {actionError && <ErrorBanner message={actionError} />}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary w-fit text-xs"
            disabled={!editable || createDraft.isPending}
            onClick={() => void run(() => createDraft.mutateAsync())}
          >
            {createDraft.isPending ? (
              <>
                <Spinner /> {t('form.action.saving')}
              </>
            ) : (
              t('form.start.action')
            )}
          </button>
          <Link to={`/manager/events/${eventId}`} className="btn-secondary w-fit text-xs">
            {t('events.action.backToDetail')}
          </Link>
        </div>
        {!editable && (
          <p className="text-sm text-amber-700">
            {t('form.frozen', { status: t(`event.status.${data.eventStatus}`) })}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            <span className="accent-underline">{t('form.title')}</span>
          </h1>
          <p className="mt-2 text-slate-600">{t('form.subtitle')}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500">
              {t('form.revision', { revision: draft.revision })}
            </span>
            {data.publishedVersionNumber === null ? (
              <span className="rounded-full bg-slate-900/10 px-2 py-0.5 font-semibold text-slate-600">
                {t('publish.state.never')}
              </span>
            ) : (
              <span className="rounded-full bg-brand-500/10 px-2 py-0.5 font-semibold text-brand-700">
                {t('publish.state.published', { version: data.publishedVersionNumber })}
              </span>
            )}
            {/* Two integers, not a diff — see `hasUnpublishedChanges`. */}
            {data.hasUnpublishedChanges ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                {t('publish.state.dirty')}
              </span>
            ) : (
              data.publishedVersionNumber !== null && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-800">
                  {t('publish.state.upToDate')}
                </span>
              )
            )}
            {data.publishedAt && (
              <span className="text-slate-500">
                {formatDateTime(data.publishedAt, locale)}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/manager/events/${eventId}`} className="btn-secondary w-fit text-xs">
            {t('events.action.backToDetail')}
          </Link>
          <button
            type="button"
            className="btn-secondary w-fit text-xs"
            onClick={() => setHistoryOpen(true)}
          >
            {t('versions.title')}
          </button>
          <button
            type="button"
            className="btn-secondary w-fit text-xs"
            onClick={() => setPreviewOpen(true)}
          >
            {t('form.action.preview')}
          </button>
          <button
            type="button"
            className="btn-secondary w-fit text-xs"
            disabled={!editable || busy}
            onClick={() => void run(() => save.mutateAsync(revision))}
          >
            {save.isPending ? (
              <>
                <Spinner /> {t('form.action.saving')}
              </>
            ) : (
              t('form.action.save')
            )}
          </button>
          <button
            type="button"
            className="btn-primary w-fit text-xs"
            // Never publish over a save still in flight: what would be frozen
            // is the server's copy, not the one on screen.
            disabled={!editable || savePending || publish.isPending}
            title={savePending ? t('publish.waitingForSave') : undefined}
            onClick={() => {
              setPublishOpen(true);
              validatePublish.reset();
              void validatePublish.mutateAsync(revision).catch(() => undefined);
            }}
          >
            {t('publish.action')}
          </button>
        </div>
      </header>

      {savePending && (
        <p className="text-xs text-slate-500">{t('publish.waitingForSave')}</p>
      )}

      {!editable && (
        <div className="card p-4 text-sm text-amber-700">
          {t('form.frozen', { status: t(`event.status.${data?.eventStatus}`) })}
        </div>
      )}

      {actionError && <ErrorBanner message={actionError} />}

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)_22rem]">
        <aside className="card p-4">
          <StepList
            steps={steps}
            selectedId={selectedStepId}
            disabled={!editable || busy}
            onSelect={setSelectedStepId}
            onCreate={(title) =>
              void run(() => createStep.mutateAsync({ expectedRevision: revision, title }))
            }
            onRename={(stepId, title) =>
              void run(() =>
                updateStep.mutateAsync({
                  stepId,
                  input: { expectedRevision: revision, title },
                }),
              )
            }
            onDelete={(stepId) =>
              void run(() => deleteStep.mutateAsync({ stepId, expectedRevision: revision }))
            }
            onReorder={(items: ReorderFormItem[]) =>
              void run(() => reorderSteps.mutateAsync({ expectedRevision: revision, items }))
            }
          />
        </aside>

        <section className="card p-4">
          {selectedStep ? (
            <QuestionList
              step={selectedStep}
              selectedId={selectedQuestionId}
              availableSystemFields={
                (data?.availableSystemFields ?? []).filter(
                  (field): field is NamedSystemField => field !== 'NONE',
                )
              }
              disabled={!editable || busy}
              onSelect={setSelectedQuestionId}
              onCreate={addQuestion}
              onAddSystemField={addSystemField}
              onDuplicate={(questionId) =>
                void run(() =>
                  duplicateQuestion.mutateAsync({ questionId, expectedRevision: revision }),
                )
              }
              onDelete={removeQuestion}
              onReorder={(items) =>
                void run(() =>
                  reorderQuestions.mutateAsync({
                    expectedRevision: revision,
                    stepId: selectedStep.id,
                    items,
                  }),
                )
              }
            />
          ) : (
            <p className="text-sm text-slate-500">{t('form.steps.selectPrompt')}</p>
          )}
        </section>

        <aside className="card p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-700">
            {t('form.properties.title')}
          </h2>
          {selectedQuestion ? (
            <QuestionEditor
              question={selectedQuestion}
              steps={steps}
              disabled={!editable || busy}
              onPatch={(patch) =>
                void run(() =>
                  updateQuestion.mutateAsync({
                    questionId: selectedQuestion.id,
                    input: { expectedRevision: revision, ...patch },
                  }),
                )
              }
            >
              <OptionEditor
                question={selectedQuestion}
                disabled={!editable || busy}
                onCreate={(input) =>
                  void run(() =>
                    createOption.mutateAsync({
                      questionId: selectedQuestion.id,
                      input: { expectedRevision: revision, ...input },
                    }),
                  )
                }
                onUpdate={(optionId, input) =>
                  void run(() =>
                    updateOption.mutateAsync({
                      questionId: selectedQuestion.id,
                      optionId,
                      input: { expectedRevision: revision, ...input },
                    }),
                  )
                }
                onDelete={(optionId) =>
                  void run(() =>
                    deleteOption.mutateAsync({
                      questionId: selectedQuestion.id,
                      optionId,
                      expectedRevision: revision,
                    }),
                  )
                }
                onReorder={(items) =>
                  void run(() =>
                    reorderOptions.mutateAsync({
                      questionId: selectedQuestion.id,
                      expectedRevision: revision,
                      items,
                    }),
                  )
                }
              />
            </QuestionEditor>
          ) : (
            <p className="text-sm text-slate-500">{t('form.properties.prompt')}</p>
          )}
        </aside>
      </div>

      {previewOpen && (
        <PreviewDialog title={t('form.action.preview')} onClose={() => setPreviewOpen(false)}>
          {preview.isPending ? (
            <div className="p-6 text-center text-slate-500">
              <Spinner /> <span className="ml-2">{t('common.loading')}</span>
            </div>
          ) : preview.isError || !preview.data ? (
            <ErrorBanner message={t('common.error')} />
          ) : (
            <FormPreview preview={preview.data} />
          )}
        </PreviewDialog>
      )}

      {publishOpen && (
        <PreviewDialog title={t('publish.action')} onClose={() => setPublishOpen(false)}>
          <PublishDialog
            validation={validatePublish.data ?? null}
            validating={validatePublish.isPending}
            publishing={publish.isPending}
            errorMessage={
              validatePublish.isError
                ? describeError(validatePublish.error)
                : publish.isError
                  ? describeError(publish.error)
                  : null
            }
            onGoToIssue={(issue) => {
              // Walk the builder to the thing that needs fixing.
              if (issue.stepId) setSelectedStepId(issue.stepId);
              if (issue.questionId) setSelectedQuestionId(issue.questionId);
              setPublishOpen(false);
            }}
            onCancel={() => setPublishOpen(false)}
            onConfirm={() => {
              // The dialog reports its own failures; sending them to the page
              // banner as well would say the same thing twice.
              setActionError(null);
              publish
                .mutateAsync(revision)
                .then(() => setPublishOpen(false))
                .catch(() => undefined);
            }}
          />
        </PreviewDialog>
      )}

      {historyOpen && (
        <PreviewDialog
          title={t('versions.title')}
          onClose={() => {
            setHistoryOpen(false);
            setOpenVersionId(null);
          }}
        >
          <VersionHistory
            versions={versions.data?.items ?? []}
            loading={versions.isPending}
            error={versions.isError}
            draft={draft}
            selectedVersionId={openVersionId}
            selectedVersion={openVersion.data?.version ?? null}
            versionLoading={openVersion.isPending}
            onSelect={setOpenVersionId}
            onClearSelection={() => setOpenVersionId(null)}
          />
        </PreviewDialog>
      )}
    </div>
  );
}

function PreviewDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);

  // Escape closes it, and focus moves into the dialog on open and back to
  // whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current
      ?.querySelector<HTMLElement>('button, [href], input, select, textarea')
      ?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        ref={panel}
        className="glass-panel-strong my-8 w-full max-w-2xl p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button type="button" className="btn-secondary text-xs" onClick={onClose}>
            {t('form.action.close')}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
