// GET /api/events/:id/form/published
//
// The version this event currently serves.
//
// Answers 200 with `publishedVersion: null` rather than 404 when nothing has
// been published: "this event has no published form" is an ordinary, expected
// answer, not a missing resource, and a client should not have to treat it as
// an error to render a badge.

import { error } from '../../../../_shared/responses';
import { FormPublishingService } from '../../../../_shared/formPublishingService';
import { adminContext, eventJson } from '../../../../_shared/eventHttp';
import { parseFormPath, publishFailureResponse } from '../../../../_shared/formHttp';
import type { AdminRequestData } from '../../../../_shared/context';
import type { PublishedFormResponse } from '../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const service = new FormPublishingService(ctx.env.DB);
  const result = await service.currentPublished(path.id);
  if (!result.ok) return publishFailureResponse(result.failure, requestId);

  const body: PublishedFormResponse = { publishedVersion: result.value };
  return eventJson(200, body, requestId);
};
