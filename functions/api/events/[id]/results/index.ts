// GET /api/events/:id/results
//
// What happened, as an administrator sees it: the draw, its winners with the
// email addresses needed to hand a prize over, whether the results have been
// published, and whether the event has been filed away.
//
// READ-ONLY, and the whole phase is. The winners come from `draw_assignments`
// and the prize names from the snapshots taken when they were won — nothing on
// this path consults the current prize table, re-derives a candidate population
// or touches the draw.
//
// Under `PROTECTED_ROUTES` by way of `/api/events`: this body carries names and
// email addresses, and the public projection is a different endpoint with a
// different shape.

import { error } from '../../../../_shared/responses';
import { ResultsService } from '../../../../_shared/resultsService';
import { adminContext } from '../../../../_shared/eventHttp';
import { resultFailureResponse, resultJson } from '../../../../_shared/resultHttp';
import { asUuid } from '../../../../_shared/ids';
import type { AdminRequestData } from '../../../../_shared/context';
import type { AdminEventResults } from '../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const eventId = asUuid((ctx.params as Record<string, string>).id);
  if (!eventId) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const result = await new ResultsService(ctx.env.DB).loadAdminResults(eventId);
  if (!result.ok) return resultFailureResponse(result.failure, requestId);

  const body: AdminEventResults = result.value;
  return resultJson(200, body, requestId);
};
