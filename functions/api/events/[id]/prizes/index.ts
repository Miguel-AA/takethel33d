// GET  /api/events/:id/prizes — paginated listing with a configuration summary
// POST /api/events/:id/prizes — add a prize
//
// Nested under the event's `[id]` segment, so the event is always part of the
// path and every lookup is scoped to it.

import { error } from '../../../../_shared/responses';
import {
  createEventPrizeSchema,
  eventPrizeListQuerySchema,
} from '../../../../../shared/schemas';
import { PrizeService } from '../../../../_shared/prizeService';
import { adminContext, eventJson, readEventBody } from '../../../../_shared/eventHttp';
import { parseEventPath, prizeFailureResponse } from '../../../../_shared/prizeHttp';
import type { AdminRequestData } from '../../../../_shared/context';
import type { EventPrizeListResponse } from '../../../../../shared/types';

type Env = {
  DB: D1Database;
};

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const eventId = parseEventPath(ctx.params as Record<string, string>);
  if (!eventId) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const params = new URL(ctx.request.url).searchParams;
  const parsed = eventPrizeListQuerySchema.safeParse({
    ...(params.get('page') !== null ? { page: params.get('page') } : {}),
    ...(params.get('pageSize') !== null ? { pageSize: params.get('pageSize') } : {}),
    ...(params.get('status') ? { status: params.get('status') } : {}),
    ...(params.get('archived') ? { archived: params.get('archived') } : {}),
    ...(params.get('search') ? { search: params.get('search') } : {}),
    ...(params.get('sort') ? { sort: params.get('sort') } : {}),
    ...(params.get('direction') ? { direction: params.get('direction') } : {}),
  });
  if (!parsed.success) {
    return error(400, 'INVALID_QUERY', 'Invalid list filters', undefined, { requestId });
  }

  const service = new PrizeService(ctx.env.DB);
  const event = await service.findEvent(eventId);
  if (!event) {
    return error(404, 'EVENT_NOT_FOUND', 'Event not found', undefined, { requestId });
  }

  const [{ items, total }, summary] = await Promise.all([
    service.list(eventId, parsed.data),
    service.summarize(eventId),
  ]);

  const body: EventPrizeListResponse = {
    items,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
    summary,
    // The UI needs this to know which controls to offer.
    eventStatus: event.status,
  };

  return eventJson(200, body, requestId);
};

export const onRequestPost: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const eventId = parseEventPath(ctx.params as Record<string, string>);
  if (!eventId) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  // `.strict()` is what refuses status, revision, eventId and the actor and
  // timestamp columns.
  const parsed = createEventPrizeSchema.safeParse(body.value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || 'body';
      fields[path] = issue.message;
    }
    return error(400, 'VALIDATION_ERROR', 'Invalid prize payload', fields, { requestId });
  }

  const service = new PrizeService(ctx.env.DB);
  const result = await service.create(eventId, parsed.data, { admin, requestContext });
  if (!result.ok) return prizeFailureResponse(result.failure, requestId);

  return eventJson(201, result.value, requestId);
};
