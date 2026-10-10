// 库存流水 —— 对应原 Go 版 internal/services/movement.go。
//
// 这里是**全部库存变动的唯一入口**：商品库存与流水必须永远一致，
// 所以出入库、盘点、期初建账都只允许经由本文件的方法落库。

import { AppError, conflict, invalidInput, notFound } from "../lib/errors";
import { absInt } from "../lib/format";
import { newPagination, type Pagination } from "../lib/pagination";
import { changedRows, likePattern, nullableId } from "../lib/sql";
import { addDaysUtc, nowUtcIso, parseLocalDate } from "../lib/time";
import {
  movementDirection,
  movementTypeValid,
  type MovementType,
  type StockMovement,
} from "../types";
import { MAX_EXPORT_ROWS, MAX_QUANTITY, Store } from "./store";

/** 乐观锁冲突时的最大重试次数。 */
const MAX_CONFLICT_RETRIES = 3;

export const MOVEMENT_COLUMNS = `m.id, m.product_id AS productId, m.type, m.quantity, m.delta,
  m.unit_price AS unitPrice, m.before_qty AS beforeQty, m.after_qty AS afterQty,
  m.ref_no AS refNo, m.supplier_id AS supplierId, m.operator_id AS operatorId,
  m.note, m.created_at AS createdAt,
  COALESCE(p.name, '') AS productName,
  COALESCE(p.sku, '')  AS productSku,
  COALESCE(p.unit, '') AS productUnit,
  CASE WHEN u.full_name IS NULL OR u.full_name = ''
       THEN COALESCE(u.username, '已删除用户')
       ELSE u.full_name END AS operatorName,
  COALESCE(s.name, '') AS supplierName`;

export const MOVEMENT_SELECT = `SELECT ${MOVEMENT_COLUMNS}
  FROM stock_movements m
  LEFT JOIN products  p ON p.id = m.product_id
  LEFT JOIN users     u ON u.id = m.operator_id
  LEFT JOIN suppliers s ON s.id = m.supplier_id`;

/** 一次出入库操作所需的参数。 */
export interface MovementInput {
  productId: number;
  /** 正数，表示变动数量。 */
  quantity: number;
  unitPrice: number;
  refNo: string;
  supplierId: number | null;
  operatorId: number;
  note: string;
}

export interface MovementFilter {
  /** 商品名 / SKU / 单号。 */
  keyword?: string;
  type?: string;
  productId?: number | null;
  operatorId?: number | null;
  /** YYYY-MM-DD（本地时区）。 */
  startDate?: string;
  /** YYYY-MM-DD（本地时区，含当天）。 */
  endDate?: string;
  page?: number;
  perPage?: number;
}

declare module "./store" {
  interface Store {
    applyMovement(type: MovementType, input: MovementInput): Promise<StockMovement>;
    adjustStock(
      productId: number,
      targetQty: number,
      note: string,
      operatorId: number,
    ): Promise<StockMovement>;
    listMovements(filter: MovementFilter): Promise<{ movements: StockMovement[]; pagination: Pagination }>;
    listMovementsForExport(filter: MovementFilter): Promise<{ movements: StockMovement[]; truncated: boolean }>;
    listProductMovements(productId: number, limit: number): Promise<StockMovement[]>;
  }
}

// ---------------------------------------------------------------------------
// 核心：库存变动
// ---------------------------------------------------------------------------

/**
 * 在一个隐式事务中完成「校验 → 更新库存 → 写入流水」。
 *
 * Go 版靠 `BeginTx` + `SELECT ... FOR UPDATE` 式的写锁（`_txlock=immediate`）
 * 保证「读到的库存」与「写回的库存」之间不被打断。D1 没有可交互事务，
 * 于是改成**乐观锁 + 重试**：
 *
 *   1. 先读商品当前库存（before）；
 *   2. 把两条语句放进同一个 batch（隐式事务）：
 *        · 写流水，条件为 `EXISTS (... WHERE id = ? AND quantity = before)`
 *        · 更新库存，条件为 `WHERE id = ? AND quantity = before`
 *      两条语句共用同一个守卫。别人抢先改过库存 → 两条都不生效（0 行），
 *      不会出现「流水写了、库存没改」这类撕裂状态；
 *   3. 若守卫失败，说明读到的库存已过期，重新读一遍再试。
 *
 * 把流水写在前面是有意的：流水语句不改动 products，因此它的 EXISTS 与
 * 后面 UPDATE 的 WHERE 看到的是**同一个**（改动前的）库存值，
 * 两条守卫的判定必然一致。
 */
Store.prototype.applyMovement = async function (
  this: Store,
  type: MovementType,
  raw: MovementInput,
): Promise<StockMovement> {
  if (!movementTypeValid(type)) throw invalidInput("库存变动类型不合法");
  if (type === "init" || type === "adjust") {
    throw invalidInput("期初建账与盘点请使用专用接口");
  }

  const productId = raw.productId;
  const quantity = raw.quantity;
  const unitPrice = raw.unitPrice;
  const operatorId = raw.operatorId;
  const refNo = (raw.refNo ?? "").trim();
  const note = (raw.note ?? "").trim();
  const supplierId = nullableId(raw.supplierId);

  if (!Number.isInteger(productId) || productId <= 0) throw invalidInput("请选择商品");
  if (!Number.isInteger(quantity) || quantity <= 0) throw invalidInput("数量必须大于 0");
  if (quantity > MAX_QUANTITY) throw invalidInput(`单次数量不能超过 ${MAX_QUANTITY}`);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) throw invalidInput("单价不能为负数");
  if (!Number.isInteger(operatorId) || operatorId <= 0) throw invalidInput("缺少操作人信息");

  const direction = movementDirection(type);

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const product = await this.getProduct(productId);
    if (!product) throw notFound();

    const before = product.quantity;
    const delta = quantity * direction;
    const after = before + delta;

    if (after < 0) {
      throw new AppError(
        "insufficientStock",
        `当前库存为 ${before} ${product.unit}，无法出库 ${quantity} ${product.unit}`,
      );
    }
    // 上限要卡在**结存**上，而不是只卡单次输入。
    // 只校验 quantity 的话，连续入库可以把库存一路累加突破上限，
    // MAX_QUANTITY 那句「保证 before_qty + delta 不溢出 int64」也就落了空 ——
    // 单次不越界，累加起来照样能溢出。
    if (after > MAX_QUANTITY) {
      throw invalidInput(
        `入库后库存将达到 ${after} ${product.unit}，超过单个商品的上限 ${MAX_QUANTITY}`,
      );
    }

    const now = nowUtcIso();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO stock_movements
             (product_id, type, quantity, delta, unit_price, before_qty, after_qty,
              ref_no, supplier_id, operator_id, note, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND quantity = ?)`,
        )
        .bind(
          productId,
          type,
          quantity,
          delta,
          unitPrice,
          before,
          after,
          refNo,
          supplierId,
          operatorId,
          note,
          now,
          productId,
          before,
        ),
      this.db
        .prepare(`UPDATE products SET quantity = ?, updated_at = ? WHERE id = ? AND quantity = ?`)
        .bind(after, now, productId, before),
    ]);

    if (changedRows(results[0]) > 0 && changedRows(results[1]) > 0) {
      const movementId = Number(
        (results[0].meta as { last_row_id?: number } | undefined)?.last_row_id ?? 0,
      );
      return {
        id: movementId,
        productId,
        type,
        quantity,
        delta,
        unitPrice,
        beforeQty: before,
        afterQty: after,
        refNo,
        supplierId,
        operatorId,
        note,
        createdAt: now,
        productName: product.name,
        productSku: product.sku,
        productUnit: product.unit,
        operatorName: "",
        supplierName: "",
      };
    }
  }

  throw conflict("库存刚被其他操作修改，请刷新后重试");
};

/**
 * 盘点：把商品库存直接设置为实际数量，并记录差异。
 *
 * 守卫方式与 applyMovement 相同；区别只在于目标值是「绝对值」而非增减量。
 */
Store.prototype.adjustStock = async function (
  this: Store,
  productId: number,
  targetQty: number,
  rawNote: string,
  operatorId: number,
): Promise<StockMovement> {
  if (!Number.isInteger(productId) || productId <= 0) throw invalidInput("请选择商品");
  if (!Number.isInteger(targetQty)) throw invalidInput("实际库存必须是整数");
  if (targetQty < 0) throw invalidInput("实际库存不能为负数");
  if (targetQty > MAX_QUANTITY) throw invalidInput(`实际库存不能超过 ${MAX_QUANTITY}`);
  if (!Number.isInteger(operatorId) || operatorId <= 0) throw invalidInput("缺少操作人信息");

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const product = await this.getProduct(productId);
    if (!product) throw notFound();

    const before = product.quantity;
    const delta = targetQty - before;
    if (delta === 0) {
      // 盘点数与当前库存一致时直接返回，不落一条 delta=0 的流水。
      // 这类条目既非盘盈也非盘亏，对「追溯库存变动」没有任何信息量，
      // 却会因为误点「盘点」而在流水表里不断堆积噪音 ——
      // 真正需要找记录时，反而被这些空条目淹没。
      throw invalidInput(`当前库存已经是 ${before} ${product.unit}，无需盘点调整`);
    }

    let note = (rawNote ?? "").trim();
    if (note === "") note = "库存盘点调整";

    const now = nowUtcIso();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO stock_movements
             (product_id, type, quantity, delta, unit_price, before_qty, after_qty,
              ref_no, supplier_id, operator_id, note, created_at)
           SELECT ?, 'adjust', ?, ?, ?, ?, ?, '', NULL, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND quantity = ?)`,
        )
        .bind(
          productId,
          absInt(delta),
          delta,
          product.costPrice,
          before,
          targetQty,
          operatorId,
          note,
          now,
          productId,
          before,
        ),
      this.db
        .prepare(`UPDATE products SET quantity = ?, updated_at = ? WHERE id = ? AND quantity = ?`)
        .bind(targetQty, now, productId, before),
    ]);

    if (changedRows(results[0]) > 0 && changedRows(results[1]) > 0) {
      const movementId = Number(
        (results[0].meta as { last_row_id?: number } | undefined)?.last_row_id ?? 0,
      );
      return {
        id: movementId,
        productId,
        type: "adjust",
        quantity: absInt(delta),
        delta,
        unitPrice: product.costPrice,
        beforeQty: before,
        afterQty: targetQty,
        refNo: "",
        supplierId: null,
        operatorId,
        note,
        createdAt: now,
        productName: product.name,
        productSku: product.sku,
        productUnit: product.unit,
        operatorName: "",
        supplierName: "",
      };
    }
  }

  throw conflict("库存刚被其他操作修改，请刷新后重试");
};

// ---------------------------------------------------------------------------
// 流水查询
// ---------------------------------------------------------------------------

function buildMovementWhere(f: MovementFilter): { sql: string; args: unknown[] } {
  const where: string[] = ["1=1"];
  const args: unknown[] = [];

  if (f.keyword) {
    const like = likePattern(f.keyword);
    where.push(
      `(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR m.ref_no LIKE ? ESCAPE '\\' OR m.note LIKE ? ESCAPE '\\')`,
    );
    args.push(like, like, like, like);
  }
  if (f.type && f.type !== "all") {
    where.push("m.type = ?");
    args.push(f.type);
  }
  if (f.productId && f.productId > 0) {
    where.push("m.product_id = ?");
    args.push(f.productId);
  }
  if (f.operatorId && f.operatorId > 0) {
    where.push("m.operator_id = ?");
    args.push(f.operatorId);
  }
  const start = parseLocalDate(f.startDate);
  if (start) {
    where.push("m.created_at >= ?");
    args.push(start.toISOString());
  }
  const end = parseLocalDate(f.endDate);
  if (end) {
    where.push("m.created_at < ?");
    args.push(addDaysUtc(end, 1).toISOString());
  }
  return { sql: where.join(" AND "), args };
}

Store.prototype.listMovements = async function (
  this: Store,
  f: MovementFilter,
): Promise<{ movements: StockMovement[]; pagination: Pagination }> {
  const { sql: whereSql, args } = buildMovementWhere(f);

  const countRow = await this.db
    .prepare(
      `SELECT COUNT(*) AS n FROM stock_movements m
       LEFT JOIN products p ON p.id = m.product_id
       WHERE ${whereSql}`,
    )
    .bind(...args)
    .first<{ n: number }>();
  const pg = newPagination(f.page ?? 1, f.perPage ?? 20, countRow?.n ?? 0);

  const rows = await this.db
    .prepare(
      `${MOVEMENT_SELECT} WHERE ${whereSql}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...args, pg.perPage, pg.offset)
    .all<StockMovement>();

  return { movements: rows.results ?? [], pagination: pg };
};

/**
 * 返回符合条件的流水（不分页）。
 *
 * truncated 为真表示结果被 MAX_EXPORT_ROWS 截断，调用方**必须**把这个事实
 * 明确告诉用户（例如写进导出文件本身），不能静默丢弃。
 */
Store.prototype.listMovementsForExport = async function (
  this: Store,
  f: MovementFilter,
): Promise<{ movements: StockMovement[]; truncated: boolean }> {
  const { sql: whereSql, args } = buildMovementWhere(f);

  const rows = await this.db
    .prepare(
      `${MOVEMENT_SELECT} WHERE ${whereSql}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
    )
    .bind(...args, MAX_EXPORT_ROWS + 1)
    .all<StockMovement>();

  const out = rows.results ?? [];
  if (out.length > MAX_EXPORT_ROWS) {
    return { movements: out.slice(0, MAX_EXPORT_ROWS), truncated: true };
  }
  return { movements: out, truncated: false };
};

/** 查询单个商品的最近流水。 */
Store.prototype.listProductMovements = async function (
  this: Store,
  productId: number,
  limit: number,
): Promise<StockMovement[]> {
  const n = limit > 0 ? limit : 20;
  const rows = await this.db
    .prepare(
      `${MOVEMENT_SELECT} WHERE m.product_id = ?
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
    )
    .bind(productId, n)
    .all<StockMovement>();
  return rows.results ?? [];
};
