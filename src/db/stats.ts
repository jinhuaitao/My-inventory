// 统计与报表 —— 对应原 Go 版 internal/services/stats.go。

import { addDaysUtc, localDateString, localShortDate, parseLocalDate, startOfDayUtc, startOfMonthUtc } from "../lib/time";
import type { CategoryStat, DashboardStats, ProductStat, StockMovement, TrendPoint } from "../types";
import { MOVEMENT_SELECT } from "./movements";
import { Store } from "./store";

/** 取 batch 结果里第一条记录。 */
function pick<T>(res: D1Result<T> | undefined): T | undefined {
  return res?.results?.[0];
}

export interface MovementSummary {
  inQuantity: number;
  outQuantity: number;
  inAmount: number;
  outAmount: number;
}

declare module "./store" {
  interface Store {
    dashboardStats(): Promise<DashboardStats>;
    movementTrend(days: number): Promise<TrendPoint[]>;
    categoryStats(limit: number): Promise<CategoryStat[]>;
    topProductsByValue(limit: number): Promise<ProductStat[]>;
    topMovingProducts(days: number, limit: number): Promise<ProductStat[]>;
    recentMovements(limit: number): Promise<StockMovement[]>;
    summary(startDate: string, endDate: string): Promise<MovementSummary>;
  }
}

// ---------------------------------------------------------------------------
// 仪表盘
// ---------------------------------------------------------------------------

/**
 * 汇总仪表盘所需的全部核心指标。
 *
 * 12 条查询放进一个 batch：D1 会把它们合并成一次往返，
 * 比逐个 await 少 11 次网络往返 —— 仪表盘是访问最频繁的页面。
 * batch 是隐式事务，但这里全是只读语句，不存在锁竞争。
 */
Store.prototype.dashboardStats = async function (this: Store): Promise<DashboardStats> {
  const today = startOfDayUtc().toISOString();
  const month = startOfMonthUtc().toISOString();

  const results = await this.db.batch<Record<string, number>>([
    this.db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status != 'archived'`),
    this.db.prepare(`SELECT COUNT(*) AS n FROM categories`),
    this.db.prepare(`SELECT COUNT(*) AS n FROM suppliers`),
    this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`),
    this.db.prepare(`SELECT COUNT(*) AS n FROM stock_movements`),
    this.db.prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS totalStock,
              COALESCE(SUM(quantity * cost_price), 0) AS stockValue
         FROM products WHERE status != 'archived'`,
    ),
    // ⚠️ 口径必须与预警列表（ProductFilter.lowStockOnly）完全一致：
    // 都统计 quantity <= safety_stock，缺货商品也算在内。
    // 早先这里多了一个 quantity > 0，把缺货商品排除在计数之外，
    // 于是仪表盘徽标显示 5、点进去的列表却有 8 条 —— 用户只会认为
    // 有一半数据没加载出来。缺货是「低库存」里更严重的一档，
    // 单独用 outOfStockCount 呈现，两者是包含关系而非并列关系。
    this.db.prepare(
      `SELECT COUNT(*) AS n FROM products WHERE status != 'archived' AND quantity <= safety_stock`,
    ),
    this.db.prepare(
      `SELECT COUNT(*) AS n FROM products WHERE status != 'archived' AND quantity <= 0`,
    ),
    this.db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_movements
          WHERE type = 'in' AND created_at >= ?`,
      )
      .bind(today),
    this.db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_movements
          WHERE type = 'out' AND created_at >= ?`,
      )
      .bind(today),
    this.db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_movements
          WHERE type = 'in' AND created_at >= ?`,
      )
      .bind(month),
    this.db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_movements
          WHERE type = 'out' AND created_at >= ?`,
      )
      .bind(month),
  ]);

  const totalStockRow = pick(results[5]);
  return {
    totalProducts: pick(results[0])?.n ?? 0,
    totalCategories: pick(results[1])?.n ?? 0,
    totalSuppliers: pick(results[2])?.n ?? 0,
    totalUsers: pick(results[3])?.n ?? 0,
    totalMovements: pick(results[4])?.n ?? 0,
    totalStock: totalStockRow?.totalStock ?? 0,
    stockValue: totalStockRow?.stockValue ?? 0,
    lowStockCount: pick(results[6])?.n ?? 0,
    outOfStockCount: pick(results[7])?.n ?? 0,
    todayIn: pick(results[8])?.n ?? 0,
    todayOut: pick(results[9])?.n ?? 0,
    monthIn: pick(results[10])?.n ?? 0,
    monthOut: pick(results[11])?.n ?? 0,
  };
};

/** 返回最近 days 天（含今天）的每日出入库数量。 */
Store.prototype.movementTrend = async function (this: Store, days: number): Promise<TrendPoint[]> {
  let n = days;
  if (!n || n <= 0) n = 7;
  if (n > 90) n = 90;

  const today = startOfDayUtc();
  const start = addDaysUtc(today, -(n - 1));

  const rows = await this.db
    .prepare(
      `SELECT created_at AS createdAt, type, quantity
         FROM stock_movements
        WHERE created_at >= ? AND type IN ('in', 'out')`,
    )
    .bind(start.toISOString())
    .all<{ createdAt: string; type: string; quantity: number }>();

  const buckets = new Map<string, { in: number; out: number }>();
  for (const row of rows.results ?? []) {
    const key = localDateString(new Date(row.createdAt));
    let b = buckets.get(key);
    if (!b) {
      b = { in: 0, out: 0 };
      buckets.set(key, b);
    }
    if (row.type === "in") b.in += row.quantity;
    else b.out += row.quantity;
  }

  const out: TrendPoint[] = [];
  for (let i = 0; i < n; i++) {
    const day = addDaysUtc(start, i);
    const b = buckets.get(localDateString(day));
    out.push({
      label: localShortDate(day),
      in: b?.in ?? 0,
      out: b?.out ?? 0,
    });
  }
  return out;
};

/** 返回各分类的商品数量与库存价值，用于占比图。 */
Store.prototype.categoryStats = async function (this: Store, limit: number): Promise<CategoryStat[]> {
  const n = limit > 0 ? limit : 8;
  const rows = await this.db
    .prepare(
      `SELECT COALESCE(c.name, '未分类') AS name,
              COUNT(p.id) AS count,
              COALESCE(SUM(p.quantity * p.cost_price), 0) AS value
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.status != 'archived'
        GROUP BY p.category_id
        ORDER BY value DESC
        LIMIT ?`,
    )
    .bind(n)
    .all<CategoryStat>();
  return rows.results ?? [];
};

/** 返回库存价值最高的商品。 */
Store.prototype.topProductsByValue = async function (this: Store, limit: number): Promise<ProductStat[]> {
  const n = limit > 0 ? limit : 8;
  const rows = await this.db
    .prepare(
      `SELECT name, sku, quantity, quantity * cost_price AS value
         FROM products
        WHERE status != 'archived'
        ORDER BY value DESC, quantity DESC
        LIMIT ?`,
    )
    .bind(n)
    .all<ProductStat>();
  return rows.results ?? [];
};

/** 返回最近 days 天内出库量最大的商品。 */
Store.prototype.topMovingProducts = async function (
  this: Store,
  days: number,
  limit: number,
): Promise<ProductStat[]> {
  const d = days > 0 ? days : 30;
  const n = limit > 0 ? limit : 8;
  const since = addDaysUtc(startOfDayUtc(), -d).toISOString();

  const rows = await this.db
    .prepare(
      `SELECT p.name AS name, p.sku AS sku,
              CAST(COALESCE(SUM(m.quantity), 0) AS INTEGER) AS quantity,
              COALESCE(SUM(m.quantity * m.unit_price), 0) AS value
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
        WHERE m.type = 'out' AND m.created_at >= ?
        GROUP BY m.product_id
        ORDER BY quantity DESC
        LIMIT ?`,
    )
    .bind(since, n)
    .all<ProductStat>();
  return rows.results ?? [];
};

/** 返回最近的库存操作记录。 */
Store.prototype.recentMovements = async function (this: Store, limit: number): Promise<StockMovement[]> {
  const n = limit > 0 ? limit : 10;
  const rows = await this.db
    .prepare(`${MOVEMENT_SELECT} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`)
    .bind(n)
    .all<StockMovement>();
  return rows.results ?? [];
};

/** 统计给定日期区间（本地时区）的出入库汇总。 */
Store.prototype.summary = async function (
  this: Store,
  startDate: string,
  endDate: string,
): Promise<MovementSummary> {
  const where: string[] = ["1=1"];
  const args: unknown[] = [];

  const start = parseLocalDate(startDate);
  if (start) {
    where.push("created_at >= ?");
    args.push(start.toISOString());
  }
  const end = parseLocalDate(endDate);
  if (end) {
    where.push("created_at < ?");
    args.push(addDaysUtc(end, 1).toISOString());
  }

  const row = await this.db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'in'  THEN quantity ELSE 0 END), 0) AS inQuantity,
         COALESCE(SUM(CASE WHEN type = 'out' THEN quantity ELSE 0 END), 0) AS outQuantity,
         COALESCE(SUM(CASE WHEN type = 'in'  THEN quantity * unit_price ELSE 0 END), 0) AS inAmount,
         COALESCE(SUM(CASE WHEN type = 'out' THEN quantity * unit_price ELSE 0 END), 0) AS outAmount
       FROM stock_movements WHERE ${where.join(" AND ")}`,
    )
    .bind(...args)
    .first<MovementSummary>();

  return {
    inQuantity: row?.inQuantity ?? 0,
    outQuantity: row?.outQuantity ?? 0,
    inAmount: row?.inAmount ?? 0,
    outAmount: row?.outAmount ?? 0,
  };
};
