// GET /api/public-events/:slug/results
//
// The published winners. The second unauthenticated read in the system, and the
// only one that outlives its event.
//
// PUBLIC BY OMISSION, exactly as its sibling endpoints are: the middleware is a
// deny-list, `/api/public-events` is not on it, and nothing is added here. An
// allow-list is what would make path traversal dangerous; a deny-list means `..`
// can only ever normalise a path INTO the protected set.
//
// WHAT IT DELIBERATELY DOES NOT CONSULT: `publicVisibility`. That rule hides an
// ARCHIVED event's registration page, and correctly — there is nothing left to
// register for. A published result is a different kind of thing: it was
// announced on purpose, and filing the event away afterwards must not retract
// it. The only question asked here is whether a publication exists.
//
// ONE ANSWER FOR EVERY OTHER CASE. A slug nobody has used, an event that was
// never drawn, and an event drawn but never published all return the same 404.
// Distinguishing them would make this endpoint an oracle for whether a private
// draw has happened — the exact fact an operator withholds by not publishing.

import { ResultsService } from '../../../_shared/resultsService';
import { publicResultJson, resultFailureResponse } from '../../../_shared/resultHttp';
import { requireRequestContext, type AdminRequestData } from '../../../_shared/context';
import type { PublicEventResultsDTO } from '../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'slug', AdminRequestData> = async (ctx) => {
  // The middleware builds this for EVERY request, public or not, so a public
  // response carries the same correlation id an administrative one would and
  // the IP is already hashed. No parallel request-context system is created.
  const { requestId } = requireRequestContext(ctx.data, ctx.request);

  const slug = ctx.params.slug;
  if (typeof slug !== 'string' || slug.length === 0) {
    // The same refusal a valid-but-unpublished slug gets. A distinct "malformed
    // address" answer would leak nothing by itself, but it is one more way for
    // the shape of a reply to differ, and there is nothing to gain from it.
    return resultFailureResponse({ code: 'RESULTS_NOT_AVAILABLE' }, requestId);
  }

  const result = await new ResultsService(ctx.env.DB).loadPublicResults(slug);
  if (!result.ok) return resultFailureResponse(result.failure, requestId);

  const body: PublicEventResultsDTO = result.value;
  return publicResultJson(200, body, requestId);
};
