import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { POLL_INTERVAL_MS, queryKeys } from '../lib/queryKeys';

export function useAttendees(params: {
  search: string;
  page: number;
  pageSize: number;
}) {
  return useQuery({
    queryKey: queryKeys.attendees(params.search, params.page, params.pageSize),
    queryFn: () => api.listAttendees(params),
    refetchInterval: POLL_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });
}
