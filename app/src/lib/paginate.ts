export interface PageMeta {
  total: number; page: number; limit: number; pages: number
  hasPrev: boolean; hasNext: boolean
}

export function buildMeta(total: number, page: number, limit: number): PageMeta {
  const pages = Math.ceil(total / limit)
  return { total, page, limit, pages, hasPrev: page > 1, hasNext: page < pages }
}

export function getPagination(pageStr: unknown, limitStr: unknown, maxLimit = 100) {
  const page  = Math.max(1, parseInt(String(pageStr  ?? "1"),  10) || 1)
  const limit = Math.min(maxLimit, Math.max(1, parseInt(String(limitStr ?? "20"), 10) || 20))
  const skip  = (page - 1) * limit
  return { page, limit, skip }
}
