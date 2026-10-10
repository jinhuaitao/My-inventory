// 库存作业路由 —— 对应原 Go 版 internal/handlers/stock.go。
//
// 路由表与原版一致：
//   GET  /stock/in                入库表单
//   POST /stock/in                入库提交
//   GET  /stock/out               出库表单
//   POST /stock/out               出库提交
//   GET  /stock/adjust            盘点表单
//   POST /stock/adjust            盘点提交
//   GET  /stock/movements/export  流水 CSV 导出（必须注册在 /stock/movements 之前）
//   GET  /stock/movements         流水列表
//   GET  /stock/low               库存预警

import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../context";
import type { MovementFilter } from "../db/movements";
import type { ProductFilter } from "../db/products";
import { MAX_EXPORT_ROWS } from "../db/store";
import { csvResponse, timestampedFilename } from "../lib/csv";
import { isAppError, isErrorCode } from "../lib/errors";
import { defaultString, formatFloat } from "../lib/format";
import { parsePage, parsePerPage, parseInt64 } from "../lib/pagination";
import { formatDateTime } from "../lib/time";
import {
  ALL_MOVEMENT_TYPES,
  movementAmount,
  movementSignedQuantity,
  movementTypeLabel,
  roleCanWrite,
  roleLabel,
} from "../types";
import {
  businessErrorMessage,
  currentQueryWithoutPage,
  formFloat,
  formId,
  formInt,
  formValue,
  formValues,
  redirectWith,
  render,
} from "./helpers";
import {
  lowStockView,
  movementsView,
  stockFormView,
  type StockFormData,
  type StockFormKind,
} from "../views/stock";

export const stockRoutes = new Hono<AppEnv>();

type Values = Record<string, string>;

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

/**
 * 写权限校验（对应 Go 版 handler.canWrite）。
 *
 * 无权限时已写出响应并返回它，调用方直接 return 即可；有权限返回 null。
 * 未登录时回登录页；角色不可写时按原版给出中文提示并回到首页。
 */
function guardWrite(c: Context<AppEnv>): Response | null {
  const user = c.get("user");
  if (!user) return redirectWith(c, "/login", "", "");
  if (!roleCanWrite(user.role)) {
    return redirectWith(c, "/", "error", `当前角色为「${roleLabel(user.role)}」，没有修改数据的权限`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 表单页
// ---------------------------------------------------------------------------

stockRoutes.get("/stock/in", async (c) => {
  const guard = guardWrite(c);
  if (guard) return guard;
  const preset = parseInt64(c.req.query("product_id")) ?? 0;
  return renderStockForm(c, 200, "in", preset, { quantity: "1" }, {});
});

stockRoutes.get("/stock/out", async (c) => {
  const guard = guardWrite(c);
  if (guard) return guard;
  const preset = parseInt64(c.req.query("product_id")) ?? 0;
  return renderStockForm(c, 200, "out", preset, { quantity: "1" }, {});
});

stockRoutes.get("/stock/adjust", async (c) => {
  const guard = guardWrite(c);
  if (guard) return guard;
  const preset = parseInt64(c.req.query("product_id")) ?? 0;
  return renderStockForm(c, 200, "adjust", preset, {}, {});
});

/** 渲染出入库 / 盘点共用的表单页。 */
async function renderStockForm(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  kind: StockFormKind,
  preset: number,
  values: Values,
  errors: Values,
): Promise<Response> {
  const store = c.get("store");

  // 商品下拉最多列出 200 条（与原版一致）；出入库、盘点共用同一份。
  const { products } = await store.listProducts({ page: 1, perPage: 200, sortBy: "name", sortDir: "asc" });
  const suppliers = await store.listAllSuppliers();

  let title: string;
  let active: string;
  switch (kind) {
    case "in":
      title = "商品入库";
      active = "stock-in";
      break;
    case "out":
      title = "商品出库";
      active = "stock-out";
      break;
    default:
      title = "库存盘点";
      active = "stock-adjust";
      break;
  }

  const data: StockFormData = { kind, products, suppliers, values, errors, presetId: preset };
  return render(c, status, title, active, data, stockFormView);
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

stockRoutes.post("/stock/in", async (c) => {
  const guard = guardWrite(c);
  if (guard) return guard;

  const store = c.get("store");
  const logger = c.get("logger");
  const user = c.get("user")!;

  const input = {
    productId: (await formId(c, "product_id")) ?? 0,
    quantity: await formInt(c, "quantity", 0),
    unitPrice: await formFloat(c, "unit_price", 0),
    refNo: await formValue(c, "ref_no"),
    supplierId: await formId(c, "supplier_id"),
    operatorId: user.id,
    note: await formValue(c, "note"),
  };
  const values = await stockFormValues(c);

  try {
    const movement = await store.applyMovement("in", input);
    logger.info("商品入库", { 商品: movement.productName, 数量: movement.quantity, 操作人: user.username });
    return redirectWith(
      c,
      "/stock/movements",
      "success",
      `入库成功：${movement.productName} +${movement.quantity} ${defaultString(movement.productUnit, "件")}，当前库存 ${movement.afterQty}`,
    );
  } catch (err) {
    return renderStockForm(c, 422, "in", input.productId, values, { form: movementFormError(err) });
  }
});

stockRoutes.post("/stock/out", async (c) => {
  const guard = guardWrite(c);
  if (guard) return guard;

  const store = c.get("store");
  const logger = c.get("logger");
  const user = c.get("user")!;

  const input = {
    productId: (await formId(c, "product_id")) ?? 0,
    quantity: await formInt(c, "quantity", 0),
    unitPrice: await formFloat(c, "unit_price", 0),
    refNo: await formValue(c, "ref_no"),
    supplierId: null,
    operatorId: user.id,
    note: await formValue(c, "note"),
  };
  const values = await stockFormValues(c);

  try {
    const movement = await store.applyMovement("out", input);
    logger.info("商品出库", { 商品: movement.productName, 数量: movement.quantity, 操作人: user.username });
    return redirectWith(
      c,
      "/stock/movements",
      "success",
      `出库成功：${movement.productName} -${movement.quantity} ${defaultString(movement.productUnit, "件")}，当前库存 ${movement.afterQty}`,
    );
  } catch (err) {
    return renderStockForm(c, 422, "out", input.productId, values, { form: movementFormError(err) });
  }
});

stockRoutes.post("/stock/adjust", async (c) => {
  const guard = guardWrite(c);
  if (guard) return guard;

  const store = c.get("store");
  const logger = c.get("logger");
  const user = c.get("user")!;

  const productId = (await formId(c, "product_id")) ?? 0;
  const targetQty = await formInt(c, "actual_quantity", -1);
  const note = await formValue(c, "note");

  const values = await stockFormValues(c);

  if (productId <= 0 || targetQty < 0) {
    return renderStockForm(c, 422, "adjust", productId, values, {
      form: "请选择商品并填写实际库存数量（不能为负数）",
    });
  }

  try {
    const movement = await store.adjustStock(productId, targetQty, note, user.id);
    logger.info("库存盘点", {
      商品: movement.productName,
      调整前: movement.beforeQty,
      调整后: movement.afterQty,
      操作人: user.username,
    });

    const diff = movement.delta;
    let msg: string;
    if (diff > 0) {
      msg = `盘点完成：${movement.productName} 库存 ${movement.beforeQty} → ${movement.afterQty}（盘盈 +${diff}）`;
    } else if (diff < 0) {
      msg = `盘点完成：${movement.productName} 库存 ${movement.beforeQty} → ${movement.afterQty}（盘亏 ${diff}）`;
    } else {
      msg = `盘点完成：${movement.productName} 库存无差异（${movement.afterQty}）`;
    }
    return redirectWith(c, "/stock/movements", "success", msg);
  } catch (err) {
    return renderStockForm(c, 422, "adjust", productId, values, { form: movementFormError(err) });
  }
});

/**
 * 业务错误 → 表单提示。
 *
 * 原版对「参数不合法 / 记录不存在」这两类直接展示 err.Error()，
 * 其余走 businessError()。对 notFound 而言两者不同：前者是「记录不存在」，
 * 后者是「记录不存在或已被删除」—— 表单场景要沿用前者，故单独处理。
 */
function movementFormError(err: unknown): string {
  if (isErrorCode(err, "invalidInput") || isErrorCode(err, "notFound")) {
    return isAppError(err) ? err.message : businessErrorMessage(err);
  }
  return businessErrorMessage(err);
}

/** 收集表单值用于校验失败回填。 */
async function stockFormValues(c: Context<AppEnv>): Promise<Values> {
  const v = await formValues(c, ["quantity", "unit_price", "ref_no", "note", "actual_quantity"]);
  v.product_id = await formValue(c, "product_id");
  v.supplier_id = await formValue(c, "supplier_id");
  return v;
}

// ---------------------------------------------------------------------------
// 流水列表
// ---------------------------------------------------------------------------

/** 解析流水筛选条件。 */
function parseMovementFilter(c: Context<AppEnv>): MovementFilter {
  return {
    keyword: c.req.query("q"),
    type: c.req.query("type"),
    productId: parseInt64(c.req.query("product")) ?? 0,
    startDate: c.req.query("start"),
    endDate: c.req.query("end"),
    page: parsePage(c.req.query("page")),
    perPage: parsePerPage(c.req.query("per_page")),
  };
}

/**
 * 还原查询串（不含 page），导出链接与分页链接共用。
 *
 * 列表页若给模板传空串，用户搜索后翻到第 2 页时筛选条件会全部丢失，
 * 看起来就像「搜索没生效」。
 */
function buildMovementQuery(f: MovementFilter): string {
  const pairs: [string, string][] = [];
  const add = (k: string, v: string) => pairs.push([k, v]);

  if (f.keyword) add("q", f.keyword);
  if (f.type) add("type", f.type);
  if (f.productId && f.productId > 0) add("product", String(f.productId));
  if (f.startDate) add("start", f.startDate);
  if (f.endDate) add("end", f.endDate);
  if (f.perPage && f.perPage !== 20) add("per_page", String(f.perPage));

  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

// ⚠️ 导出必须注册在 /stock/movements 之前（顺序敏感，与原版一致）。
stockRoutes.get("/stock/movements/export", async (c) => {
  const store = c.get("store");
  const logger = c.get("logger");
  const filter = parseMovementFilter(c);

  const { movements, truncated } = await store.listMovementsForExport(filter);

  const header = [
    "时间",
    "类型",
    "商品名称",
    "SKU",
    "变动数量",
    "变动前",
    "变动后",
    "单价",
    "金额",
    "单据号",
    "供应商",
    "操作人",
    "备注",
  ];
  const rows: string[][] = movements.map((m) => [
    formatDateTime(m.createdAt),
    movementTypeLabel(m.type),
    m.productName,
    m.productSku,
    movementSignedQuantity(m),
    String(m.beforeQty),
    String(m.afterQty),
    formatFloat(m.unitPrice, 2),
    formatFloat(movementAmount(m), 2),
    m.refNo,
    defaultString(m.supplierName, "-"),
    m.operatorName,
    m.note,
  ]);

  // 被行数上限截断时，必须把这个事实写进**文件本身**。
  // 导出走的是直接下载，页面上没有地方提示；只记一条日志的话，
  // 用户拿着缺了一截的 CSV 去对账，问题只会更大。
  if (truncated) {
    rows.push([
      `注意：符合条件的流水超过 ${MAX_EXPORT_ROWS} 条上限，本文件仅包含最近 ${MAX_EXPORT_ROWS} 条，请收窄时间范围后重新导出`,
    ]);
    logger.warn("流水导出被行数上限截断", {
      上限: MAX_EXPORT_ROWS,
      已导出: movements.length,
      开始日期: filter.startDate,
      结束日期: filter.endDate,
    });
  }

  return csvResponse(timestampedFilename("库存流水"), header, rows);
});

stockRoutes.get("/stock/movements", async (c) => {
  const store = c.get("store");
  const filter = parseMovementFilter(c);

  const { movements, pagination: pg } = await store.listMovements(filter);
  const { products } = await store.listProducts({ page: 1, perPage: 200, sortBy: "name", sortDir: "asc" });

  return render(
    c,
    200,
    "库存流水",
    "movements",
    {
      movements,
      pagination: pg,
      filter: {
        keyword: filter.keyword ?? "",
        type: filter.type ?? "",
        productId: filter.productId ?? 0,
        startDate: filter.startDate ?? "",
        endDate: filter.endDate ?? "",
      },
      products,
      types: ALL_MOVEMENT_TYPES,
      query: buildMovementQuery(filter),
    },
    movementsView,
  );
});

// ---------------------------------------------------------------------------
// 低库存
// ---------------------------------------------------------------------------

stockRoutes.get("/stock/low", async (c) => {
  const store = c.get("store");

  const filter: ProductFilter = {
    lowStockOnly: true,
    sortBy: "quantity",
    sortDir: "asc",
    page: parsePage(c.req.query("page")),
    perPage: parsePerPage(c.req.query("per_page")),
  };

  const { products, pagination: pg } = await store.listProducts(filter);

  // 顶部两个数字必须覆盖**全部**预警商品，因此走独立的聚合查询。
  // 早先这里是遍历当前页的 products 来数，分页后数出来的只是「本页」的构成：
  // 预警商品一旦超过一页（默认 20 条），这两个数字就会比实际小，
  // 而且列表还能翻页、数字却不再变，用户只会觉得统计坏了。
  const { outOfStock, lowStock } = await store.countLowStockBreakdown();

  return render(
    c,
    200,
    "库存预警",
    "low-stock",
    { products, pagination: pg, outOfStock, lowStock, query: currentQueryWithoutPage(c) },
    lowStockView,
  );
});
