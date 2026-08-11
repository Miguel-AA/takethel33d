// POST /api/events/:id/results/publish
//
// Making the winners public. The second irreversible act in the system, after
// the draw itself.
//
// A NAMED ACTION, not a `PATCH { published: true }`. The difference is the same
// one every lifecycle endpoint in this application draws: a patch would accept
// whatever the caller named, and there is nothing here a caller may name. The
// winners come from the draw, their public names from `formatPublicWinnerName`,
// the prize names from the snapshots taken when they were won, the actor from
// the session and the instant from the server clock.
//
// THERE IS NO COUNTERPART. No `unpublish`, no `DELETE`, no `PATCH`. A withdrawn
// publication would mean somebody was publicly named a winner and then unnamed,
// which is not a correction but a second announcement — so the capability does
// not exist at any layer: not here, not in the service, not in the repository,
// and not in the schema.

import { error } from '../../../../_shared/responses';
import { publishResultsSchema } from '../../../../../shared/schemas';
import { ResultsService } from '../../../../_shared/resultsService';
import { adminContext, readEventBody } from '../../../../_shared/eventHttp';
import { resultFailureResponse, resultJson } from '../../../../_shared/resultHttp';
import { validationFields } from '../../../../_shared/formHttp';
import { asUuid } from '../../../../_shared/ids';
import type { AdminRequestData } from '../../../../_shared/context';
import type { PublishResultsResponse } from '../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestPost: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { admin, requestContext, requestId } = adminContext(ctx.data, ctx.request);

  const eventId = asUuid((ctx.params as Record<string, string>).id);
  if (!eventId) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  // `allowEmpty` because a parameterless action should not demand a payload
  // with nothing in it. The content-type and size guards still apply whenever a
  // body IS sent, and the strict schema below refuses anything inside it.
  const body = await readEventBody(ctx.request, requestId, { allowEmpty: true });
  if (!body.ok) return body.response;

  const parsed = publishResultsSchema.safeParse(body.value);
  if (!parsed.success) {
    return error(
      400,
      'VALIDATION_ERROR',
      'Publishing takes no parameters',
      validationFields(parsed.error.issues),
      { requestId },
    );
  }

  const result = await new ResultsService(ctx.env.DB).publish(eventId, {
    admin,
    requestContext,
  });
  if (!result.ok) return resultFailureResponse(result.failure, requestId);

  const response: PublishResultsResponse = { results: result.value.results };
  // 201 when this request published; 200 when it already had been.
  //
  // A RETRY IS NOT AN ERROR. A lost response or a double submit asks for these
  // results to be public, and they are public — so the answer is the record,
  // identical to the first one, and the status code carries the only
  // difference.
  return resultJson(result.value.created ? 201 : 200, response, requestId);
};
