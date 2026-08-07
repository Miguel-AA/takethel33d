// POST /api/events/:id/prizes/reorder
//
// Applies a complete new ordering in one atomic operation.
//
// A static segment, so it takes precedence over `[prizeId]` and a prize can
// never be named "reorder" in a way that shadows it.

import { error } from '../../../../_shared/responses';
import { reorderEventPrizesSchema } from '../../../../../shared/schemas';
import { PrizeService } from '../../../../_shared/prizeService';
import { adminContext, eventJson, readEventBody } from '../../../../_shared/eventHttp';
import { parseEventPath, prizeFailureResponse } from '../../../../_shared/prizeHttp';
import type { AdminRequestData } from '../../../../_shared/context';

type Env = {
  DB: D1Database;
};

export const onRequestPost: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const eventId = parseEventPath(ctx.params as Record<string, string>);
  if (!eventId) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  // The schema already rejects a repeated prize or a repeated position, so the
  // service only has to check the payload against what is actually stored.
  const parsed = reorderEventPrizesSchema.safeParse(body.value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'body';
      fields[key] = issue.message;
    }
    return error(400, 'VALIDATION_ERROR', 'Invalid reorder payload', fields, { requestId });
  }

  const service = new PrizeService(ctx.env.DB);
  const result = await service.reorder(eventId, parsed.data.items, {
    admin,
    requestContext,
  });
  if (!result.ok) return prizeFailureResponse(result.failure, requestId);

  return eventJson(200, { items: result.value }, requestId);
};
