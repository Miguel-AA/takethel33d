// GET  /api/events — paginated listing
// POST /api/events — create a draft
//
// Both require an authenticated administrator (the middleware protects
// `/api/events`), and both answer with typed errors and a request id.

import { error } from '../../_shared/responses';
import { createEventSchema, eventListQuerySchema } from '../../../shared/schemas';
import { EventLifecycleService } from '../../_shared/eventService';
import { adminContext, eventJson, failureResponse, readEventBody } from '../../_shared/eventHttp';
import type { AdminRequestData } from '../../_shared/context';
import type { EventListResponse } from '../../../shared/types';

type Env = {
  DB: D1Database;
};

export const onRequestGet: PagesFunction<Env, never, AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);
  const params = new URL(ctx.request.url).searchParams;

  // Parsed through the shared schema so the allowlists for `status`, `sort`,
  // `direction` and `archived` are enforced in one place. An unknown value is a
  // 400, never a silently ignored filter that would widen the result set.
  const parsed = eventListQuerySchema.safeParse({
    ...(params.get('page') !== null ? { page: params.get('page') } : {}),
    ...(params.get('pageSize') !== null ? { pageSize: params.get('pageSize') } : {}),
    ...(params.get('status') ? { status: params.get('status') } : {}),
    ...(params.get('search') ? { search: params.get('search') } : {}),
    ...(params.get('archived') ? { archived: params.get('archived') } : {}),
    ...(params.get('sort') ? { sort: params.get('sort') } : {}),
    ...(params.get('direction') ? { direction: params.get('direction') } : {}),
  });

  if (!parsed.success) {
    return error(400, 'INVALID_QUERY', 'Invalid list filters', undefined, { requestId });
  }

  const service = new EventLifecycleService(ctx.env.DB);
  const { items, total } = await service.list(parsed.data);

  const body: EventListResponse = {
    items,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.pageSize)),
  };

  return eventJson(200, body, requestId);
};

export const onRequestPost: PagesFunction<Env, never, AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  // `.strict()` is what refuses `status`, `createdBy`, `revision` and any other
  // field a client might try to mass-assign.
  const parsed = createEventSchema.safeParse(body.value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || 'body';
      fields[path] = issue.message;
    }
    return error(400, 'VALIDATION_ERROR', 'Invalid event payload', fields, { requestId });
  }

  const service = new EventLifecycleService(ctx.env.DB);
  const result = await service.create(parsed.data, { admin, requestContext });
  if (!result.ok) return failureResponse(result.failure, requestId);

  return eventJson(201, result.value, requestId);
};
