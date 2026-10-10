// 领域模型 —— 对应原 Go 版 internal/models/models.go。

// ---------------------------------------------------------------------------
// 角色与权限
// ---------------------------------------------------------------------------

/** 用户在系统中的角色。 */
export type Role = "admin" | "manager" | "viewer";

export const ALL_ROLES: Role[] = ["admin", "manager", "viewer"];

export function roleLabel(role: Role): string {
  switch (role) {
    case "admin":
      return "管理员";
    case "manager":
      return "仓管员";
    case "viewer":
      return "只读用户";
    default:
      return String(role);
  }
}

/** 是否具备写权限（管理员或仓管员）。 */
export function roleCanWrite(role: Role): boolean {
  return role === "admin" || role === "manager";
}

/** 是否可管理用户账号（仅管理员）。 */
export function roleCanManageUsers(role: Role): boolean {
  return role === "admin";
}

export function roleValid(role: string): role is Role {
  return (ALL_ROLES as string[]).includes(role);
}

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

export const USER_STATUS_ACTIVE = "active";
export const USER_STATUS_DISABLED = "disabled";

export interface User {
  id: number;
  username: string;
  email: string;
  passwordHash: string;
  fullName: string;
  role: Role;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function userIsActive(u: Pick<User, "status">): boolean {
  return u.status === USER_STATUS_ACTIVE;
}

/** 界面展示用的称呼，优先使用姓名。 */
export function userDisplayName(u: Pick<User, "fullName" | "username">): string {
  const name = (u.fullName ?? "").trim();
  return name !== "" ? name : u.username;
}

/** 头像首字（支持中文）。 */
export function userInitials(u: Pick<User, "fullName" | "username">): string {
  const name = userDisplayName(u).trim();
  if (name === "") return "?";
  const runes = Array.from(name);
  if (runes[0].codePointAt(0)! > 127) return runes[0];
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (runes.length >= 2) return (runes[0] + runes[1]).toUpperCase();
  return name.toUpperCase();
}

// ---------------------------------------------------------------------------
// 分类 / 供应商
// ---------------------------------------------------------------------------

export interface Category {
  id: number;
  name: string;
  description: string;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Supplier {
  id: number;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  note: string;
  productCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 商品
// ---------------------------------------------------------------------------

export const PRODUCT_STATUS_ACTIVE = "active";
export const PRODUCT_STATUS_ARCHIVED = "archived";

export interface Product {
  id: number;
  sku: string;
  name: string;
  barcode: string;
  categoryId: number | null;
  supplierId: number | null;
  unit: string;
  costPrice: number;
  salePrice: number;
  quantity: number;
  safetyStock: number;
  location: string;
  description: string;
  status: string;
  categoryName: string;
  supplierName: string;
  createdAt: string;
  updatedAt: string;
}

/** 库存是否低于或等于安全库存。 */
export function isLowStock(p: Pick<Product, "quantity" | "safetyStock">): boolean {
  return p.quantity <= p.safetyStock;
}

/** 是否已缺货。 */
export function isOutOfStock(p: Pick<Product, "quantity">): boolean {
  return p.quantity <= 0;
}

/** 库存成本总额。 */
export function stockValue(p: Pick<Product, "quantity" | "costPrice">): number {
  return p.quantity * p.costPrice;
}

/** 按售价计算的预期销售额。 */
export function expectedRevenue(p: Pick<Product, "quantity" | "salePrice">): number {
  return p.quantity * p.salePrice;
}

/** 毛利率百分比（0-100），售价为 0 时返回 0。 */
export function grossMarginPercent(p: Pick<Product, "costPrice" | "salePrice">): number {
  if (p.salePrice <= 0) return 0;
  return ((p.salePrice - p.costPrice) / p.salePrice) * 100;
}

/** 库存水位标签，用于列表着色。 */
export function stockLevel(p: Pick<Product, "quantity" | "safetyStock">): "danger" | "warning" | "ok" {
  if (p.quantity <= 0) return "danger";
  if (isLowStock(p)) return "warning";
  return "ok";
}

// ---------------------------------------------------------------------------
// 库存流水
// ---------------------------------------------------------------------------

export type MovementType = "in" | "out" | "adjust" | "init";

export const ALL_MOVEMENT_TYPES: MovementType[] = ["in", "out", "adjust", "init"];

export function movementTypeLabel(t: MovementType | string): string {
  switch (t) {
    case "in":
      return "入库";
    case "out":
      return "出库";
    case "adjust":
      return "盘点调整";
    case "init":
      return "期初建账";
    default:
      return String(t);
  }
}

/** +1（增加库存）或 -1（减少库存）。 */
export function movementDirection(t: MovementType): number {
  return t === "in" || t === "init" ? 1 : -1;
}

export function movementTypeValid(t: string): t is MovementType {
  return (ALL_MOVEMENT_TYPES as string[]).includes(t);
}

export interface StockMovement {
  id: number;
  productId: number;
  type: MovementType;
  quantity: number;
  delta: number;
  unitPrice: number;
  beforeQty: number;
  afterQty: number;
  refNo: string;
  supplierId: number | null;
  operatorId: number;
  note: string;
  createdAt: string;
  productName: string;
  productSku: string;
  productUnit: string;
  operatorName: string;
  supplierName: string;
}

/** 本次变动的金额。 */
export function movementAmount(m: Pick<StockMovement, "quantity" | "unitPrice">): number {
  return m.quantity * m.unitPrice;
}

/** 带符号的数量文本，例如 "+12" / "-3"。 */
export function movementSignedQuantity(m: Pick<StockMovement, "delta">): string {
  return m.delta >= 0 ? `+${m.delta}` : String(m.delta);
}

// ---------------------------------------------------------------------------
// 会话与安全问题
// ---------------------------------------------------------------------------

export interface Session {
  id: number;
  userId: number;
  tokenHash: string;
  csrfToken: string;
  expiresAt: string;
  createdAt: string;
  userAgent: string;
  ip: string;
}

/** 找回密码要求的安全问题数量。 */
export const SECURITY_QUESTION_COUNT = 3;

export interface SecurityQuestion {
  id: number;
  userId: number;
  position: number;
  question: string;
  answerHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerInput {
  question: string;
  answer: string;
}

// ---------------------------------------------------------------------------
// 统计与报表
// ---------------------------------------------------------------------------

export interface DashboardStats {
  totalProducts: number;
  totalCategories: number;
  totalSuppliers: number;
  totalUsers: number;
  totalStock: number;
  stockValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  todayIn: number;
  todayOut: number;
  monthIn: number;
  monthOut: number;
  totalMovements: number;
}

export interface TrendPoint {
  label: string;
  in: number;
  out: number;
}

export function trendMaxValue(t: TrendPoint): number {
  return t.in > t.out ? t.in : t.out;
}

export interface CategoryStat {
  name: string;
  count: number;
  value: number;
}

export interface ProductStat {
  name: string;
  sku: string;
  quantity: number;
  value: number;
}
