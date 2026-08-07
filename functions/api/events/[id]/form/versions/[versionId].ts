// GET /api/events/:id/form/versions/:versionId — one published version
//
// Returns the frozen structure read from the normalized VERSION rows, together
// with the stored snapshot. The rows are the runtime source; the snapshot is
// evidence. If the two disagree the request FAILS rather than picking one —
// silently preferring either would destroy the only signal that something went
// wrong with a form somebody has already filled in.

import { error } from '../../../../../_shared/responses';
import { FormPublishingService } from '../../../../../_shared/formPublishingService';
import { adminContext, eventJson } from '../../../../../_shared/eventHttp';
import { parseFormPath, publishFailureResponse } from '../../../../../_shared/formHttp';
import { asUuid } from '../../../../../_shared/ids';
import type { AdminRequestData } from '../../../../../_shared/context';
import type { EventFormVersionDetailResponse } from '../../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'id' | 'versionId', AdminRequestData> = async (
  ctx,
) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  const versionId = asUuid((ctx.params as Record<string, string>).versionId);
  if (!path || !versionId) {
    return error(400, 'INVALID_QUERY', 'Invalid identifiers', undefined, { requestId });
  }

  const service = new FormPublishingService(ctx.env.DB);
  // Scoped: a version id belonging to another event resolves to nothing here.
  const result = await service.getVersion(path.id, versionId);
  if (!result.ok) return publishFailureResponse(result.failure, requestId);

  const body: EventFormVersionDetailResponse = {
    version: result.value.version,
    currentPublished: result.value.current,
    snapshot: result.value.record.snapshot,
  };
  return eventJson(200, body, requestId);
};
