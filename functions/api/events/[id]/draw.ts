// GET  /api/events/:id/draw — the result, and whether one can be run
// POST /api/events/:id/draw — run it
//
// ONE ROUTE, TWO METHODS, and the asymmetry is the point. GET is a read anyone
// with the admin session may repeat as often as they like. POST is the single
// irreversible act in the system, and it can be performed exactly once per
// event, ever — not because this handler counts, but because `ux_draws_event`
// makes a second one impossible.
//
// WHAT THE CALLER SUPPLIES: an event id in the path, and an empty object. That
// is the whole input. No seed, no candidate list, no winners, no count, no
// prize choice. `runDrawSchema` is `.strict()`, so a caller who sends any of
// those is REFUSED rather than quietly ignored — the difference being that a
// refusal shows up in a test and in a log.
//
// Both methods sit under `PROTECTED_ROUTES`: this is administrative surface,
// and the response names the people who won something.

import { error } from '../../../_shared/responses';
import { runDrawSchema } from '../../../../shared/schemas';
import { DrawService } from '../../../_shared/drawService';
import { adminContext, readEventBody } from '../../../_shared/eventHttp';
import { drawFailureResponse, drawJson } from '../../../_shared/drawHttp';
import { validationFields } from '../../../_shared/formHttp';
import { asUuid } from '../../../_shared/ids';
import type { AdminRequestData } from '../../../_shared/context';
import type { DrawResponse, DrawStatusResponse } from '../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const eventId = asUuid((ctx.params as Record<string, string>).id);
  if (!eventId) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  const result = await new DrawService(ctx.env.DB).status(eventId);
  if (!result.ok) return drawFailureResponse(result.failure, requestId);

  const response: DrawStatusResponse = result.value;
  return drawJson(200, response, requestId);
};

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

  const parsed = runDrawSchema.safeParse(body.value);
  if (!parsed.success) {
    return error(
      400,
      'VALIDATION_ERROR',
      'The draw takes no parameters',
      validationFields(parsed.error.issues),
      { requestId },
    );
  }

  const result = await new DrawService(ctx.env.DB).run(eventId, { admin, requestContext });
  if (!result.ok) return drawFailureResponse(result.failure, requestId);

  const response: DrawResponse = result.value.response;
  // 201 when this request produced the draw, 200 when it already existed.
  //
  // A RETRY IS NOT AN ERROR. A lost response, a double submit or a second tab
  // asks for the same event to be drawn, and it is drawn — so the answer is the
  // result, identical to the first one, and the status code carries the only
  // difference. Refusing with a 409 would tell an operator that something went
  // wrong at the exact moment nothing did.
  return drawJson(result.value.created ? 201 : 200, response, requestId);
};
