// GET /api/events/:id/participants/summary
//
// The counts above the table, computed in ONE aggregate query.
//
// A separate endpoint rather than a field on the listing, because the two have
// different lifetimes: the list changes with every filter and every page, the
// summary describes the whole event and changes only when somebody is
// disqualified or reinstated. Folding it into the list would recompute six
// aggregates on every keystroke of a search box.
//
// ROUTE PRECEDENCE: this file sits beside `[entryId].ts`, and Cloudflare Pages
// resolves a static segment before a dynamic one — `/participants/summary`
// reaches this handler, not the detail handler with `entryId = "summary"`.
// The detail handler narrows its parameter to a UUID anyway, so even if the
// precedence were ever reversed the request would be a clean 400 rather than a
// lookup for an entry named "summary".

import { error } from '../../../../_shared/responses';
import { ParticipantAdministrationService } from '../../../../_shared/participantAdministrationService';
import { adminContext } from '../../../../_shared/eventHttp';
import {
  participantAdminFailureResponse,
  participantAdminJson,
} from '../../../../_shared/participantAdminHttp';
import { asUuid } from '../../../../_shared/ids';
import type { AdminRequestData } from '../../../../_shared/context';
import type { AdminParticipantSummaryResponse } from '../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const eventId = asUuid((ctx.params as Record<string, string>).id);
  if (!eventId) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const service = new ParticipantAdministrationService(ctx.env.DB);
  const result = await service.summary(eventId);
  if (!result.ok) return participantAdminFailureResponse(result.failure, requestId);

  const body: AdminParticipantSummaryResponse = result.value;
  return participantAdminJson(200, body, requestId);
};
