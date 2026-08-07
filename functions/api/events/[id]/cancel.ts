// POST /api/events/:id/cancel
//
// One of the six explicit lifecycle actions. There is deliberately no generic
// `PATCH status` endpoint: a state change is a named operation with its own
// preconditions, timestamp and audit action.

import { createTransitionHandler } from '../../../_shared/eventTransitionHandler';

export const onRequestPost = createTransitionHandler('cancel');