// PATCH  /api/events/:id/form/questions/:questionId/options/:optionId
// DELETE /api/events/:id/form/questions/:questionId/options/:optionId

import { error } from '../../../../../../../_shared/responses';
import {
  deleteFormEntitySchema,
  updateFormOptionSchema,
} from '../../../../../../../../shared/schemas';
import { FormDraftService } from '../../../../../../../_shared/formDraftService';
import {
  adminContext,
  eventJson,
  readEventBody,
} from '../../../../../../../_shared/eventHttp';
import {
  formFailureResponse,
  parseFormPath,
  validationFields,
} from '../../../../../../../_shared/formHttp';
import type { AdminRequestData } from '../../../../../../../_shared/context';
import type { FormDraftMutationResponse } from '../../../../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestPatch: PagesFunction<
  Env,
  'id' | 'questionId' | 'optionId',
  AdminRequestData
> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(
    ctx.params as Record<string, string>,
    'id',
    'questionId',
    'optionId',
  );
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid identifiers', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  const parsed = updateFormOptionSchema.safeParse(body.value);
  if (!parsed.success) {
    return error(
      400,
      'VALIDATION_ERROR',
      'Invalid option payload',
      validationFields(parsed.error.issues),
      { requestId },
    );
  }

  const service = new FormDraftService(ctx.env.DB);
  const result = await service.updateOption(
    path.id,
    path.questionId,
    path.optionId,
    parsed.data,
    { admin, requestContext },
  );
  if (!result.ok) return formFailureResponse(result.failure, requestId);

  const response: FormDraftMutationResponse = { draft: result.value };
  return eventJson(200, response, requestId);
};

export const onRequestDelete: PagesFunction<
  Env,
  'id' | 'questionId' | 'optionId',
  AdminRequestData
> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(
    ctx.params as Record<string, string>,
    'id',
    'questionId',
    'optionId',
  );
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid identifiers', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  const parsed = deleteFormEntitySchema.safeParse(body.value);
  if (!parsed.success) {
    return error(
      400,
      'VALIDATION_ERROR',
      'Invalid payload',
      validationFields(parsed.error.issues),
      { requestId },
    );
  }

  const service = new FormDraftService(ctx.env.DB);
  const result = await service.deleteOption(
    path.id,
    path.questionId,
    path.optionId,
    parsed.data.expectedRevision,
    { admin, requestContext },
  );
  if (!result.ok) return formFailureResponse(result.failure, requestId);

  const response: FormDraftMutationResponse = { draft: result.value };
  return eventJson(200, response, requestId);
};
