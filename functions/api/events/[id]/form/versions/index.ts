// GET /api/events/:id/form/versions — publication history, newest first
//
// Read-only by construction: this resource has no POST, PATCH or DELETE, and
// the repository behind it has no method that could change a version.

import { error } from '../../../../../_shared/responses';
import { formVersionListQuerySchema } from '../../../../../../shared/schemas';
import { FormPublishingService } from '../../../../../_shared/formPublishingService';
import { EventRepository } from '../../../../../_shared/eventRepository';
import { adminContext, eventJson } from '../../../../../_shared/eventHttp';
import { parseFormPath } from '../../../../../_shared/formHttp';
import type { AdminRequestData } from '../../../../../_shared/context';
import type { EventFormVersionListResponse } from '../../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const params = new URL(ctx.request.url).searchParams;
  const parsed = formVersionListQuerySchema.safeParse({
    ...(params.get('page') !== null ? { page: params.get('page') } : {}),
    ...(params.get('pageSize') !== null ? { pageSize: params.get('pageSize') } : {}),
  });
  if (!parsed.success) {
    return error(400, 'INVALID_QUERY', 'Invalid list filters', undefined, { requestId });
  }

  // Scoped: an event that does not exist has no history to leak.
  const event = await new EventRepository(ctx.env.DB).findById(path.id);
  if (!event) {
    return error(404, 'EVENT_NOT_FOUND', 'Event not found', undefined, { requestId });
  }

  const service = new FormPublishingService(ctx.env.DB);
  const { items, currentVersionId } = await service.listVersions(path.id, parsed.data);

  const body: EventFormVersionListResponse = { items, currentVersionId };
  return eventJson(200, body, requestId);
};
