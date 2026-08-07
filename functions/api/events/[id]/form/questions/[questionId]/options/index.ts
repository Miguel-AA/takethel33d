// POST /api/events/:id/form/questions/:questionId/options — offer a choice
//
// Nested under the question, so an option is only ever reached through a
// question that has already been scoped to this event's form.

import { error } from '../../../../../../../_shared/responses';
import { createFormOptionSchema } from '../../../../../../../../shared/schemas';
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

  const parsed = createFormOptionSchema.safeParse(body.value);
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
  const result = await service.createOption(path.id, path.questionId, parsed.data, {
    admin,
    requestContext,
  });
  if (!result.ok) return formFailureResponse(result.failure, requestId);

  const response: FormDraftMutationResponse = { draft: result.value };
  return eventJson(201, response, requestId);
};
