// GET /api/audit/:id — auth
//
// Single audit entry. Read-only: there is no PUT, PATCH or DELETE anywhere for
// this resource, so the trail cannot be rewritten through the API.

import { error, json } from '../../_shared/responses';
import {
  actorFrom,
  requireAdmin,
  requireRequestContext,
  type AdminRequestData,
} from '../../_shared/context';
import { AuditService } from '../../_shared/auditService';
import { asUuid } from '../../_shared/ids';

type Env = {
  DB: D1Database;
};

export const onRequestGet: PagesFunction<Env, 'id', AdminRequestData> = async (ctx) => {
  const admin = requireAdmin(ctx.data);
  const requestContext = requireRequestContext(ctx.data, ctx.request);
  const { requestId } = requestContext;

  const id = asUuid(ctx.params.id);
  if (!id) {
    // A malformed id is rejected before it reaches a query.
    return error(400, 'INVALID_QUERY', 'Invalid audit log id', undefined, { requestId });
  }

  const audit = new AuditService(ctx.env.DB);
  const entry = await audit.findById(id);
  if (!entry) {
    return error(404, 'NOT_FOUND', 'Audit log not found', undefined, { requestId });
  }

  // Reading a specific record is itself auditable — but viewing an
  // AUDIT_LOG_VIEWED row must not generate another one. Without this guard,
  // opening the newest entry would append a record, which an admin would then
  // see and open, appending another: an operator-driven chain that grows the
  // table indefinitely. Skipping self-referential views breaks the loop while
  // preserving the signal for every real entity.
  if (entry.action !== 'AUDIT_LOG_VIEWED') {
    ctx.waitUntil(
      audit
        .record({
          action: 'AUDIT_LOG_VIEWED',
          entityType: 'AUDIT_LOG',
          entityId: entry.id,
          actor: actorFrom(admin),
          requestContext,
          metadata: { viewedAction: entry.action, viewedEntityType: entry.entityType },
        })
        .catch(() => {}),
    );
  }

  return json(200, entry, [
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestId],
  ]);
};
