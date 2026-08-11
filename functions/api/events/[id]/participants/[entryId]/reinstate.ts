// POST /api/events/:id/participants/:entryId/reinstate
//
// Undoing a disqualification.
//
// The destination is NOT a parameter. It is `pre_disqualification_status`, read
// off the row, so an entry that never qualified returns to INELIGIBLE and one
// recorded before eligibility existed returns to SUBMITTED. Accepting a target
// status from the caller would let an administrator promote somebody the rules
// excluded — and re-running the age rule instead would answer a different
// question, against today's date and today's `minimum_age`, potentially handing
// somebody a different verdict from the one they were originally given.
//
// No reason is required. "Undo" is not a new decision about a person; the
// original reason and the fact of the reversal both survive in the audit trail.

import { error } from '../../../../../_shared/responses';
import { reinstateEntrySchema } from '../../../../../../shared/schemas';
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

  const parsed = reinstateEntrySchema.safeParse(body.value);
  if (!parsed.success) {
    return error(
      400,
      'VALIDATION_ERROR',
      'Invalid reinstatement payload',
      validationFields(parsed.error.issues),
      { requestId },
    );
  }

  const service = new ParticipantAdministrationService(ctx.env.DB);
  const result = await service.reinstate(
    eventId,
    entryId,
    { expectedRevision: parsed.data.expectedRevision },
    { admin, requestContext },
  );
  if (!result.ok) return participantAdminFailureResponse(result.failure, requestId);

  const response: ParticipantMutationResponse = { participant: result.value };
  return participantAdminJson(200, response, requestId);
};
