// POST /api/events/:id/form/validate-publish
//
// Would this draft publish? Answers without touching anything: no row is
// written, no revision moves, no audit entry is made. An operator may ask as
// often as they like, and the builder asks before every publish.
//
// POST rather than GET because it is a question about a specific revision, and
// because a verdict must never be cached.

import { error } from '../../../../_shared/responses';
import { validatePublishSchema } from '../../../../../shared/schemas';
import { FormPublishingService } from '../../../../_shared/formPublishingService';
import { adminContext, eventJson, readEventBody } from '../../../../_shared/eventHttp';
import { parseFormPath, publishFailureResponse } from '../../../../_shared/formHttp';
import type { AdminRequestData } from '../../../../_shared/context';
import type { FormPublishValidationResponse } from '../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestPost: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId, { allowEmpty: true });
  if (!body.ok) return body.response;

  const parsed = validatePublishSchema.safeParse(body.value);
  if (!parsed.success) {
    return error(400, 'VALIDATION_ERROR', 'Invalid payload', undefined, { requestId });
  }

  const service = new FormPublishingService(ctx.env.DB);
  const result = await service.validate(path.id, parsed.data.expectedDraftRevision);
  if (!result.ok) return publishFailureResponse(result.failure, requestId);

  const response: FormPublishValidationResponse = result.value;
  return eventJson(200, response, requestId);
};
