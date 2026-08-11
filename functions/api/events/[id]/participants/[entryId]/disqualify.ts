// POST /api/events/:id/participants/:entryId/disqualify
//
// Removing a participation from consideration.
//
// A NAMED ACTION, not a generic `PATCH { status }`. The difference matters: a
// patch endpoint would accept any status the caller named — promoting somebody
// who never qualified to ELIGIBLE, or writing DISQUALIFIED without recording
// what it replaced. This endpoint can do exactly one thing, the previous status
// is read from the row rather than supplied, and the actor comes from the
// session.
//
// The verdict is untouched. `calculated_age`, `age_eligible`,
// `overall_eligible` and `eligibility_reason` are not in the statement's SET
// list: what was decided when somebody entered is history, and disqualification
// is a separate, later fact recorded alongside it.

import { error } from '../../../../../_shared/responses';
import { disqualifyEntrySchema } from '../../../../../../shared/schemas';
import { ParticipantAdministrationService } from '../../../../../_shared/participantAdministrationService';
import { adminContext, readEventBody } from '../../../../../_shared/eventHttp';
import {
  participantAdminFailureResponse,
  participantAdminJson,
} from '../../../../../_shared/participantAdminHttp';
import { validationFields } from '../../../../../_shared/formHttp';
import { asUuid } from '../../../../../_shared/ids';
import type { AdminRequestData } from '../../../../../_shared/context';
import type { ParticipantMutationResponse } from '../../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestPost: PagesFunction<Env, 'id' | 'entryId', AdminRequestData> = async (
  ctx,
) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const params = ctx.params as Record<string, string>;
  const eventId = asUuid(params.id);
  const entryId = asUuid(params.entryId);
  if (!eventId || !entryId) {
    return error(400, 'INVALID_QUERY', 'Invalid identifiers', undefined, { requestId });
  }

  const body = await readEventBody(ctx.request, requestId);
  if (!body.ok) return body.response;

  // `.strict()` is the mass-assignment defence: `status`,
  // `preDisqualificationStatus`, `disqualifiedAt`, `disqualifiedByAdminId` and
  // `revision` are a REJECTION rather than a silently ignored extra key.
  const parsed = disqualifyEntrySchema.safeParse(body.value);
  if (!parsed.success) {
    return error(
      400,
      'VALIDATION_ERROR',
      'Invalid disqualification payload',
      validationFields(parsed.error.issues),
      { requestId },
    );
  }

  const service = new ParticipantAdministrationService(ctx.env.DB);
  const result = await service.disqualify(
    eventId,
    entryId,
    { expectedRevision: parsed.data.expectedRevision, reason: parsed.data.reason },
    { admin, requestContext },
  );
  if (!result.ok) return participantAdminFailureResponse(result.failure, requestId);

  const response: ParticipantMutationResponse = { participant: result.value };
  return participantAdminJson(200, response, requestId);
};
