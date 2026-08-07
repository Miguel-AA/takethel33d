// GET  /api/events/:id/form — the draft, or null when there is not one yet
// POST /api/events/:id/form — create it (idempotent)
// PUT  /api/events/:id/form — an explicit checkpoint ("Save draft")
//
// Nested under the event's `[id]` segment, so the event is always part of the
// path and every lookup is scoped to it.
//
// READING NEVER WRITES. Creating the form is a POST an operator makes on
// purpose: a GET that created one could be fired by a browser prefetch, a
// double render or a link preview, and here that accident would write an audit
// row and quietly make the event undeletable.

import { error } from '../../../../_shared/responses';
import { FormDraftService } from '../../../../_shared/formDraftService';
import { adminContext, eventJson, readEventBody } from '../../../../_shared/eventHttp';
import { formFailureResponse, parseFormPath } from '../../../../_shared/formHttp';
import { updateFormDraftSchema } from '../../../../../shared/schemas';
import {
  NAMED_SYSTEM_FIELDS,
  eventAllowsFormEditing,
} from '../../../../../shared/formLifecycle';
import { hasUnpublishedChanges } from '../../../../../shared/formPublishing';
import { FormVersionRepository } from '../../../../_shared/formVersionRepository';
import type { AdminRequestData } from '../../../../_shared/context';
import type {
  EventFormDraft,
  EventFormDraftResponse,
  FormDraftMutationResponse,
} from '../../../../../shared/types';
import type { EventStatus } from '../../../../../shared/eventLifecycle';

type Env = { DB: D1Database };

function draftResponse(
  draft: EventFormDraft | null,
  status: EventStatus,
  published: { id: string; versionNumber: number; sourceDraftRevision: number; publishedAt: string } | null,
): EventFormDraftResponse {
  const placed = new Set(
    (draft?.steps ?? []).flatMap((step) =>
      step.questions.map((question) => question.systemField),
    ),
  );

  return {
    draft,
    eventStatus: status,
    editable: eventAllowsFormEditing(status),
    // Offered as one-click adds; a system field may appear only once.
    availableSystemFields: NAMED_SYSTEM_FIELDS.filter((field) => !placed.has(field)),
    publishedVersionNumber: published?.versionNumber ?? null,
    publishedVersionId: published?.id ?? null,
    publishedAt: published?.publishedAt ?? null,
    // Two integers, not a diff: the draft's revision moves on every edit, so
    // "is there anything unpublished?" is that number against the one the
    // published version froze.
    hasUnpublishedChanges: hasUnpublishedChanges(
      draft?.revision ?? null,
      published?.sourceDraftRevision ?? null,
    ),
  };
}

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const service = new FormDraftService(ctx.env.DB);
  const result = await service.find(path.id);
  if (!result.ok) return formFailureResponse(result.failure, requestId);

  const published = await new FormVersionRepository(ctx.env.DB).findCurrentPublished(path.id);
  return eventJson(
    200,
    draftResponse(result.value.draft, result.value.event.status, published),
    requestId,
  );
};

export const onRequestPost: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const service = new FormDraftService(ctx.env.DB);
  const result = await service.ensure(path.id, { admin, requestContext });
  if (!result.ok) return formFailureResponse(result.failure, requestId);

  const published = await new FormVersionRepository(ctx.env.DB).findCurrentPublished(path.id);
  return eventJson(
    201,
    draftResponse(result.value.draft, result.value.event.status, published),
    requestId,
  );
};

export const onRequestPut: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  const parsed = updateFormDraftSchema.safeParse(body.value);
  if (!parsed.success) {
    return error(400, 'VALIDATION_ERROR', 'Invalid payload', undefined, { requestId });
  }

  const result = await new FormDraftService(ctx.env.DB).saveDraft(
    path.id,
    parsed.data.expectedRevision,
    { admin, requestContext },
  );
  if (!result.ok) return formFailureResponse(result.failure, requestId);

  const response: FormDraftMutationResponse = { draft: result.value };
  return eventJson(200, response, requestId);
};
