// GET /api/events/:id/participants
//
// The administrative participants table: searched, filtered and paginated in
// SQL, never in the browser. An event with ten thousand entries must not send
// ten thousand rows so React can hide most of them.
//
// This REPLACES the earlier re-export of the entries listing. Both names still
// exist and both are useful — "participants" is what an operator calls the
// screen, "entries" is what the resource is — but they no longer return the
// same shape: this one carries the administrative disposition, the revision
// token every mutation must echo, and the filters the screen needs.
// `.../entries` keeps its original contract untouched for the registration flow
// that already depends on it.
//
// WHAT THIS RESPONSE DELIBERATELY OMITS: date of birth, phone number and
// answers. A table is left open on a desk; a detail page is opened on purpose
// and audited. The personal data lives behind that click.

import { error } from '../../../../_shared/responses';
import { adminParticipantListQuerySchema } from '../../../../../shared/schemas';
import { ParticipantAdministrationService } from '../../../../_shared/participantAdministrationService';
import { adminContext } from '../../../../_shared/eventHttp';
import {
  participantAdminFailureResponse,
  participantAdminJson,
} from '../../../../_shared/participantAdminHttp';
import { asUuid } from '../../../../_shared/ids';
import type { AdminRequestData } from '../../../../_shared/context';
import type { AdminParticipantListResponse } from '../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const eventId = asUuid((ctx.params as Record<string, string>).id);
  if (!eventId) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  // STRICT parsing. A malformed `status=BANANA` is a 400 rather than a silent
  // fallback to "ALL": quietly widening a filter shows an operator more people
  // than they asked to see and gives them no reason to doubt the answer.
  const params = new URL(ctx.request.url).searchParams;
  const parsed = adminParticipantListQuerySchema.safeParse({
    ...(params.get('page') !== null ? { page: params.get('page') } : {}),
    ...(params.get('pageSize') !== null ? { pageSize: params.get('pageSize') } : {}),
    ...(params.get('q') !== null ? { search: params.get('q') } : {}),
    ...(params.get('eligibility') !== null ? { eligibility: params.get('eligibility') } : {}),
    ...(params.get('status') !== null ? { status: params.get('status') } : {}),
    ...(params.get('formVersionId') !== null
      ? { formVersionId: params.get('formVersionId') }
      : {}),
  });
  if (!parsed.success) {
    // The invalid VALUES are not echoed back: `q` is free text an operator may
    // well have typed an email address into, and a validation message is not a
    // place to reflect one.
    return error(400, 'INVALID_QUERY', 'Invalid list filters', undefined, { requestId });
  }

  const service = new ParticipantAdministrationService(ctx.env.DB);
  const result = await service.list(eventId, {
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    search:
      parsed.data.search && parsed.data.search.length > 0 ? parsed.data.search : null,
    eligibility: parsed.data.eligibility,
    status: parsed.data.status,
    formVersionId: parsed.data.formVersionId ?? null,
  });
  if (!result.ok) return participantAdminFailureResponse(result.failure, requestId);

  const body: AdminParticipantListResponse = result.value;
  return participantAdminJson(200, body, requestId);
};
