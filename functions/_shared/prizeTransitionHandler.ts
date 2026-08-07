// Factory for the three prize status endpoints.
//
// They differ only in which action they perform, so they share one handler
// rather than three near-identical copies that could drift apart.

import { error } from './responses';
import { prizeTransitionSchema } from '../../shared/schemas';
import { PrizeService } from './prizeService';
import { adminContext, eventJson, readEventBody } from './eventHttp';
import { parsePrizePath, prizeFailureResponse } from './prizeHttp';
import type { AdminRequestData } from './context';
import type { PrizeTransitionAction, PrizeMutationResponse } from '../../shared/types';

type Env = {
  DB: D1Database;
};

/**
 * Builds the POST handler for one status action.
 *
 * A status change takes no parameters, so an empty body is accepted; when a
 * body IS sent it must be JSON, within the size limit, and may carry
 * `expectedRevision` to make the action conditional.
 */
export function createPrizeTransitionHandler(
  action: PrizeTransitionAction,
): PagesFunction<Env, 'id' | 'prizeId', AdminRequestData> {
  return async (ctx) => {
    const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

    const path = parsePrizePath(ctx.params as Record<string, string>);
    if (!path) {
      return error(400, 'INVALID_QUERY', 'Invalid identifiers', undefined, { requestId });
    }

    const body = await readEventBody(ctx.request, requestId, { allowEmpty: true });
    if (!body.ok) return body.response;

    const parsed = prizeTransitionSchema.safeParse(body.value);
    if (!parsed.success) {
      return error(400, 'VALIDATION_ERROR', 'Invalid transition payload', undefined, {
        requestId,
      });
    }

    const service = new PrizeService(ctx.env.DB);
    const result = await service.transition(
      path.eventId,
      path.prizeId,
      action,
      { admin, requestContext },
      parsed.data.expectedRevision,
    );
    if (!result.ok) return prizeFailureResponse(result.failure, requestId);

    const response: PrizeMutationResponse = { prize: result.value };
    return eventJson(200, response, requestId);
  };
}
