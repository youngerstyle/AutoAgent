export interface TeamDirectoryPage<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
}

export const TEAM_DIRECTORY_PAGE_SIZE = 8;

export function paginateTeamDirectory<T>(
  items: T[],
  requestedPage: number,
  pageSize: number
): TeamDirectoryPage<T> {
  const safePageSize = Math.max(1, pageSize);
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const start = page * safePageSize;

  return {
    items: items.slice(start, start + safePageSize),
    page,
    pageCount,
    total: items.length
  };
}
