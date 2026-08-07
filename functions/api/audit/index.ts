// GET /api/audit — auth
//
// Filtered, paginated listing of the audit trail.
//
// Deliberately NOT audited. A listing already appears in the server logs, and
// recording one row per view would let anyone browsing the page inflate the
// table without bound — and every such row would itself be listable, producing
// a feedback loop. Individual reads ARE audited (see `[id].ts`), which is where
// "who looked at this specific record" actually matters.

import { error, json } from '../../_shared/responses';
import { requireAdmin, requireRequestContext, type AdminRequestData } from '../../_shared/context';
import { AuditService } from '../../_shared/auditService';
import {
  parseDateBound,
  parseEnumParam,
  parsePagination,
  parseUuidParam,
} from '../../_shared/query';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  type AuditListResponse,
} from '../../../shared/types';

type Env = {
  DB: D1Database;
};

export const onRequestGet: PagesFunction<Env, never, AdminRequestData> = async (
  ctx,
) => {
  // Authorization point. Only one role exists today, but the check is explicit
  // so a later phase adds a permission here rather than discovering there was
  // never a place for one.
  requireAdmin(ctx.data);
  const { requestId } = requireRequestContext(ctx.data, ctx.request);

  const params = new URL(ctx.request.url).searchParams;
  const { page, pageSize } = parsePagination(params);

  // Each filter is validated against a closed set or a UUID shape. A malformed
  // value is a 400, never a silently ignored filter that would return more data
  // than the caller asked for.
  const actorAdminId = parseUuidParam(params, 'actorAdminId');
  if (!actorAdminId.ok) {
    return error(400, 'INVALID_QUERY', 'actorAdminId must be a UUID', undefined, {
      requestId,
    });
  }

  const entityId = parseUuidParam(params, 'entityId');
  if (!entityId.ok) {
    return error(400, 'INVALID_QUERY', 'entityId must be a UUID', undefined, {
      requestId,
    });
  }

  const eventId = parseUuidParam(params, 'eventId');
  if (!eventId.ok) {
    return error(400, 'INVALID_QUERY', 'eventId must be a UUID', undefined, {
      requestId,
    });
  }

  const action = parseEnumParam(params, 'action', AUDIT_ACTIONS);
  if (!action.ok) {
    return error(400, 'INVALID_QUERY', 'Unknown action filter', undefined, { requestId });
  }

  const entityType = parseEnumParam(params, 'entityType', AUDIT_ENTITY_TYPES);
  if (!entityType.ok) {
    return error(400, 'INVALID_QUERY', 'Unknown entityType filter', undefined, {
      requestId,
    });
  }

  const from = parseDateBound(params, 'from', 'start');
  if (!from.ok) {
    return error(400, 'INVALID_QUERY', 'from must be a date or ISO timestamp', undefined, {
      requestId,
    });
  }

  const to = parseDateBound(params, 'to', 'end');
  if (!to.ok) {
    return error(400, 'INVALID_QUERY', 'to must be a date or ISO timestamp', undefined, {
      requestId,
    });
  }

  // An inverted range is a mistake, not an empty result: saying so is more
  // useful than returning zero rows and letting the caller guess why.
  if (from.value && to.value && from.value > to.value) {
    return error(400, 'INVALID_QUERY', '`from` must not be after `to`', undefined, {
      requestId,
    });
  }

  const audit = new AuditService(ctx.env.DB);
  const { items, total } = await audit.list({
    page,
    pageSize,
    actorAdminId: actorAdminId.value,
    action: action.value,
    entityType: entityType.value,
    entityId: entityId.value,
    eventId: eventId.value,
    from: from.value,
    to: to.value,
  });

  const body: AuditListResponse = {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };

  return json(200, body, [
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestId],
  ]);
};
