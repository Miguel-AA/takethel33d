// POST /api/events/:id/prizes/:prizeId/archive
//
// An explicit status action. There is deliberately no generic `PATCH status`:
// each change has its own source states, audit action and permissions.

import { createPrizeTransitionHandler } from '../../../../../_shared/prizeTransitionHandler';

export const onRequestPost = createPrizeTransitionHandler('archive');