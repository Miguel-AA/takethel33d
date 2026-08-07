// Factory for the six lifecycle endpoints.
//
// Each transition differs only in which action it performs, so they share one
// handler rather than six near-identical copies that could drift apart in their
// validation or error mapping.

import { error } from './responses';
import { eventTransitionSchema } from '../../shared/schemas';
import { EventLifecycleService } from './eventService';
import { asUuid } from './ids';
import { adminContext, eventJson, failureResponse, readEventBody } from './eventHttp';
import type { AdminRequestData } from './context';
import type { EventTransitionAction, EventTransitionResponse } from '../../shared/types';

type Env = {
  DB: D1Database;
};

/**
 * Builds the POST handler for one lifecycle action.
 *
 * A transition takes no parameters, so an empty body is accepted; when a body
 * IS sent it must be JSON, must be within the size limit, and may carry
 * `expectedRevision` to make the action conditional.
 */
export function createTransitionHandler(
  action: EventTransitionAction,
): PagesFunction<Env, 'id', AdminRequestData> {
  return async (ctx) => {
    const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

    const id = asUuid(ctx.params.id);
    if (!id) {
      return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
    }

    const body = await readEventBody(ctx.request, requestId, { allowEmpty: true });
    if (!body.ok) return body.response;

    const parsed = eventTransitionSchema.safeParse(body.value);
    if (!parsed.success) {
      return error(400, 'VALIDATION_ERROR', 'Invalid transition payload', undefined, {
        requestId,
      });
    }

    const service = new EventLifecycleService(ctx.env.DB);
    const result = await service.transition(
      id,
      action,
      { admin, requestContext },
      parsed.data.expectedRevision,
    );
    if (!result.ok) return failureResponse(result.failure, requestId);

    const response: EventTransitionResponse = { event: result.value };
    return eventJson(200, response, requestId);
  };
}
