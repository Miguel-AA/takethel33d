// GET    /api/events/:id/prizes/:prizeId
// PATCH  /api/events/:id/prizes/:prizeId
// DELETE /api/events/:id/prizes/:prizeId

import { error } from '../../../../../_shared/responses';
import { updateEventPrizeSchema } from '../../../../../../shared/schemas';
import { PrizeService } from '../../../../../_shared/prizeService';
import {
  allowedPrizeActions,
  canDeletePrize,
  editableFieldsFor,
} from '../../../../../../shared/prizeLifecycle';
import { adminContext, eventJson, readEventBody } from '../../../../../_shared/eventHttp';
import { parsePrizePath, prizeFailureResponse } from '../../../../../_shared/prizeHttp';
import type { AdminRequestData } from '../../../../../_shared/context';
import type { EventPrizeDetailResponse } from '../../../../../../shared/types';

type Env = {
  DB: D1Database;
};

export const onRequestGet: PagesFunction<Env, 'id' | 'prizeId', AdminRequestData> = async (
  ctx,
) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const path = parsePrizePath(ctx.params as Record<string, string>);
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid identifiers', undefined, { requestId });
  }

  const service = new PrizeService(ctx.env.DB);
  const event = await service.findEvent(path.eventId);
  if (!event) {
    return error(404, 'EVENT_NOT_FOUND', 'Event not found', undefined, { requestId });
  }

  // Scoped lookup: a prize id from another event resolves to nothing here.
  const prize = await service.findPrize(path.eventId, path.prizeId);
  if (!prize) {
    return error(404, 'PRIZE_NOT_FOUND', 'Prize not found', undefined, { requestId });
  }

  const body: EventPrizeDetailResponse = {
    prize,
    allowedActions: allowedPrizeActions(event.status, prize.status),
    editableFields: [...editableFieldsFor(event.status, prize.status)],
    canDelete:
      canDeletePrize(event.status, prize.status) &&
      (await service.deletionBlocker(event, prize)) === null,
    eventStatus: event.status,
  };

  return eventJson(200, body, requestId);
};

export const onRequestPatch: PagesFunction<Env, 'id' | 'prizeId', AdminRequestData> = async (
  ctx,
) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const path = parsePrizePath(ctx.params as Record<string, string>);
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid identifiers', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  const parsed = updateEventPrizeSchema.safeParse(body.value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'body';
      fields[key] = issue.message;
    }
    return error(400, 'VALIDATION_ERROR', 'Invalid prize payload', fields, { requestId });
  }

  const service = new PrizeService(ctx.env.DB);
  const result = await service.update(path.eventId, path.prizeId, parsed.data, {
    admin,
    requestContext,
  });
  if (!result.ok) return prizeFailureResponse(result.failure, requestId);

  return eventJson(200, result.value, requestId);
};

export const onRequestDelete: PagesFunction<Env, 'id' | 'prizeId', AdminRequestData> = async (
  ctx,
) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const path = parsePrizePath(ctx.params as Record<string, string>);
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid identifiers', undefined, { requestId });
  }

  // DELETE bodies are unusual, so the revision guard travels in the query.
  //
  // A malformed value is REFUSED rather than ignored: silently dropping it
  // would turn a guarded delete into an unguarded one, which is the opposite of
  // what the caller asked for.
  const raw = new URL(ctx.request.url).searchParams.get('expectedRevision');
  if (raw !== null && !/^[1-9]\d*$/.test(raw)) {
    return error(400, 'INVALID_QUERY', 'Invalid expectedRevision', undefined, { requestId });
  }
  const expectedRevision = raw === null ? undefined : Number(raw);

  const service = new PrizeService(ctx.env.DB);
  const result = await service.remove(
    path.eventId,
    path.prizeId,
    { admin, requestContext },
    expectedRevision,
  );
  if (!result.ok) return prizeFailureResponse(result.failure, requestId);

  return eventJson(200, { ok: true, id: result.value.id }, requestId);
};
