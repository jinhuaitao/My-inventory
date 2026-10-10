// 分类与供应商 —— 对应原 Go 版 internal/services/category.go 与 supplier.go。

import { conflict, invalidInput, notFound } from "../lib/errors";
import { likePattern } from "../lib/sql";
import { conflictMessage, isUniqueViolation, uniqueField } from "../lib/sql";
import { newPagination, type Pagination } from "../lib/pagination";
import { nowUtcIso } from "../lib/time";
import { isValidEmail, runeLength } from "../lib/validate";
import type { Category, Supplier } from "../types";
import { Store } from "./store";

export interface CategoryFilter {
  search?: string;
  page?: number;
  perPage?: number;
}

export interface SupplierFilter {
  search?: string;
  page?: number;
  perPage?: number;
}

export interface SupplierInput {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  note: string;
}

const CATEGORY_SELECT = `c.id, c.name, c.description, c.created_at AS createdAt, c.updated_at AS updatedAt,
  (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status != 'archived') AS productCount`;

const SUPPLIER_SELECT = `id, name, contact_person AS contactPerson, phone, email, address, note,
  created_at AS createdAt, updated_at AS updatedAt,
  (SELECT COUNT(*) FROM products p WHERE p.supplier_id = suppliers.id AND p.status != 'archived') AS productCount`;

declare module "./store" {
  interface Store {
    listAllCategories(): Promise<Category[]>;
    listCategories(filter: CategoryFilter): Promise<{ categories: Category[]; pagination: Pagination }>;
    getCategory(id: number): Promise<Category | null>;
    createCategory(name: string, description: string): Promise<Category>;
    updateCategory(id: number, name: string, description: string): Promise<void>;
    deleteCategory(id: number): Promise<number>;

    listAllSuppliers(): Promise<Supplier[]>;
    listSuppliers(filter: SupplierFilter): Promise<{ suppliers: Supplier[]; pagination: Pagination }>;
    getSupplier(id: number): Promise<Supplier | null>;
    createSupplier(input: SupplierInput): Promise<Supplier>;
    updateSupplier(id: number, input: SupplierInput): Promise<void>;
    deleteSupplier(id: number): Promise<number>;
  }
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

Store.prototype.listAllCategories = async function (this: Store): Promise<Category[]> {
  const rows = await this.db
    .prepare(`SELECT ${CATEGORY_SELECT} FROM categories c ORDER BY c.name COLLATE NOCASE ASC`)
    .all<Category>();
  return rows.results ?? [];
};

Store.prototype.listCategories = async function (
  this: Store,
  filter: CategoryFilter,
): Promise<{ categories: Category[]; pagination: Pagination }> {
  const where: string[] = ["1=1"];
  const args: unknown[] = [];
  if (filter.search) {
    const like = likePattern(filter.search);
    where.push(`(c.name LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')`);
    args.push(like, like);
  }
  const whereSql = where.join(" AND ");

  const countRow = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM categories c WHERE ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>();
  const pg = newPagination(filter.page ?? 1, filter.perPage ?? 20, countRow?.n ?? 0);

  const rows = await this.db
    .prepare(
      `SELECT ${CATEGORY_SELECT} FROM categories c WHERE ${whereSql}
       ORDER BY c.name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
    )
    .bind(...args, pg.perPage, pg.offset)
    .all<Category>();

  return { categories: rows.results ?? [], pagination: pg };
};

Store.prototype.getCategory = async function (this: Store, id: number): Promise<Category | null> {
  return this.db
    .prepare(`SELECT ${CATEGORY_SELECT} FROM categories c WHERE c.id = ?`)
    .bind(id)
    .first<Category>();
};

function validateCategoryName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw invalidInput("分类名称不能为空");
  if (runeLength(trimmed) > 50) throw invalidInput("分类名称不能超过 50 个字符");
  return trimmed;
}

Store.prototype.createCategory = async function (
  this: Store,
  name: string,
  description: string,
): Promise<Category> {
  const trimmed = validateCategoryName(name);
  const now = nowUtcIso();
  let id: number;
  try {
    const res = await this.db
      .prepare(`INSERT INTO categories (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(trimmed, description.trim(), now, now)
      .run();
    id = Number((res.meta as { last_row_id?: number }).last_row_id ?? 0);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`分类「${trimmed}」已存在`);
    throw err;
  }
  const category = await this.getCategory(id);
  if (!category) throw notFound();
  return category;
};

/**
 * 修改分类。长度与空值规则必须与创建一致，
 * 否则「编辑」就是一条绕过校验的通道。
 */
Store.prototype.updateCategory = async function (
  this: Store,
  id: number,
  name: string,
  description: string,
): Promise<void> {
  const trimmed = validateCategoryName(name);
  try {
    const res = await this.db
      .prepare(`UPDATE categories SET name = ?, description = ?, updated_at = ? WHERE id = ?`)
      .bind(trimmed, description.trim(), nowUtcIso(), id)
      .run();
    if ((res.meta.changes ?? 0) === 0) throw notFound();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`分类「${trimmed}」已存在`);
    throw err;
  }
};

/**
 * 删除分类；关联商品的分类字段会被置空（外键 ON DELETE SET NULL）。
 * 统计与删除放在同一批次里，否则返回的「受影响商品数」可能是删除前的旧值。
 */
Store.prototype.deleteCategory = async function (this: Store, id: number): Promise<number> {
  const countRow = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM products WHERE category_id = ?`)
    .bind(id)
    .first<{ n: number }>();

  const res = await this.db.prepare(`DELETE FROM categories WHERE id = ?`).bind(id).run();
  if ((res.meta.changes ?? 0) === 0) throw notFound();
  return countRow?.n ?? 0;
};

// ---------------------------------------------------------------------------
// 供应商
// ---------------------------------------------------------------------------

Store.prototype.listAllSuppliers = async function (this: Store): Promise<Supplier[]> {
  const rows = await this.db
    .prepare(`SELECT ${SUPPLIER_SELECT} FROM suppliers ORDER BY name COLLATE NOCASE ASC`)
    .all<Supplier>();
  return rows.results ?? [];
};

Store.prototype.listSuppliers = async function (
  this: Store,
  filter: SupplierFilter,
): Promise<{ suppliers: Supplier[]; pagination: Pagination }> {
  const where: string[] = ["1=1"];
  const args: unknown[] = [];
  if (filter.search) {
    const like = likePattern(filter.search);
    where.push(
      `(name LIKE ? ESCAPE '\\' OR contact_person LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`,
    );
    args.push(like, like, like, like);
  }
  const whereSql = where.join(" AND ");

  const countRow = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM suppliers WHERE ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>();
  const pg = newPagination(filter.page ?? 1, filter.perPage ?? 20, countRow?.n ?? 0);

  const rows = await this.db
    .prepare(
      `SELECT ${SUPPLIER_SELECT} FROM suppliers WHERE ${whereSql}
       ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
    )
    .bind(...args, pg.perPage, pg.offset)
    .all<Supplier>();

  return { suppliers: rows.results ?? [], pagination: pg };
};

Store.prototype.getSupplier = async function (this: Store, id: number): Promise<Supplier | null> {
  return this.db.prepare(`SELECT ${SUPPLIER_SELECT} FROM suppliers WHERE id = ?`).bind(id).first<Supplier>();
};

function normalizeSupplier(input: SupplierInput): SupplierInput {
  const out: SupplierInput = {
    name: input.name.trim(),
    contactPerson: input.contactPerson.trim(),
    phone: input.phone.trim(),
    email: input.email.trim().toLowerCase(),
    address: input.address.trim(),
    note: input.note.trim(),
  };
  if (out.name === "") throw invalidInput("供应商名称不能为空");
  if (runeLength(out.name) > 100) throw invalidInput("供应商名称不能超过 100 个字符");
  if (out.email !== "" && !isValidEmail(out.email)) throw invalidInput("邮箱格式不正确");
  return out;
}

Store.prototype.createSupplier = async function (
  this: Store,
  raw: SupplierInput,
): Promise<Supplier> {
  const input = normalizeSupplier(raw);
  const now = nowUtcIso();
  let id: number;
  try {
    const res = await this.db
      .prepare(
        `INSERT INTO suppliers (name, contact_person, phone, email, address, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.name, input.contactPerson, input.phone, input.email, input.address, input.note, now, now)
      .run();
    id = Number((res.meta as { last_row_id?: number }).last_row_id ?? 0);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`供应商「${input.name}」已存在`);
    throw err;
  }
  const supplier = await this.getSupplier(id);
  if (!supplier) throw notFound();
  return supplier;
};

Store.prototype.updateSupplier = async function (
  this: Store,
  id: number,
  raw: SupplierInput,
): Promise<void> {
  const input = normalizeSupplier(raw);
  try {
    const res = await this.db
      .prepare(
        `UPDATE suppliers
         SET name = ?, contact_person = ?, phone = ?, email = ?, address = ?, note = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.name,
        input.contactPerson,
        input.phone,
        input.email,
        input.address,
        input.note,
        nowUtcIso(),
        id,
      )
      .run();
    if ((res.meta.changes ?? 0) === 0) throw notFound();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`供应商「${input.name}」已存在`);
    throw err;
  }
};

/**
 * 删除供应商，返回受影响商品数（商品的供应商字段会被置空）。
 *
 * 该供应商只要出现在任何一条库存流水里就拒绝删除 —— 否则删掉一个供应商会把
 * **全部历史入库单**上的供应商字段抹成空，采购记录瞬间失去出处。
 * 判断直接写进 DELETE 的 WHERE 子句，让「检查 + 删除」成为同一条语句。
 */
Store.prototype.deleteSupplier = async function (this: Store, id: number): Promise<number> {
  const countRow = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM products WHERE supplier_id = ?`)
    .bind(id)
    .first<{ n: number }>();

  const res = await this.db
    .prepare(`DELETE FROM suppliers WHERE id = ? AND NOT EXISTS (SELECT 1 FROM stock_movements WHERE supplier_id = ?)`)
    .bind(id, id)
    .run();

  if ((res.meta.changes ?? 0) > 0) return countRow?.n ?? 0;

  const supplier = await this.getSupplier(id);
  if (!supplier) throw notFound();

  const movements = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM stock_movements WHERE supplier_id = ?`)
    .bind(id)
    .first<{ n: number }>();
  throw invalidInput(
    `该供应商已出现在 ${movements?.n ?? 0} 条库存流水里，删除会抹掉历史记录的出处，请改为停用或保留`,
  );
};

/** 冲突提示复用。 */
export { conflictMessage };
