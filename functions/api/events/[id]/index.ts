// GET    /api/events/:id — detail plus what may be done to it
// PATCH  /api/events/:id — partial update, guarded by revision
// DELETE /api/events/:id — physical removal of a pristine draft only

import { error } from '../../../_shared/responses';
import { updateEventSchema } from '../../../../shared/schemas';
import { EventLifecycleService } from '../../../_shared/eventService';
import { EDITABLE_FIELDS_BY_STATUS } from '../../../../shared/eventLifecycle';
import { AdminRepository } from '../../../_shared/adminRepository';
import { EventRepository } from '../../../_shared/eventRepository';
import { PrizeRepository } from '../../../_shared/prizeRepository';
import { FormVersionRepository } from '../../../_shared/formVersionRepository';
import { asUuid } from '../../../_shared/ids';
import {
  adminContext,
  eventJson,
  failureResponse,
  readEventBody,
} from '../../../_shared/eventHttp';
import type { AdminRequestData } from '../../../_shared/context';
import type { EventDetailResponse } from '../../../../shared/types';

type Env = {
  DB: D1Database;
};

/** Rejects a malformed id before it can reach a query. */
function eventId(raw: unknown): string | null {
  return asUuid(raw);
}

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const id = eventId(ctx.params.id);
  if (!id) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const service = new EventLifecycleService(ctx.env.DB);
  const event = await service.findById(id);
  if (!event) {
    return error(404, 'EVENT_NOT_FOUND', 'Event not found', undefined, { requestId });
  }

  // The draw precondition depends on prizes, so the unit count is resolved
  // here and folded into the action list the UI renders from.
  const activePrizeUnits = await new PrizeRepository(ctx.env.DB).countActiveUnits(id);
  // Resolved, not merely read: the pointer must name a version of THIS event.
  const pointer = await new FormVersionRepository(ctx.env.DB).pointerCondition(id);
  const { available, blocked } = service.describeActions(event, {
    activePrizeUnits,
    publishedFormValid: pointer === 'valid',
  });
  const deletable = service.canDelete(event);
  const hasPrizes = await new EventRepository(ctx.env.DB).hasDependencies(id);

  // Actor names are resolved for display; a deleted admin yields nulls rather
  // than failing the read.
  const admins = new AdminRepository(ctx.env.DB);
  const [createdBy, updatedBy] = await Promise.all([
    admins.findById(event.createdBy),
    admins.findById(event.updatedBy),
  ]);

  const body: EventDetailResponse = {
    event,
    availableActions: available,
    blockedActions: blocked,
    editableFields: [...EDITABLE_FIELDS_BY_STATUS[event.status]],
    // An event holding prizes can only be archived, never deleted — the
    // database enforces it too, but the UI must not offer the button.
    canDelete: deletable.ok && !hasPrizes,
    actors: {
      createdBy: {
        id: event.createdBy,
        displayName: createdBy?.display_name ?? null,
        email: createdBy?.email ?? null,
      },
      updatedBy: {
        id: event.updatedBy,
        displayName: updatedBy?.display_name ?? null,
        email: updatedBy?.email ?? null,
      },
    },
  };

  return eventJson(200, body, requestId);
};

export const onRequestPatch: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const id = eventId(ctx.params.id);
  if (!id) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  const parsed = updateEventSchema.safeParse(body.value);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || 'body';
      fields[path] = issue.message;
    }
    return error(400, 'VALIDATION_ERROR', 'Invalid event payload', fields, { requestId });
  }

  const service = new EventLifecycleService(ctx.env.DB);
  const result = await service.update(id, parsed.data, { admin, requestContext });
  if (!result.ok) return failureResponse(result.failure, requestId);

  return eventJson(200, result.value, requestId);
};

export const onRequestDelete: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const id = eventId(ctx.params.id);
  if (!id) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  // A revision may be supplied to make the delete conditional; DELETE bodies
  // are unusual, so the query string is accepted too. A malformed value is
  // refused rather than ignored — dropping it would silently downgrade a
  // guarded delete into an unguarded one.
  const url = new URL(ctx.request.url);
  const rawRevision = url.searchParams.get('expectedRevision');
  if (rawRevision !== null && !/^[1-9]\d*$/.test(rawRevision)) {
    return error(400, 'INVALID_QUERY', 'Invalid expectedRevision', undefined, { requestId });
  }
  const expectedRevision = rawRevision === null ? undefined : Number(rawRevision);

  const service = new EventLifecycleService(ctx.env.DB);
  const result = await service.remove(id, { admin, requestContext }, expectedRevision);
  if (!result.ok) return failureResponse(result.failure, requestId);

  return eventJson(200, { ok: true, id: result.value.id }, requestId);
};
