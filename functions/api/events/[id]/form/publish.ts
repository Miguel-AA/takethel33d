// POST /api/events/:id/form/publish
//
// Freezes the draft into an immutable version.
//
// The payload carries a REVISION and nothing else: the server publishes the
// draft it already stores. A whole form never travels back across the wire,
// which removes both a large body and any chance of publishing something other
// than what the server holds.

import { error } from '../../../../_shared/responses';
import { publishFormSchema } from '../../../../../shared/schemas';
import { FormPublishingService } from '../../../../_shared/formPublishingService';
import { adminContext, eventJson, readEventBody } from '../../../../_shared/eventHttp';
import {
  parseFormPath,
  publishFailureResponse,
  validationFields,
} from '../../../../_shared/formHttp';
import type { AdminRequestData } from '../../../../_shared/context';
import type { PublishFormResponse } from '../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestPost: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  const parsed = publishFormSchema.safeParse(body.value);
  if (!parsed.success) {
    return error(
      400,
      'VALIDATION_ERROR',
      'Invalid publish payload',
      validationFields(parsed.error.issues),
      { requestId },
    );
  }

  const service = new FormPublishingService(ctx.env.DB);
  const result = await service.publish(path.id, parsed.data.expectedDraftRevision, {
    admin,
    requestContext,
  });
  if (!result.ok) return publishFailureResponse(result.failure, requestId);

  const response: PublishFormResponse = {
    version: result.value.version,
    draft: result.value.draft,
    eventId: result.value.event.id,
    publishedVersionId: result.value.version.id,
  };
  return eventJson(201, response, requestId);
};
