// POST /api/events/:id/duplicate
//
// Creates a fresh DRAFT from an existing event's configuration. State,
// operational timestamps, the original author and any related data are never
// carried over — a duplicate is a new event that happens to start with the same
// settings.

import { error } from '../../../_shared/responses';
import { duplicateEventSchema } from '../../../../shared/schemas';
import { EventLifecycleService } from '../../../_shared/eventService';
import { asUuid } from '../../../_shared/ids';
import {
  adminContext,
  eventJson,
  failureResponse,
  readEventBody,
} from '../../../_shared/eventHttp';
import type { AdminRequestData } from '../../../_shared/context';

type Env = {
  DB: D1Database;
};

export const onRequestPost: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const id = asUuid(ctx.params.id);
  if (!id) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  // All inputs are optional — duplicating with defaults is the common case.
  const body = await readEventBody(ctx.request, requestId, { allowEmpty: true });
  if (!body.ok) return body.response;

  const parsed = duplicateEventSchema.safeParse(body.value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || 'body';
      fields[path] = issue.message;
    }
    return error(400, 'VALIDATION_ERROR', 'Invalid duplicate payload', fields, {
      requestId,
    });
  }

  const service = new EventLifecycleService(ctx.env.DB);
  const result = await service.duplicate(id, parsed.data, { admin, requestContext });
  if (!result.ok) return failureResponse(result.failure, requestId);

  return eventJson(201, result.value, requestId);
};
