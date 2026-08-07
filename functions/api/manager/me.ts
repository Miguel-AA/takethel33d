// GET /api/manager/me — auth
//
// Returns the authenticated administrator. This is the SPA's only source of
// truth for "am I signed in?", because the session cookie is HttpOnly and the
// client cannot inspect it.

import { error, json } from '../../_shared/responses';
import { requireAdmin, type AdminRequestData } from '../../_shared/context';
import { AdminRepository, rowToAdminUser } from '../../_shared/adminRepository';
import type { AdminMeResponse } from '../../../shared/types';

type Env = {
  DB: D1Database;
};

export const onRequestGet: PagesFunction<Env, never, AdminRequestData> = async (
  ctx,
) => {
  const actor = requireAdmin(ctx.data);

  // The middleware already proved the session is valid and who owns it. The
  // row is re-read here so the response carries real timestamps rather than
  // placeholders; `rowToAdminUser` is what guarantees no hash leaks out.
  const row = await new AdminRepository(ctx.env.DB).findById(actor.id);
  if (!row) {
    // The session referenced an admin that no longer exists: treat as
    // unauthenticated rather than returning a half-built actor.
    return error(401, 'SESSION_INVALID', 'Session owner no longer exists');
  }

  const body: AdminMeResponse = { admin: rowToAdminUser(row) };
  return json(200, body, { 'Cache-Control': 'no-store' });
};
