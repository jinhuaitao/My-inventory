// 初始化数据 —— 对应原 Go 版 internal/database/database.go 的
// Seed / seedAdmin / seedDemoData / PurgeDemoData。
//
// 与原版最大的不同：D1 没有可交互事务（BEGIN/COMMIT），Go 版靠
// `_txlock=immediate` 把「判空 + 写入」锁在一个事务里。这里改用
// **幂等写入**达成同样效果 —— 分类名、供应商名、商品 SKU 都带唯一约束，
// 一律走 INSERT OR IGNORE；演示流水再加一条 NOT EXISTS 守卫。
// 于是并发冷启动的两个实例各自跑一遍也不会产生重复数据。

import { hashPassword } from "../lib/crypto";
import { placeholders } from "../lib/sql";
import { nowUtcIso } from "../lib/time";
import { Store } from "./store";

// ---------------------------------------------------------------------------
// 内置演示数据
//
// 下面三份列表是演示数据的**唯一来源**：写入（seed）与清理（purgeDemoData）
// 都从这里取值。任何一处新增演示条目，两边都会同步，不会出现「写了清不掉」。
// ---------------------------------------------------------------------------

interface DemoCategory {
  name: string;
  desc: string;
}

interface DemoSupplier {
  name: string;
  contact: string;
  phone: string;
  email: string;
  addr: string;
}

interface DemoProduct {
  sku: string;
  name: string;
  unit: string;
  location: string;
  catIdx: number;
  supIdx: number;
  cost: number;
  sale: number;
  qty: number;
  safety: number;
}

const DEMO_CATEGORIES: DemoCategory[] = [
  { name: "电子配件", desc: "数据线、充电器、转接头等" },
  { name: "办公用品", desc: "纸张、笔、文件夹等" },
  { name: "仓储耗材", desc: "纸箱、胶带、标签等" },
  { name: "工具仪表", desc: "螺丝刀、万用表、卷尺等" },
];

const DEMO_SUPPLIERS: DemoSupplier[] = [
  {
    name: "深圳市宏远电子有限公司",
    contact: "张伟",
    phone: "0755-88886666",
    email: "sales@hongyuan.example.com",
    addr: "广东省深圳市南山区科技园",
  },
  {
    name: "上海办公伙伴贸易有限公司",
    contact: "李娜",
    phone: "021-66668888",
    email: "service@officepartner.example.com",
    addr: "上海市浦东新区张江路 88 号",
  },
  {
    name: "杭州仓储用品制造厂",
    contact: "王强",
    phone: "0571-12345678",
    email: "info@hzwms.example.com",
    addr: "浙江省杭州市余杭区工业园",
  },
];

const DEMO_PRODUCTS: DemoProduct[] = [
  { sku: "SKU-1001", name: "Type-C 数据线 1m", unit: "条", location: "A-01-01", catIdx: 0, supIdx: 0, cost: 8.5, sale: 19.9, qty: 240, safety: 50 },
  { sku: "SKU-1002", name: "65W 氮化镓充电器", unit: "个", location: "A-01-02", catIdx: 0, supIdx: 0, cost: 62.0, sale: 129.0, qty: 36, safety: 20 },
  { sku: "SKU-1003", name: "HDMI 2.1 高清线 2m", unit: "条", location: "A-01-03", catIdx: 0, supIdx: 0, cost: 25.0, sale: 59.0, qty: 12, safety: 20 },
  { sku: "SKU-2001", name: "A4 复印纸 70g（500张）", unit: "包", location: "B-02-01", catIdx: 1, supIdx: 1, cost: 16.8, sale: 25.0, qty: 380, safety: 100 },
  { sku: "SKU-2002", name: "中性签字笔 0.5mm（12支）", unit: "盒", location: "B-02-02", catIdx: 1, supIdx: 1, cost: 9.6, sale: 18.0, qty: 64, safety: 30 },
  { sku: "SKU-2003", name: "A4 牛皮纸档案袋", unit: "个", location: "B-02-03", catIdx: 1, supIdx: 1, cost: 0.85, sale: 2.0, qty: 1200, safety: 300 },
  { sku: "SKU-3001", name: "五层瓦楞纸箱 60×40×40", unit: "个", location: "C-03-01", catIdx: 2, supIdx: 2, cost: 3.2, sale: 6.5, qty: 150, safety: 200 },
  { sku: "SKU-3002", name: "透明封箱胶带 4.5cm", unit: "卷", location: "C-03-02", catIdx: 2, supIdx: 2, cost: 4.1, sale: 9.0, qty: 420, safety: 100 },
  { sku: "SKU-3003", name: "热敏标签纸 100×100", unit: "卷", location: "C-03-03", catIdx: 2, supIdx: 2, cost: 12.0, sale: 26.0, qty: 8, safety: 40 },
  { sku: "SKU-4001", name: "十字螺丝刀套装", unit: "套", location: "D-04-01", catIdx: 3, supIdx: 0, cost: 22.0, sale: 49.0, qty: 55, safety: 15 },
  { sku: "SKU-4002", name: "数字万用表 UT136B+", unit: "台", location: "D-04-02", catIdx: 3, supIdx: 0, cost: 118.0, sale: 199.0, qty: 14, safety: 5 },
  { sku: "SKU-4003", name: "5 米钢卷尺", unit: "把", location: "D-04-03", catIdx: 3, supIdx: 2, cost: 6.8, sale: 15.0, qty: 0, safety: 10 },
];

/** 内置演示商品使用的 SKU 列表。 */
export function demoSkus(): string[] {
  return DEMO_PRODUCTS.map((p) => p.sku);
}

/** 内置演示分类的名称列表。 */
export function demoCategoryNames(): string[] {
  return DEMO_CATEGORIES.map((c) => c.name);
}

/** 内置演示供应商的名称列表。 */
export function demoSupplierNames(): string[] {
  return DEMO_SUPPLIERS.map((s) => s.name);
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

export interface SeedOptions {
  adminUsername: string;
  adminEmail: string;
  adminPassword: string;
  withDemoData: boolean;
}

export interface PurgeOptions {
  /** 为真时只统计将被删除的数据，不产生任何实际改动。 */
  dryRun: boolean;
  /**
   * 为真时，额外把「SKU 命中内置演示 SKU 但没有 is_demo 标记」的商品
   * 也视为演示数据一并删除 —— 用于兼容加标记之前写入的旧库。
   *
   * ⚠️ 默认关闭，且**不应该**默认打开：SKU 是用户可自由填写的业务字段，
   * 用户完全可能在自己的商品上用 SKU-1001 这样的编号。旧版兼容逻辑若无条件
   * 按 SKU 删除，会连带删掉用户的商品**及其全部库存流水** ——
   * 一条清理命令造成不可逆的业务数据丢失。
   * 因此默认只认 is_demo 标记，SKU 命中项仅通过 PurgeResult.legacySkuOnly
   * 报告出来，由管理员确认后再显式开启本选项。
   */
  legacySkuMatch: boolean;
}

export interface PurgeResult {
  products: number;
  movements: number;
  categories: number;
  suppliers: number;
  /** 因仍被非演示商品引用而保留下来的名称，避免误删正在使用的数据。 */
  skippedCategories: string[];
  skippedSuppliers: string[];
  /**
   * 「SKU 命中内置演示 SKU，但没有 is_demo 标记」的商品 SKU。
   *
   * 它们**没有被删除**（除非显式开启 legacySkuMatch），只是报告出来：
   * 管理员据此判断这究竟是旧版遗留的演示数据，还是用户自己创建的商品。
   */
  legacySkuOnly: string[];
}

/** 本次清理是否没有改动任何数据。 */
export function purgeResultEmpty(r: PurgeResult): boolean {
  return r.products === 0 && r.movements === 0 && r.categories === 0 && r.suppliers === 0;
}

/** 是否存在「疑似旧版演示商品」需要人工确认。 */
export function hasLegacyCandidates(r: PurgeResult): boolean {
  return r.legacySkuOnly.length > 0;
}

/** 选一个可用于演示流水的账号，优先管理员。返回 0 表示库中没有任何用户。 */
export async function demoOperatorId(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT id FROM users ORDER BY (role = 'admin') DESC, id ASC LIMIT 1`)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

/**
 * 找出演示主数据里「在删除演示商品之后仍被其他商品引用」的名称。
 *
 * excludeIds 是即将被删除的商品 ID；把引用它们的商品排除掉，
 * 剩下的引用就代表「删完之后依然存在」——等价于原版在事务里删完再查。
 */
async function namesStillReferenced(
  db: D1Database,
  table: string,
  fkColumn: string,
  names: string[],
  excludeIds: number[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const args: unknown[] = [...names];
  let sql = `SELECT DISTINCT m.name AS name
               FROM ${table} m
               JOIN products p ON p.${fkColumn} = m.id
              WHERE m.name IN (${placeholders(names.length)})`;
  if (excludeIds.length > 0) {
    sql += ` AND p.id NOT IN (${placeholders(excludeIds.length)})`;
    args.push(...excludeIds);
  }
  const rows = await db.prepare(sql).bind(...args).all<{ name: string }>();
  const referenced = new Set((rows.results ?? []).map((r) => r.name));
  return names.filter((n) => referenced.has(n));
}

/**
 * 从 names 中挑出在表里**确实存在**的那些。
 *
 * 用于「预演」场景。原版是在事务里真删一遍、拿到受影响行数、再回滚；
 * D1 没有可交互事务，于是改为直接查存在性 —— 得到的正是那条 DELETE
 * 会影响的名称集合，而且不产生任何改动。
 */
async function existingNames(db: D1Database, table: string, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await db
    .prepare(`SELECT name FROM ${table} WHERE name IN (${placeholders(names.length)})`)
    .bind(...names)
    .all<{ name: string }>();
  const found = new Set((rows.results ?? []).map((r) => r.name));
  return names.filter((n) => found.has(n));
}

declare module "./store" {
  interface Store {
    seed(opts: SeedOptions): Promise<boolean>;
    seedDemoData(): Promise<boolean>;
    purgeDemoData(opts: PurgeOptions): Promise<PurgeResult>;
  }
}

/**
 * 若系统中尚无任何用户，则创建默认管理员账号。
 *
 * 「统计用户数」与「插入管理员」合成**一条** INSERT ... SELECT ... WHERE NOT EXISTS，
 * 由数据库保证原子性。原版是「事务 + immediate 写锁」，两者目的一致：
 * 两个实例同时冷启动时，后到的那个不会撞上 username 唯一约束让服务起不来。
 *
 * @returns 是否真的创建了管理员。
 */
Store.prototype.seed = async function (this: Store, opts: SeedOptions): Promise<boolean> {
  // PBKDF2 要算 10 万次迭代，先算好再发语句 —— 不必占着数据库连接等 CPU。
  const hash = await hashPassword(opts.adminPassword);
  const now = nowUtcIso();

  const res = await this.db
    .prepare(
      `INSERT INTO users
         (username, email, password_hash, full_name, role, status, created_at, updated_at)
       SELECT ?, ?, ?, '系统管理员', 'admin', 'active', ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(opts.adminUsername, opts.adminEmail, hash, now, now)
    .run();

  const created = (res.meta.changes ?? 0) > 0;
  if (created) {
    this.logger.info("已创建默认管理员账号", {
      username: opts.adminUsername,
      email: opts.adminEmail,
      提示: "请登录后立即修改默认密码",
    });
  }
  return created;
};

/**
 * 仅在数据库为空时写入一组演示数据，便于首次体验。
 *
 * 所有写入的行都会打上 is_demo 标记，方便日后用 purgeDemoData 精确清理。
 * 判空用一次只读查询；真正落库的语句全部幂等（INSERT OR IGNORE + 流水守卫），
 * 因此即便判空之后有并发实例插入，也不会产生重复数据。
 */
Store.prototype.seedDemoData = async function (this: Store): Promise<boolean> {
  const countRow = await this.db.prepare(`SELECT COUNT(*) AS n FROM products`).first<{ n: number }>();
  if ((countRow?.n ?? 0) > 0) return false;

  const now = nowUtcIso();
  // 演示流水的操作人必须指向一个真实存在的账号：stock_movements.operator_id
  // 带外键约束，若写死 id=1，一旦「用户表非空但 id=1 已被删除」，
  // 整个初始化会失败并让服务**无法启动**。
  const operatorId = await demoOperatorId(this.db);

  const statements: D1PreparedStatement[] = [];

  for (const c of DEMO_CATEGORIES) {
    statements.push(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO categories (name, description, is_demo, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .bind(c.name, c.desc, now, now),
    );
  }

  for (const s of DEMO_SUPPLIERS) {
    statements.push(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO suppliers
             (name, contact_person, phone, email, address, note, is_demo, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '', 1, ?, ?)`,
        )
        .bind(s.name, s.contact, s.phone, s.email, s.addr, now, now),
    );
  }

  for (const p of DEMO_PRODUCTS) {
    statements.push(
      this.db
        .prepare(
          `INSERT OR IGNORE INTO products
             (sku, name, barcode, category_id, supplier_id, unit, cost_price, sale_price,
              quantity, safety_stock, location, description, status, is_demo, created_at, updated_at)
           SELECT ?, ?, '', (SELECT id FROM categories WHERE name = ?),
                  (SELECT id FROM suppliers WHERE name = ?), ?, ?, ?, ?, ?, ?, '', 'active', 1, ?, ?`,
        )
        .bind(
          p.sku,
          p.name,
          DEMO_CATEGORIES[p.catIdx].name,
          DEMO_SUPPLIERS[p.supIdx].name,
          p.unit,
          p.cost,
          p.sale,
          p.qty,
          p.safety,
          p.location,
          now,
          now,
        ),
    );

    // 为期初库存生成一条流水。NOT EXISTS 守卫让整段逻辑可重复执行而不重复记账。
    if (p.qty > 0 && operatorId > 0) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO stock_movements
               (product_id, type, quantity, delta, unit_price, before_qty, after_qty,
                ref_no, supplier_id, operator_id, note, created_at)
             SELECT p.id, 'init', ?, ?, ?, 0, ?, '', p.supplier_id, ?, '系统演示数据期初建账', ?
               FROM products p
              WHERE p.sku = ?
                AND NOT EXISTS (
                  SELECT 1 FROM stock_movements m2
                   WHERE m2.product_id = p.id AND m2.type = 'init'
                )`,
          )
          .bind(p.qty, p.qty, p.cost, p.qty, operatorId, now, p.sku),
      );
    }
  }

  await this.db.batch(statements);

  this.logger.info("已写入演示数据", {
    分类: DEMO_CATEGORIES.length,
    供应商: DEMO_SUPPLIERS.length,
    商品: DEMO_PRODUCTS.length,
    提示: "生产环境请用 INVENTORY_SEED_DEMO_DATA=false 关闭，或清理演示数据",
  });
  return true;
};

/**
 * 删除内置演示数据。
 *
 * 判定规则（宁可漏删也不误删）：
 *   - products   : is_demo=1；仅在 opts.legacySkuMatch 为真时才额外按 SKU 命中
 *   - stock_movements : 仅删除挂在上述商品下的流水
 *   - categories / suppliers : 名称命中内置演示清单，**且已无商品引用**
 *
 * dryRun 为真时只做统计，一条语句都不执行。
 */
Store.prototype.purgeDemoData = async function (
  this: Store,
  opts: PurgeOptions,
): Promise<PurgeResult> {
  const skus = demoSkus();
  const skuIn = placeholders(skus.length);

  const result: PurgeResult = {
    products: 0,
    movements: 0,
    categories: 0,
    suppliers: 0,
    skippedCategories: [],
    skippedSuppliers: [],
    legacySkuOnly: [],
  };

  // ---------- 1. 演示商品与其库存流水 ----------

  // 先单独找出「SKU 命中但无 is_demo 标记」的商品并报告，不删。
  const legacy = await this.db
    .prepare(`SELECT sku FROM products WHERE is_demo <> 1 AND sku IN (${skuIn}) ORDER BY sku`)
    .bind(...skus)
    .all<{ sku: string }>();
  result.legacySkuOnly = (legacy.results ?? []).map((r) => r.sku);

  const idRows = opts.legacySkuMatch
    ? await this.db
        .prepare(`SELECT id FROM products WHERE is_demo = 1 OR sku IN (${skuIn})`)
        .bind(...skus)
        .all<{ id: number }>()
    : await this.db.prepare(`SELECT id FROM products WHERE is_demo = 1`).all<{ id: number }>();
  const productIds = (idRows.results ?? []).map((r) => r.id);
  result.products = productIds.length;

  if (productIds.length > 0) {
    const idIn = placeholders(productIds.length);
    const mv = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM stock_movements WHERE product_id IN (${idIn})`)
      .bind(...productIds)
      .first<{ n: number }>();
    result.movements = mv?.n ?? 0;
  }

  // ---------- 2. 演示分类 / 供应商（仅删除已无商品引用的） ----------

  result.skippedCategories = await namesStillReferenced(
    this.db,
    "categories",
    "category_id",
    demoCategoryNames(),
    productIds,
  );
  result.skippedSuppliers = await namesStillReferenced(
    this.db,
    "suppliers",
    "supplier_id",
    demoSupplierNames(),
    productIds,
  );

  const deletableCategories = demoCategoryNames().filter((n) => !result.skippedCategories.includes(n));
  const deletableSuppliers = demoSupplierNames().filter((n) => !result.skippedSuppliers.includes(n));

  // ⚠️ 预演时必须数「库里确实存在的行」，而不是「演示清单里有几条」。
  // 第一次清理之后这些行已经不存在了；若按清单计数，页面会永远显示
  // 「存在演示数据」，管理员反复点「清理」也清不掉 —— 一个纯展示层的错误
  // 变成了「功能坏了」的观感。原版靠「事务里真删一遍再回滚」拿到真实行数，
  // 这里改成先查存在性，结果一致。
  result.categories = (await existingNames(this.db, "categories", deletableCategories)).length;
  result.suppliers = (await existingNames(this.db, "suppliers", deletableSuppliers)).length;

  if (opts.dryRun) return result;

  // ---------- 3. 实际删除 ----------

  const statements: D1PreparedStatement[] = [];
  let idxMovements = -1;
  let idxProducts = -1;
  let idxCategories = -1;
  let idxSuppliers = -1;

  if (productIds.length > 0) {
    const idIn = placeholders(productIds.length);
    idxMovements =
      statements.push(
        this.db
          .prepare(`DELETE FROM stock_movements WHERE product_id IN (${idIn})`)
          .bind(...productIds),
      ) - 1;
    idxProducts =
      statements.push(
        this.db.prepare(`DELETE FROM products WHERE id IN (${idIn})`).bind(...productIds),
      ) - 1;
  }

  if (deletableCategories.length > 0) {
    // 删完演示商品后再看引用：NOT EXISTS 写在语句里，不存在「查完又被引用」的窗口。
    idxCategories =
      statements.push(
        this.db
          .prepare(
            `DELETE FROM categories
              WHERE name IN (${placeholders(deletableCategories.length)})
                AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = categories.id)`,
          )
          .bind(...deletableCategories),
      ) - 1;
  }

  if (deletableSuppliers.length > 0) {
    idxSuppliers =
      statements.push(
        this.db
          .prepare(
            `DELETE FROM suppliers
              WHERE name IN (${placeholders(deletableSuppliers.length)})
                AND NOT EXISTS (SELECT 1 FROM products p WHERE p.supplier_id = suppliers.id)`,
          )
          .bind(...deletableSuppliers),
      ) - 1;
  }

  if (statements.length > 0) {
    const results = await this.db.batch(statements);
    const changesAt = (i: number): number =>
      i < 0 ? 0 : ((results[i]?.meta as { changes?: number } | undefined)?.changes ?? 0);
    result.movements = changesAt(idxMovements);
    result.products = idxProducts < 0 ? 0 : productIds.length;
    result.categories = changesAt(idxCategories);
    result.suppliers = changesAt(idxSuppliers);
  }

  this.logger.info("已清理演示数据", {
    商品: result.products,
    流水: result.movements,
    分类: result.categories,
    供应商: result.suppliers,
    保留分类: result.skippedCategories,
    保留供应商: result.skippedSuppliers,
  });
  return result;
};
