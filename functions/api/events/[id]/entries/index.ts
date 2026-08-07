// Entries of one event.
//
//   GET  — who has taken part, paginated.
//   POST — record a participation.
//
// BOTH ARE ADMIN-ONLY. This is not the public registration route: that arrives
// with the wizard in a later phase, on its own path, with its own rate limits.
// What this endpoint does have is the SAME domain rules the public one will —
// the event must be OPEN and inside its registration window, the form must be
// the published version, one entry per identity — so nothing has to be
// tightened later, once rows exist that were written under looser rules.
//
// The request body carries `answers` and nothing else. There is no participant
// object, no version id, no status and no timestamps: the server reads all of
// those off the event and the version it serves.

import { error } from '../../../../_shared/responses';
import {
  createEventEntrySchema,
  eventEntryListQuerySchema,
} from '../../../../../shared/schemas';
import { ParticipantRegistrationService } from '../../../../_shared/participantRegistrationService';
import { adminContext, readEventBody } from '../../../../_shared/eventHttp';
import { entryFailureResponse, entryJson } from '../../../../_shared/entryHttp';
import { parseFormPath, validationFields } from '../../../../_shared/formHttp';
import type { AdminRequestData } from '../../../../_shared/context';
import type {
  CreateEventEntryResponse,
  EventEntryListResponse,
} from '../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const params = new URL(ctx.request.url).searchParams;
  const parsed = eventEntryListQuerySchema.safeParse({
    ...(params.get('page') !== null ? { page: params.get('page') } : {}),
    ...(params.get('pageSize') !== null ? { pageSize: params.get('pageSize') } : {}),
    ...(params.get('search') !== null ? { search: params.get('search') } : {}),
  });
  if (!parsed.success) {
    return error(400, 'INVALID_QUERY', 'Invalid list filters', undefined, { requestId });
  }

  const service = new ParticipantRegistrationService(ctx.env.DB);
  const result = await service.list(path.id, {
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    search: parsed.data.search && parsed.data.search.length > 0 ? parsed.data.search : null,
  });
  if (!result.ok) return entryFailureResponse(result.failure, requestId);

  const body: EventEntryListResponse = result.value;
  return entryJson(200, body, requestId);
};

export const onRequestPost: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  const parsed = createEventEntrySchema.safeParse(body.value);
  if (!parsed.success) {
    return error(
      400,
      'VALIDATION_ERROR',
      'Invalid entry payload',
      validationFields(parsed.error.issues),
      { requestId },
    );
  }

  const service = new ParticipantRegistrationService(ctx.env.DB);
  const result = await service.register(path.id, parsed.data.answers, {
    admin,
    requestContext,
  });
  if (!result.ok) return entryFailureResponse(result.failure, requestId);

  const response: CreateEventEntryResponse = {
    entry: result.value.entry,
    participant: result.value.participant,
    answerCount: result.value.answerCount,
  };
  return entryJson(201, response, requestId);
};
