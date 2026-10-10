// 分页 —— 对应原 Go 版 internal/utils/pagination.go。

export interface Pagination {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  offset: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevPage: number;
  nextPage: number;
  start: number;
  end: number;
  pages: number[]; // 0 表示省略号
}

function seq(start: number, end: number): number[] {
  if (end < start) return [];
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

/** 根据页码、每页条数与总数构造分页对象。 */
export function newPagination(page: number, perPage: number, total: number): Pagination {
  let pp = perPage;
  if (!pp || pp <= 0) pp = 20;
  if (pp < 5) pp = 5;
  if (pp > 200) pp = 200;

  let p = page;
  if (!p || p < 1) p = 1;

  let totalPages = Math.ceil(total / pp);
  if (totalPages === 0) totalPages = 1;
  if (p > totalPages) p = totalPages;

  const pg: Pagination = {
    page: p,
    perPage: pp,
    total,
    totalPages,
    offset: (p - 1) * pp,
    hasPrev: p > 1,
    hasNext: p < totalPages,
    prevPage: p - 1,
    nextPage: p + 1,
    start: 0,
    end: 0,
    pages: [],
  };

  if (total === 0) {
    pg.start = 0;
    pg.end = 0;
  } else {
    pg.start = pg.offset + 1;
    pg.end = pg.offset + pp;
    if (pg.end > total) pg.end = total;
  }

  pg.pages = buildPages(pg);
  return pg;
}

/** 生成页码序列，超过 7 页时用 0 表示省略号。 */
function buildPages(pg: Pagination): number[] {
  if (pg.totalPages <= 7) return seq(1, pg.totalPages);

  const keep = new Set<number>([1, pg.totalPages]);
  for (let i = pg.page - 1; i <= pg.page + 1; i++) {
    if (i >= 1 && i <= pg.totalPages) keep.add(i);
  }
  // 靠近首尾时补齐，避免页码跳动
  if (pg.page <= 3) {
    keep.add(2);
    keep.add(3);
    keep.add(4);
  }
  if (pg.page >= pg.totalPages - 2) {
    keep.add(pg.totalPages - 1);
    keep.add(pg.totalPages - 2);
    keep.add(pg.totalPages - 3);
  }

  const out: number[] = [];
  let prev = 0;
  for (let i = 1; i <= pg.totalPages; i++) {
    if (!keep.has(i)) continue;
    if (prev !== 0 && i - prev > 1) out.push(0); // 省略号
    out.push(i);
    prev = i;
  }
  return out;
}

/** 从查询参数解析页码。 */
export function parsePage(raw: string | null | undefined): number {
  const n = Number((raw ?? "").trim());
  if (!Number.isInteger(n) || n < 1) return 1;
  return n;
}

/** 从查询参数解析每页条数。 */
export function parsePerPage(raw: string | null | undefined): number {
  const n = Number((raw ?? "").trim());
  if (!Number.isInteger(n)) return 20;
  return [10, 20, 50, 100].includes(n) ? n : 20;
}

/** 解析可选的正整数（如筛选用的分类 ID）。 */
export function parseInt64(raw: string | null | undefined): number | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** 解析整数，失败时返回默认值。 */
export function parseIntSafe(raw: string | null | undefined, fallback: number): number {
  const t = (raw ?? "").trim();
  if (t === "") return fallback;
  const n = Number(t);
  return Number.isInteger(n) ? n : fallback;
}

/** 解析浮点数，失败时返回默认值。 */
export function parseFloatSafe(raw: string | null | undefined, fallback: number): number {
  const t = (raw ?? "").trim();
  if (t === "") return fallback;
  const n = Number(t);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 校验数字表单字段：空值视为「未填」放行，非法输入返回字段错误文案。
 *
 * 绝不能静默归零落库 ——「进价填成 12,000 → 以 0 元落库且毫无提示」
 * 正是数据错误的经典来源。
 */
export function numberFieldError(raw: string | null | undefined, label: string, integer: boolean): string {
  const t = (raw ?? "").trim();
  if (t === "") return "";
  const n = Number(t);
  const ok = Number.isFinite(n) && (!integer || Number.isInteger(n));
  if (ok) return "";
  return integer ? `${label}必须是整数` : `${label}不是有效的数字`;
}
