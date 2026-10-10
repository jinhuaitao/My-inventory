// 商品 —— 对应原 Go 版 internal/services/product.go。

import { conflict, invalidInput, notFound } from "../lib/errors";
import { absInt, defaultString } from "../lib/format";
import { newPagination, type Pagination } from "../lib/pagination";
import { isUniqueViolation, likePattern, nullableId } from "../lib/sql";
import { nowUtcIso } from "../lib/time";
import { normalizeSku, runeLength } from "../lib/validate";
import { PRODUCT_STATUS_ACTIVE, PRODUCT_STATUS_ARCHIVED, type Product } from "../types";
import { MAX_QUANTITY, MAX_EXPORT_ROWS, Store } from "./store";

/** 商品列表 / 详情共用的查询主体。 */
const PRODUCT_COLUMNS = `p.id, p.sku, p.name, p.barcode,
  p.category_id AS categoryId, p.supplier_id AS supplierId, p.unit,
  p.cost_price AS costPrice, p.sale_price AS salePrice,
  p.quantity, p.safety_stock AS safetyStock, p.location, p.description, p.status,
  COALESCE(c.name, '') AS categoryName,
  COALESCE(s.name, '') AS supplierName,
  p.created_at AS createdAt, p.updated_at AS updatedAt`;

const PRODUCT_SELECT = `SELECT ${PRODUCT_COLUMNS}
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN suppliers  s ON s.id = p.supplier_id`;

export interface ProductFilter {
  search?: string;
  categoryId?: number | null;
  supplierId?: number | null;
  status?: string;
  lowStockOnly?: boolean;
  sortBy?: string;
  sortDir?: string;
  page?: number;
  perPage?: number;
}

export interface ProductInput {
  sku: string;
  name: string;
  barcode: string;
  categoryId: number | null;
  supplierId: number | null;
  unit: string;
  costPrice: number;
  salePrice: number;
  /** 仅创建时作为期初库存生效；修改商品时不参与。 */
  quantity: number;
  safetyStock: number;
  location: string;
  description: string;
  status: string;
}

declare module "./store" {
  interface Store {
    listProducts(filter: ProductFilter): Promise<{ products: Product[]; pagination: Pagination }>;
    listProductsForExport(filter: ProductFilter): Promise<{ products: Product[]; truncated: boolean }>;
    getProduct(id: number): Promise<Product | null>;
    getProductBySku(sku: string): Promise<Product | null>;
    countLowStockBreakdown(): Promise<{ outOfStock: number; lowStock: number }>;
    listLowStockProducts(limit: number): Promise<Product[]>;
    createProduct(input: ProductInput, operatorId: number): Promise<Product>;
    updateProduct(id: number, input: ProductInput): Promise<void>;
    setProductStatus(id: number, status: string): Promise<void>;
    deleteProduct(id: number): Promise<void>;
  }
}

// ---------------------------------------------------------------------------
// 筛选与排序
// ---------------------------------------------------------------------------

/**
 * 组装 WHERE 子句。
 *
 * 状态筛选分三种情形，不能把后两者合并：
 *   ""    —— 默认视图，隐含排除归档（归档意味着「不再参与日常管理」）；
 *   "all" —— 字面意义的「全部状态」，归档商品也必须显示出来；
 *   其他  —— 精确匹配某个状态。
 * 早先 "" 与 "all" 共用同一个 else 分支，于是下拉里选了「全部状态」
 * 反而筛不出归档商品 —— 一个叫「全部」却少给结果的筛选项，
 * 比根本没有这个选项更容易误导人。
 */
function buildProductWhere(f: ProductFilter): { sql: string; args: unknown[] } {
  const where: string[] = ["1=1"];
  const args: unknown[] = [];

  if (f.search) {
    const like = likePattern(f.search);
    where.push(
      `(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\' OR p.location LIKE ? ESCAPE '\\')`,
    );
    args.push(like, like, like, like);
  }
  if (f.categoryId && f.categoryId > 0) {
    where.push("p.category_id = ?");
    args.push(f.categoryId);
  }
  if (f.supplierId && f.supplierId > 0) {
    where.push("p.supplier_id = ?");
    args.push(f.supplierId);
  }
  switch (f.status ?? "") {
    case "":
      where.push("p.status != 'archived'");
      break;
    case "all":
      // 不加任何状态条件
      break;
    default:
      where.push("p.status = ?");
      args.push(f.status);
      break;
  }
  if (f.lowStockOnly) {
    where.push("p.quantity <= p.safety_stock");
  }
  return { sql: where.join(" AND "), args };
}

/** 允许排序的列白名单，避免 SQL 注入。 */
const PRODUCT_SORT_COLUMNS: Record<string, string> = {
  name: "p.name",
  sku: "p.sku",
  quantity: "p.quantity",
  cost_price: "p.cost_price",
  sale_price: "p.sale_price",
  value: "(p.quantity * p.cost_price)",
  category: "categoryName",
  updated_at: "p.updated_at",
  created_at: "p.created_at",
};

function buildProductSort(by: string | undefined, dir: string | undefined): string {
  const col = PRODUCT_SORT_COLUMNS[by ?? ""] ?? "p.updated_at";
  const order = (dir ?? "").toLowerCase() === "asc" ? "ASC" : "DESC";
  return `${col} ${order}, p.id DESC`;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

Store.prototype.listProducts = async function (
  this: Store,
  f: ProductFilter,
): Promise<{ products: Product[]; pagination: Pagination }> {
  const { sql: whereSql, args } = buildProductWhere(f);

  const countRow = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>();
  const pg = newPagination(f.page ?? 1, f.perPage ?? 20, countRow?.n ?? 0);

  const rows = await this.db
    .prepare(
      `${PRODUCT_SELECT} WHERE ${whereSql}
       ORDER BY ${buildProductSort(f.sortBy, f.sortDir)}
       LIMIT ? OFFSET ?`,
    )
    .bind(...args, pg.perPage, pg.offset)
    .all<Product>();

  return { products: rows.results ?? [], pagination: pg };
};

/**
 * 返回符合条件的商品（不分页），用于 CSV 导出。
 *
 * truncated 为真表示结果被 MAX_EXPORT_ROWS 截断，调用方**必须**把这个事实
 * 明确告诉用户（写进导出文件本身），不能像以前那样静默只出前 200 条。
 */
Store.prototype.listProductsForExport = async function (
  this: Store,
  f: ProductFilter,
): Promise<{ products: Product[]; truncated: boolean }> {
  const { sql: whereSql, args } = buildProductWhere(f);

  // 多取一行用于判断是否真的被截断：只看 len === limit
  // 无法区分「恰好这么多」与「后面还有更多」。
  const rows = await this.db
    .prepare(
      `${PRODUCT_SELECT} WHERE ${whereSql}
       ORDER BY ${buildProductSort(f.sortBy, f.sortDir)}
       LIMIT ?`,
    )
    .bind(...args, MAX_EXPORT_ROWS + 1)
    .all<Product>();

  const out = rows.results ?? [];
  if (out.length > MAX_EXPORT_ROWS) {
    return { products: out.slice(0, MAX_EXPORT_ROWS), truncated: true };
  }
  return { products: out, truncated: false };
};

Store.prototype.getProduct = async function (this: Store, id: number): Promise<Product | null> {
  return this.db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).bind(id).first<Product>();
};

Store.prototype.getProductBySku = async function (this: Store, sku: string): Promise<Product | null> {
  return this.db
    .prepare(`${PRODUCT_SELECT} WHERE p.sku = ?`)
    .bind(normalizeSku(sku))
    .first<Product>();
};

/**
 * 统计预警商品中「已缺货」与「低于安全库存但仍有货」各有多少。
 *
 * 口径与预警列表（ProductFilter.lowStockOnly）严格一致，
 * 因此 outOfStock + lowStock 恒等于该列表的总条数。
 *
 * 必须用独立的聚合查询，不能遍历当前页的商品来数：分页之后那样数出来的
 * 只是「本页」的构成，商品一超过一页，页面顶部两个数字就会莫名其妙变小，
 * 而用户完全看不出原因。
 */
Store.prototype.countLowStockBreakdown = async function (
  this: Store,
): Promise<{ outOfStock: number; lowStock: number }> {
  const row = await this.db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN quantity <= 0 THEN 1 ELSE 0 END), 0) AS outOfStock,
         COALESCE(SUM(CASE WHEN quantity > 0 THEN 1 ELSE 0 END), 0) AS lowStock
       FROM products
       WHERE status != 'archived' AND quantity <= safety_stock`,
    )
    .first<{ outOfStock: number; lowStock: number }>();
  return { outOfStock: row?.outOfStock ?? 0, lowStock: row?.lowStock ?? 0 };
};

/** 返回库存低于或等于安全库存的商品，按缺口从大到小排序。 */
Store.prototype.listLowStockProducts = async function (this: Store, limit: number): Promise<Product[]> {
  const n = limit > 0 ? limit : 10;
  const rows = await this.db
    .prepare(
      `${PRODUCT_SELECT}
       WHERE p.status != 'archived' AND p.quantity <= p.safety_stock
       ORDER BY (p.safety_stock - p.quantity) DESC, p.quantity ASC
       LIMIT ?`,
    )
    .bind(n)
    .all<Product>();
  return rows.results ?? [];
};

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/**
 * 规范化并校验商品表单字段。校验顺序与原 Go 版一致，保证提示文案可对齐。
 */
export function normalizeProductInput(raw: ProductInput): ProductInput {
  const input: ProductInput = {
    sku: normalizeSku(raw.sku),
    name: (raw.name ?? "").trim(),
    barcode: (raw.barcode ?? "").trim(),
    categoryId: nullableId(raw.categoryId),
    supplierId: nullableId(raw.supplierId),
    unit: defaultString((raw.unit ?? "").trim(), "件"),
    costPrice: raw.costPrice,
    salePrice: raw.salePrice,
    quantity: raw.quantity,
    safetyStock: raw.safetyStock,
    location: (raw.location ?? "").trim(),
    description: (raw.description ?? "").trim(),
    status: raw.status === "" || raw.status === undefined || raw.status === null
      ? PRODUCT_STATUS_ACTIVE
      : raw.status,
  };

  if (input.sku === "") throw invalidInput("SKU 不能为空");
  if (input.sku.length > 64) throw invalidInput("SKU 不能超过 64 个字符");
  if (input.name === "") throw invalidInput("商品名称不能为空");
  if (runeLength(input.name) > 200) throw invalidInput("商品名称不能超过 200 个字符");

  if (!Number.isFinite(input.costPrice) || !Number.isFinite(input.salePrice)) {
    throw invalidInput("价格不是有效的数字");
  }
  if (input.costPrice < 0 || input.salePrice < 0) throw invalidInput("价格不能为负数");

  if (!Number.isInteger(input.safetyStock)) throw invalidInput("安全库存必须是整数");
  if (!Number.isInteger(input.quantity)) throw invalidInput("库存数量必须是整数");
  if (input.safetyStock < 0) throw invalidInput("安全库存不能为负数");
  if (input.quantity < 0) throw invalidInput("库存数量不能为负数");
  if (input.quantity > MAX_QUANTITY) throw invalidInput(`期初库存不能超过 ${MAX_QUANTITY}`);

  if (input.status !== PRODUCT_STATUS_ACTIVE && input.status !== PRODUCT_STATUS_ARCHIVED) {
    throw invalidInput("商品状态不合法");
  }
  return input;
}

/**
 * 新建商品；若期初库存大于 0，会同步生成一条「期初建账」流水。
 *
 * D1 没有可交互事务，用 batch（隐式事务）承载「插入商品 + 插入期初流水」。
 * 流水的 product_id 通过 `SELECT id FROM products WHERE sku = ?` 取得 ——
 * 这样就不必先把商品插进去、读出 last_row_id、再发第二次请求，
 * 避免了两次请求之间失败而留下「有商品、没期初流水」的半截数据。
 */
Store.prototype.createProduct = async function (
  this: Store,
  raw: ProductInput,
  operatorId: number,
): Promise<Product> {
  const input = normalizeProductInput(raw);

  // 操作人必须有效。期初库存大于 0 时 operatorId 会写进流水的外键列，
  // 而该列是 NOT NULL REFERENCES users(id)：不在这里拦下的话，
  // 用户看到的会是一句裸的「constraint failed」，
  // 整笔建商品操作回滚，却不知道究竟哪里填错了。
  if (!Number.isInteger(operatorId) || operatorId <= 0) {
    throw invalidInput("缺少操作人信息");
  }

  const now = nowUtcIso();
  const statements: D1PreparedStatement[] = [
    this.db
      .prepare(
        `INSERT INTO products
           (sku, name, barcode, category_id, supplier_id, unit, cost_price, sale_price,
            quantity, safety_stock, location, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.sku,
        input.name,
        input.barcode,
        input.categoryId,
        input.supplierId,
        input.unit,
        input.costPrice,
        input.salePrice,
        input.quantity,
        input.safetyStock,
        input.location,
        input.description,
        input.status,
        now,
        now,
      ),
  ];

  if (input.quantity > 0) {
    statements.push(
      this.db
        .prepare(
          `INSERT INTO stock_movements
             (product_id, type, quantity, delta, unit_price, before_qty, after_qty,
              ref_no, supplier_id, operator_id, note, created_at)
           SELECT id, 'init', ?, ?, ?, 0, ?, '', ?, ?, '新建商品期初建账', ?
             FROM products WHERE sku = ?`,
        )
        .bind(
          input.quantity,
          input.quantity,
          input.costPrice,
          input.quantity,
          input.supplierId,
          operatorId,
          now,
          input.sku,
        ),
    );
  }

  let results: D1Result<unknown>[];
  try {
    results = await this.db.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`SKU「${input.sku}」已存在`);
    throw err;
  }

  const productId = Number((results[0]?.meta as { last_row_id?: number } | undefined)?.last_row_id ?? 0);
  const product = await this.getProduct(productId);
  if (!product) throw notFound();
  return product;
};

/** 修改商品资料。库存数量不在此处修改，必须通过出入库 / 盘点完成。 */
Store.prototype.updateProduct = async function (
  this: Store,
  id: number,
  raw: ProductInput,
): Promise<void> {
  const input = normalizeProductInput(raw);
  try {
    const res = await this.db
      .prepare(
        `UPDATE products SET
           sku = ?, name = ?, barcode = ?, category_id = ?, supplier_id = ?, unit = ?,
           cost_price = ?, sale_price = ?, safety_stock = ?, location = ?,
           description = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.sku,
        input.name,
        input.barcode,
        input.categoryId,
        input.supplierId,
        input.unit,
        input.costPrice,
        input.salePrice,
        input.safetyStock,
        input.location,
        input.description,
        input.status,
        nowUtcIso(),
        id,
      )
      .run();
    if ((res.meta.changes ?? 0) === 0) throw notFound();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`SKU「${input.sku}」已存在`);
    throw err;
  }
};

/** 归档 / 恢复商品。 */
Store.prototype.setProductStatus = async function (
  this: Store,
  id: number,
  status: string,
): Promise<void> {
  if (status !== PRODUCT_STATUS_ACTIVE && status !== PRODUCT_STATUS_ARCHIVED) {
    throw invalidInput("商品状态不合法");
  }
  const res = await this.db
    .prepare(`UPDATE products SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(status, nowUtcIso(), id)
    .run();
  if ((res.meta.changes ?? 0) === 0) throw notFound();
};

/**
 * 删除商品。存在库存流水时拒绝删除，以保留审计记录。
 *
 * 「查流水」与「删商品」在 Go 版里靠事务 + _txlock=immediate 保证原子；
 * D1 没有可交互事务，于是把「无流水」这个条件直接写进 DELETE 的 WHERE 子句，
 * 让检查与删除成为同一条语句 —— 中间不存在别人插入流水的窗口。
 * 数据库侧的外键已收紧为 RESTRICT（见 migrations/0001_init.sql），
 * 即便将来有人绕过这一层，也会被数据库直接拒绝。
 */
Store.prototype.deleteProduct = async function (this: Store, id: number): Promise<void> {
  const res = await this.db
    .prepare(
      `DELETE FROM products
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM stock_movements WHERE product_id = ?)`,
    )
    .bind(id, id)
    .run();
  if ((res.meta.changes ?? 0) > 0) return;

  const product = await this.getProduct(id);
  if (!product) throw notFound();

  const movements = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?`)
    .bind(id)
    .first<{ n: number }>();
  throw invalidInput(
    `该商品已有 ${movements?.n ?? 0} 条库存流水，请改为「归档」以保留历史记录`,
  );
};

export { absInt };
