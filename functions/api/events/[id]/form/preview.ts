// POST /api/events/:id/form/preview
//
// Renders the draft as a participant would meet it, and reports everything
// publishing will later refuse. Nothing is stored, no participant is created
// and no answer is accepted — this phase builds the form and stops there.
//
// POST rather than GET because it is an action on a specific revision, and
// because a preview must never be cached.

import { error } from '../../../../_shared/responses';
import { FormDraftService } from '../../../../_shared/formDraftService';
import { adminContext, eventJson } from '../../../../_shared/eventHttp';
import { formFailureResponse, parseFormPath } from '../../../../_shared/formHttp';
import type { AdminRequestData } from '../../../../_shared/context';
import type { FormPreviewResponse } from '../../../../../shared/types';

type Env = { DB: D1Database };

export const onRequestPost: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const { requestId } = adminContext(ctx.data, ctx.request);

  const path = parseFormPath(ctx.params as Record<string, string>, 'id');
  if (!path) {
    return error(400, 'INVALID_QUERY', 'Invalid event id', undefined, { requestId });
  }

  // Read-only, like every other path into the draft. Previewing a form that
  // does not exist yet must not bring one into being.
  const service = new FormDraftService(ctx.env.DB);
  const result = await service.find(path.id);
  if (!result.ok) return formFailureResponse(result.failure, requestId);
  if (!result.value.draft) {
    return formFailureResponse({ code: 'FORM_DRAFT_NOT_FOUND' }, requestId);
  }

  const body: FormPreviewResponse = service.buildPreview(result.value.draft);
  return eventJson(200, body, requestId);
};
