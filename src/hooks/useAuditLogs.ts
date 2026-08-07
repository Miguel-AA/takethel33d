import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type AuditQueryParams } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';

/**
 * Paginated audit trail.
 *
 * `keepPreviousData` holds the current page on screen while the next one
 * loads, so paging does not flash an empty table. Unlike the dashboard's
 * metrics this does NOT poll: the audit log is reviewed, not monitored, and a
 * background poll would add load for no benefit.
 */
export function useAuditLogs(params: AuditQueryParams) {
  return useQuery({
    queryKey: queryKeys.auditLogs(params as Record<string, unknown>),
    queryFn: () => api.listAuditLogs(params),
    placeholderData: keepPreviousData,
  });
}

/** A single entry. Enabled only when an id is selected. */
export function useAuditLog(id: string | null) {
  return useQuery({
    queryKey: queryKeys.auditLog(id ?? ''),
    queryFn: () => api.getAuditLog(id as string),
    enabled: Boolean(id),
    retry: false,
  });
}
