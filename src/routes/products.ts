// 商品管理路由 —— 对应原 Go 版 internal/handlers/product.go。
//
// 路由注册顺序很关键：Hono 按注册顺序匹配，`/products/new` 与
// `/products/export` 必须先于 `/products/:id` 注册，否则会被当成一个 id。

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../context";
import { MAX_EXPORT_ROWS } from "../db/store";
import type { ProductFilter, ProductInput } from "../db/products";
import { csvResponse, timestampedFilename } from "../lib/csv";
import { isErrorCode } from "../lib/errors";
import { defaultString, formatFloat } from "../lib/format";
import { numberFieldError, parsePage, parsePerPage, parseInt64 } from "../lib/pagination";
import { formatDateTime } from "../lib/time";
import { roleCanWrite, roleLabel, stockValue, type Product } from "../types";
import { productDetailView, productFormView, productListView } from "../views/products";
import {
  businessErrorMessage,
  currentQueryWithoutPage,
  formFloat,
  formId,
  formInt,
  formValue,
  formValues,
  notFoundPage,
  redirectWith,
  render,
  serverError,
} from "./helpers";

export const productRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

productRoutes.get("/products", async (c) => {
  const store = c.get("store");
  const filter = parseProductFilter(c);

  try {
    const { products, pagination } = await store.listProducts(filter);
    const categories = await store.listAllCategories();
    const suppliers = await store.listAllSuppliers();

    return render(
      c,
      200,
      "商品管理",
      "products",
      {
        products,
        pagination,
        filter,
        categories,
        suppliers,
        query: currentQueryWithoutPage(c),
      },
      productListView,
    );
  } catch (err) {
    return serverError(c, err);
  }
});

/** 从查询参数构造筛选条件（对应 Go 版 parseProductFilter）。 */
function parseProductFilter(c: Context<AppEnv>): ProductFilter {
  return {
    search: c.req.query("q") ?? "",
    categoryId: parseInt64(c.req.query("category")),
    supplierId: parseInt64(c.req.query("supplier")),
    status: c.req.query("status") ?? "",
    lowStockOnly: c.req.query("low") === "1",
    sortBy: c.req.query("sort") ?? "",
    sortDir: c.req.query("dir") ?? "",
    page: parsePage(c.req.query("page")),
    perPage: parsePerPage(c.req.query("per_page")),
  };
}

// ---------------------------------------------------------------------------
// 导出（必须注册在 /products/:id 之前）
// ---------------------------------------------------------------------------

productRoutes.get("/products/export", async (c) => {
  const store = c.get("store");
  const logger = c.get("logger");
  const filter = parseProductFilter(c);

  let products: Product[];
  let truncated: boolean;
  try {
    ({ products, truncated } = await store.listProductsForExport(filter));
  } catch (err) {
    return serverError(c, err);
  }

  const header = [
    "SKU", "商品名称", "条码", "分类", "供应商", "单位",
    "进价", "售价", "当前库存", "安全库存", "库存金额", "库位", "状态", "更新时间",
  ];
  const rows: string[][] = products.map((p) => [
    p.sku,
    p.name,
    p.barcode,
    defaultString(p.categoryName, "未分类"),
    defaultString(p.supplierName, "-"),
    p.unit,
    formatFloat(p.costPrice, 2),
    formatFloat(p.salePrice, 2),
    String(p.quantity),
    String(p.safetyStock),
    formatFloat(stockValue(p), 2),
    p.location,
    p.status === "archived" ? "已归档" : "在售",
    formatDateTime(p.updatedAt),
  ]);

  // 被行数上限截断时，必须把这个事实写进**文件本身**（与流水导出一致）：
  // 导出是直接下载，页面上没有地方提示，拿着缺尾的数据去对账问题只会更大。
  if (truncated) {
    rows.push([
      `注意：符合条件的商品超过 ${MAX_EXPORT_ROWS} 条上限，本文件仅包含前 ${MAX_EXPORT_ROWS} 条，请收窄筛选条件后重新导出`,
    ]);
    logger.warn("商品导出被行数上限截断", {
      上限: MAX_EXPORT_ROWS,
      已导出: products.length,
    });
  }

  return csvResponse(timestampedFilename("商品列表"), header, rows);
});

// ---------------------------------------------------------------------------
// 新建（必须注册在 /products/:id 之前）
// ---------------------------------------------------------------------------

productRoutes.get("/products/new", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;
  return renderProductForm(c, 200, false, null, { unit: "件", status: "active" }, {});
});

productRoutes.post("/products", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;

  const store = c.get("store");
  const user = c.get("user")!;

  const input = await productInputFromForm(c);
  const values = await formValues(c, ["sku", "name", "barcode", "unit", "location", "description", "status"]);
  values.cost_price = await formValue(c, "cost_price");
  values.sale_price = await formValue(c, "sale_price");
  values.quantity = await formValue(c, "quantity");
  values.safety_stock = await formValue(c, "safety_stock");

  // 数字字段先显式校验：formFloat/formInt 对非法输入会静默回退 0，
  // 「进价填成 12,000 → 以 0 元落库且毫无提示」正是数据错误的经典来源。
  const numErrs = await productNumberErrors(c, true);
  if (Object.keys(numErrs).length > 0) {
    return renderProductForm(c, 422, false, null, values, numErrs);
  }

  try {
    const product = await store.createProduct(input, user.id);
    return redirectWith(c, `/products/${product.id}`, "success", `商品「${product.name}」创建成功`);
  } catch (err) {
    return renderProductForm(c, 422, false, null, values, productFormErrors(err));
  }
});

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

productRoutes.get("/products/:id", async (c) => {
  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  try {
    const product = await store.getProduct(id);
    if (!product) return notFoundPage(c);

    const movements = await store.listProductMovements(id, 20);
    return render(c, 200, product.name, "products", { product, movements }, productDetailView);
  } catch (err) {
    return serverError(c, err);
  }
});

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

productRoutes.get("/products/:id/edit", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;

  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  try {
    const product = await store.getProduct(id);
    if (!product) return notFoundPage(c);
    return renderProductForm(c, 200, true, product, valuesFromProduct(product), {});
  } catch (err) {
    return serverError(c, err);
  }
});

productRoutes.post("/products/:id", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;

  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  let product: Product | null;
  try {
    product = await store.getProduct(id);
  } catch (err) {
    return serverError(c, err);
  }
  if (!product) return notFoundPage(c);

  const input = await productInputFromForm(c);
  const values = valuesFromProduct(product);
  Object.assign(values, await formValues(c, ["sku", "name", "barcode", "unit", "location", "description", "status"]));
  values.cost_price = await formValue(c, "cost_price");
  values.sale_price = await formValue(c, "sale_price");
  values.safety_stock = await formValue(c, "safety_stock");
  values.category_id = await formValue(c, "category_id");
  values.supplier_id = await formValue(c, "supplier_id");

  // 数字字段显式校验（与新建一致；编辑不改库存数量，quantity 不校验）。
  const numErrs = await productNumberErrors(c, false);
  if (Object.keys(numErrs).length > 0) {
    return renderProductForm(c, 422, true, product, values, numErrs);
  }

  try {
    await store.updateProduct(id, input);
    return redirectWith(c, `/products/${id}`, "success", "商品信息已更新");
  } catch (err) {
    return renderProductForm(c, 422, true, product, values, productFormErrors(err));
  }
});

// ---------------------------------------------------------------------------
// 归档 / 恢复 与 删除
// ---------------------------------------------------------------------------

productRoutes.post("/products/:id/status", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;

  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  const status = await formValue(c, "status");
  const action = status === "archived" ? "已归档" : "已恢复为在售";

  try {
    await store.setProductStatus(id, status);
  } catch (err) {
    return redirectWith(c, `/products/${id}`, "error", businessErrorMessage(err));
  }
  return redirectWith(c, `/products/${id}`, "success", `商品${action}`);
});

productRoutes.post("/products/:id/delete", async (c) => {
  const denied = writeGuard(c);
  if (denied) return denied;

  const id = pathId(c);
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  try {
    await store.deleteProduct(id);
  } catch (err) {
    return redirectWith(c, `/products/${id}`, "error", businessErrorMessage(err));
  }
  return redirectWith(c, "/products", "success", "商品已删除");
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * 写权限检查 —— 对应 Go 版 h.canWrite。
 *
 * 无权限时已写出响应并返回该响应；有权限时返回 null。提示文案与原版一致：
 * 用「当前角色为「X」，没有修改数据的权限」说明原因，而不是丢一个空白 403。
 */
function writeGuard(c: Context<AppEnv>): Response | null {
  const user = c.get("user");
  if (!user) return redirectWith(c, "/login", "", "");
  if (!roleCanWrite(user.role)) {
    return redirectWith(c, "/", "error", `当前角色为「${roleLabel(user.role)}」，没有修改数据的权限`);
  }
  return null;
}

/** 渲染商品表单页（新建 / 编辑共用）。 */
async function renderProductForm(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  isEdit: boolean,
  product: Product | null,
  values: Record<string, string>,
  errors: Record<string, string>,
): Promise<Response> {
  const store = c.get("store");
  try {
    const categories = await store.listAllCategories();
    const suppliers = await store.listAllSuppliers();
    const title = isEdit ? "编辑商品" : "新建商品";

    return render(
      c,
      status,
      title,
      "products",
      { product, values, errors, categories, suppliers, isEdit },
      productFormView,
    );
  } catch (err) {
    return serverError(c, err);
  }
}

/**
 * 校验商品表单的数字字段。
 *
 * 空值视为未填（服务层取 0），非法输入必须报字段错误，不能静默归零落库。
 */
async function productNumberErrors(
  c: Context<AppEnv>,
  checkQuantity: boolean,
): Promise<Record<string, string>> {
  const errs: Record<string, string> = {};
  const add = async (key: string, label: string, integer: boolean): Promise<void> => {
    const raw = await formValue(c, key);
    const msg = numberFieldError(raw, label, integer);
    if (msg !== "") errs[key] = msg;
  };
  await add("cost_price", "进价", false);
  await add("sale_price", "售价", false);
  await add("safety_stock", "安全库存", true);
  if (checkQuantity) await add("quantity", "期初库存", true);
  return errs;
}

/** 把服务层错误映射成表单错误（冲突落到 sku 字段，其余落到 form）。 */
function productFormErrors(err: unknown): Record<string, string> {
  const errs: Record<string, string> = { form: businessErrorMessage(err) };
  if (isErrorCode(err, "invalidInput")) {
    errs.form = businessErrorMessage(err);
  }
  if (isErrorCode(err, "conflict")) {
    errs.sku = businessErrorMessage(err);
    delete errs.form;
  }
  return errs;
}

/** 从表单构造商品入参（对应 Go 版 productInputFromForm）。 */
async function productInputFromForm(c: Context<AppEnv>): Promise<ProductInput> {
  return {
    sku: await formValue(c, "sku"),
    name: await formValue(c, "name"),
    barcode: await formValue(c, "barcode"),
    categoryId: await formId(c, "category_id"),
    supplierId: await formId(c, "supplier_id"),
    unit: await formValue(c, "unit"),
    costPrice: await formFloat(c, "cost_price", 0),
    salePrice: await formFloat(c, "sale_price", 0),
    quantity: await formInt(c, "quantity", 0),
    safetyStock: await formInt(c, "safety_stock", 0),
    location: await formValue(c, "location"),
    description: await formValue(c, "description"),
    status: await formValue(c, "status"),
  };
}

/** 把商品实体转换为表单回填值（对应 Go 版 valuesFromProduct）。 */
function valuesFromProduct(p: Product): Record<string, string> {
  const m: Record<string, string> = {
    sku: p.sku,
    name: p.name,
    barcode: p.barcode,
    unit: p.unit,
    cost_price: formatFloat(p.costPrice, 2),
    sale_price: formatFloat(p.salePrice, 2),
    quantity: String(p.quantity),
    safety_stock: String(p.safetyStock),
    location: p.location,
    description: p.description,
    status: p.status,
  };
  if (p.categoryId !== null) m.category_id = String(p.categoryId);
  if (p.supplierId !== null) m.supplier_id = String(p.supplierId);
  return m;
}

/** 读取路径参数 {id}（对应 Go 版 pathID）：非法或非正数返回 null。 */
function pathId(c: Context<AppEnv>): number | null {
  return parseInt64(c.req.param("id"));
}
