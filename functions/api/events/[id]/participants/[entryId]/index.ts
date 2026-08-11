// GET /api/events/:id/participants/:entryId — one participant's file.
//
// Scoped through the event: an entry id from another event resolves to "not
// found", never to somebody else's row. That scoping is the whole IDOR defence,
// because an entry id is a UUID a client may well have seen elsewhere.
//
// This is the response that carries the most personal data in the system — a
// name, an email address, a phone number, a date of birth and every answer
// somebody gave — so unlike the listing, reading it IS audited. Auditing every
// list render would drown the trail; auditing the moment an administrator opens
// one person's file is exactly the trail worth having.

import { error } from '../../../../../_shared/responses';
import { ParticipantAdministrationService } from '../../../../../_shared/participantAdministrationService';
import { AuditService } from '../../../../../_shared/auditService';
import { adminContext } from '../../../../../_shared/eventHttp';
import {
  participantAdminFailureResponse,
  participantAdminJson,
} from '../../../../../_shared/participantAdminHttp';
import { asUuid } from '../../../../../_shared/ids';
import type { AdminRequestData } from '../../../../../_shared/context';
import type { AdminParticipantDetailResponse } from '../../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'id' | 'entryId', AdminRequestData> = async (
  ctx,
) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  // Both ids are narrowed before either reaches a query. The entry is then
  // resolved THROUGH the event, so a well-formed id from another event is a
  // 404 rather than a read.
  const params = ctx.params as Record<string, string>;
  const eventId = asUuid(params.id);
  const entryId = asUuid(params.entryId);
  if (!eventId || !entryId) {
    return error(400, 'INVALID_QUERY', 'Invalid identifiers', undefined, { requestId });
  }

  const service = new ParticipantAdministrationService(ctx.env.DB);
  const result = await service.detail(eventId, entryId);
  if (!result.ok) return participantAdminFailureResponse(result.failure, requestId);

  // Best-effort: a failed audit write must not deny an administrator the record
  // they are entitled to read, and the failure is reported through the logger
  // rather than swallowed.
  await new AuditService(ctx.env.DB).record({
    action: 'EVENT_ENTRY_VIEWED',
    entityType: 'EVENT_ENTRY',
    entityId: result.value.participant.entryId,
    eventId,
    actor: { id: admin.id, email: admin.email, displayName: admin.displayName },
    requestContext,
    // Identifiers and a count. Never the answers themselves: recording what was
    // read would copy the personal data into an append-only table, so reading a
    // record would quietly duplicate it.
    metadata: {
      participantId: result.value.participant.participant.id,
      formVersionId: result.value.participant.entry.formVersionId,
      answerCount: result.value.participant.answers.length,
    },
  });

  const body: AdminParticipantDetailResponse = {
    participant: result.value.participant,
    eventStatus: result.value.event.status,
  };
  return participantAdminJson(200, body, requestId);
};
