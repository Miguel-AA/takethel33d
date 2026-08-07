// POST /api/events/:id/form/questions/:questionId/duplicate
//
// Copies a question and its choices to the end of the same step. The copy is
// never a system field: those may appear once per form, and an operator
// duplicating "Email" wants a second ordinary question, not a conflict.

import { error } from '../../../../../../_shared/responses';
import { deleteFormEntitySchema } from '../../../../../../../shared/schemas';
import { FormDraftService } from '../../../../../../_shared/formDraftService';
import { adminContext, eventJson, readEventBody } from '../../../../../../_shared/eventHttp';
import {
  formFailureResponse,
  parseFormPath,
  validationFields,
} from '../../../../../../_shared/formHttp';
import type { AdminRequestData } from '../../../../../../_shared/context';
import type { FormDraftMutationResponse } from '../../../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestPost: PagesFunction<Env, 'id' | 'questionId', AdminRequestData> = async (
  ctx,
) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id', 'questionId');
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
  const result = await service.duplicateQuestion(
    path.id,
    path.questionId,
    parsed.data.expectedRevision,
    { admin, requestContext },
  );
  if (!result.ok) return formFailureResponse(result.failure, requestId);

  const response: FormDraftMutationResponse = { draft: result.value };
  return eventJson(201, response, requestId);
};
