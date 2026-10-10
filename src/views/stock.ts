// 库存作业页面 —— 对应原 Go 版 web/templates/stock/*.html。
//
// 入库 / 出库 / 盘点三张表单结构高度相似，这里用一个视图按 kind 分支渲染；
// 流水列表与库存预警各自独立。

import { formatMoney, formatNumber, truncate } from "../lib/format";
import type { Pagination } from "../lib/pagination";
import { formatDateTime } from "../lib/time";
import {
  isOutOfStock,
  movementAmount,
  movementSignedQuantity,
  movementTypeLabel,
  roleCanWrite,
  type MovementType,
  type Product,
  type StockMovement,
  type Supplier,
} from "../types";
import { html, type Html } from "./html";
import { empty, pagination } from "./partials";
import type { PageData, View } from "./render";
import { alertError, alertInfo } from "./ui";

type Values = Record<string, string>;
type Errors = Record<string, string>;

// ---------------------------------------------------------------------------
// 出入库 / 盘点表单
// ---------------------------------------------------------------------------

export type StockFormKind = "in" | "out" | "adjust";

export interface StockFormData {
  kind: StockFormKind;
  products: Product[];
  suppliers: Supplier[];
  values: Values;
  errors: Errors;
  /** 从 ?product_id= 带入的预选商品（补货入口用）。 */
  presetId: number;
}

export const stockFormView: View<StockFormData> = {
  content(pd) {
    switch (pd.data.kind) {
      case "in":
        return stockInForm(pd);
      case "out":
        return stockOutForm(pd);
      default:
        return stockAdjustForm(pd);
    }
  },
};

/**
 * 商品下拉的选项集合。
 *
 * 选中判定沿用原版：预选 ID（?product_id=）优先，其次是回填的 product_id。
 * 库存文案按作业类型区分 —— 盘点看的是「系统库存」，出入库看的是「库存」。
 */
function productOptions(data: StockFormData): Html {
  const selectedValue = data.values.product_id ?? "";
  const stockLabel = data.kind === "adjust" ? "系统库存" : "库存";
  return html`${data.products.map((p) => {
    const selected =
      String(data.presetId) === String(p.id) || selectedValue === String(p.id);
    return html`<option value="${p.id}"
                    data-qty="${p.quantity}" data-unit="${p.unit}"
                    data-cost="${p.costPrice.toFixed(2)}" data-sale="${p.salePrice.toFixed(2)}"
                    data-safety="${p.safetyStock}"
                    ${selected ? html`selected` : ""}>
              ${p.sku} · ${p.name}（${stockLabel} ${p.quantity} ${p.unit}）
            </option>`;
  })}`;
}

function supplierOptions(data: StockFormData): Html {
  const selected = data.values.supplier_id ?? "";
  return html`${data.suppliers.map(
    (s) => html`<option value="${s.id}" ${selected === String(s.id) ? html`selected` : ""}>${s.name}</option>`,
  )}`;
}

function stockInForm(pd: PageData<StockFormData>): Html {
  const { values, errors } = pd.data;
  return html`<div class="page page-narrow">

  <div class="page-head">
    <div>
      <h2 class="page-title">商品入库</h2>
      <p class="page-desc">录入采购到货、退货入库等业务。提交后系统会自动增加库存并生成一条入库流水。</p>
    </div>
    <div class="page-actions">
      <a href="/stock/movements" class="btn btn-ghost">查看流水</a>
    </div>
  </div>

  ${alertError(errors.form)}

  <form method="post" action="/stock/in" class="card form" id="stockForm">
    <input type="hidden" name="_csrf" value="${pd.csrf}">

    <div class="card-body">
      <div class="form-grid">
        <div class="field span-2">
          <label for="product_id">选择商品 <span class="req">*</span></label>
          <select id="product_id" name="product_id" class="select" required data-product-select autofocus>
            <option value="">请选择商品</option>
            ${productOptions(pd.data)}
          </select>
          <p class="field-hint" data-product-hint></p>
        </div>

        <div class="field">
          <label for="quantity">入库数量 <span class="req">*</span></label>
          <input type="number" id="quantity" name="quantity" min="1" step="1"
                 value="${values.quantity || "1"}" class="input" required>
          <p class="field-hint" data-qty-hint></p>
        </div>

        <div class="field">
          <label for="unit_price">入库单价（元）</label>
          <input type="number" id="unit_price" name="unit_price" min="0" step="0.01"
                 value="${values.unit_price ?? ""}" class="input" placeholder="默认取商品进价"
                 data-cost-input>
        </div>

        <div class="field">
          <label for="supplier_id">供应商</label>
          <select id="supplier_id" name="supplier_id" class="select">
            <option value="">未指定</option>
            ${supplierOptions(pd.data)}
          </select>
        </div>

        <div class="field">
          <label for="ref_no">单据号</label>
          <input type="text" id="ref_no" name="ref_no" value="${values.ref_no ?? ""}"
                 class="input" placeholder="例如 PO-20260928-001">
        </div>

        <div class="field span-2">
          <label for="note">备注</label>
          <textarea id="note" name="note" rows="2" class="input textarea"
                    placeholder="选填，例如到货批次、验收情况">${values.note ?? ""}</textarea>
        </div>
      </div>

      <div class="calc-preview" data-calc-preview hidden>
        <span class="calc-label">本次入库金额</span>
        <span class="calc-value" data-calc-value>¥0.00</span>
      </div>
    </div>

    <div class="card-foot form-actions">
      <a href="/products" class="btn btn-ghost">取消</a>
      <button type="submit" class="btn btn-primary">确认入库</button>
    </div>
  </form>

</div>`;
}

function stockOutForm(pd: PageData<StockFormData>): Html {
  const { values, errors } = pd.data;
  return html`<div class="page page-narrow">

  <div class="page-head">
    <div>
      <h2 class="page-title">商品出库</h2>
      <p class="page-desc">录入销售发货、领用等业务。系统会校验库存是否充足，不足时拒绝出库。</p>
    </div>
    <div class="page-actions">
      <a href="/stock/movements" class="btn btn-ghost">查看流水</a>
    </div>
  </div>

  ${alertError(errors.form)}

  <form method="post" action="/stock/out" class="card form" id="stockForm">
    <input type="hidden" name="_csrf" value="${pd.csrf}">

    <div class="card-body">
      <div class="form-grid">
        <div class="field span-2">
          <label for="product_id">选择商品 <span class="req">*</span></label>
          <select id="product_id" name="product_id" class="select" required data-product-select autofocus>
            <option value="">请选择商品</option>
            ${productOptions(pd.data)}
          </select>
          <p class="field-hint" data-product-hint></p>
        </div>

        <div class="field">
          <label for="quantity">出库数量 <span class="req">*</span></label>
          <input type="number" id="quantity" name="quantity" min="1" step="1"
                 value="${values.quantity || "1"}" class="input" required>
          <p class="field-hint" data-qty-hint></p>
        </div>

        <div class="field">
          <label for="unit_price">出库单价（元）</label>
          <input type="number" id="unit_price" name="unit_price" min="0" step="0.01"
                 value="${values.unit_price ?? ""}" class="input" placeholder="默认取商品售价"
                 data-sale-input>
        </div>

        <div class="field span-2">
          <label for="ref_no">单据号</label>
          <input type="text" id="ref_no" name="ref_no" value="${values.ref_no ?? ""}"
                 class="input" placeholder="例如 SO-20260928-001">
        </div>

        <div class="field span-2">
          <label for="note">备注</label>
          <textarea id="note" name="note" rows="2" class="input textarea"
                    placeholder="选填，例如领用部门、客户名称">${values.note ?? ""}</textarea>
        </div>
      </div>

      <div class="calc-preview" data-calc-preview hidden>
        <span class="calc-label">本次出库金额</span>
        <span class="calc-value" data-calc-value>¥0.00</span>
      </div>
    </div>

    <div class="card-foot form-actions">
      <a href="/products" class="btn btn-ghost">取消</a>
      <button type="submit" class="btn btn-primary">确认出库</button>
    </div>
  </form>

</div>`;
}

function stockAdjustForm(pd: PageData<StockFormData>): Html {
  const { values, errors } = pd.data;
  return html`<div class="page page-narrow">

  <div class="page-head">
    <div>
      <h2 class="page-title">库存盘点</h2>
      <p class="page-desc">
        盘点后直接把系统库存修正为实际盘点数量。系统会记录盘盈 / 盘亏差异，便于后续追溯。
      </p>
    </div>
    <div class="page-actions">
      <a href="/stock/movements?type=adjust" class="btn btn-ghost">盘点记录</a>
    </div>
  </div>

  ${alertError(errors.form)}

  <form method="post" action="/stock/adjust" class="card form" id="stockForm">
    <input type="hidden" name="_csrf" value="${pd.csrf}">

    <div class="card-body">
      <div class="form-grid">
        <div class="field span-2">
          <label for="product_id">选择商品 <span class="req">*</span></label>
          <select id="product_id" name="product_id" class="select" required data-product-select autofocus>
            <option value="">请选择商品</option>
            ${productOptions(pd.data)}
          </select>
          <p class="field-hint" data-product-hint></p>
        </div>

        <div class="field">
          <label for="actual_quantity">实际盘点数量 <span class="req">*</span></label>
          <input type="number" id="actual_quantity" name="actual_quantity" min="0" step="1"
                 value="${values.actual_quantity ?? ""}" class="input" required>
          <p class="field-hint" data-qty-hint></p>
        </div>

        <div class="field">
          <label>差异预览</label>
          <div class="diff-preview" data-diff-preview>—</div>
        </div>

        <div class="field span-2">
          <label for="note">盘点说明</label>
          <textarea id="note" name="note" rows="2" class="input textarea"
                    placeholder="选填，例如盘点日期、差异原因">${values.note ?? ""}</textarea>
        </div>
      </div>

      ${alertInfo("盘点会直接覆盖系统库存，请确认实际数量准确无误。")}
    </div>

    <div class="card-foot form-actions">
      <a href="/products" class="btn btn-ghost">取消</a>
      <button type="submit" class="btn btn-primary">提交盘点结果</button>
    </div>
  </form>

</div>`;
}

// ---------------------------------------------------------------------------
// 流水列表
// ---------------------------------------------------------------------------

export interface MovementFilterData {
  keyword: string;
  type: string;
  productId: number;
  startDate: string;
  endDate: string;
}

export interface MovementsData {
  movements: StockMovement[];
  pagination: Pagination;
  filter: MovementFilterData;
  products: Product[];
  types: MovementType[];
  /** 不含 page 的查询串，导出链接与分页链接共用。 */
  query: string;
}

export const movementsView: View<MovementsData> = {
  content(pd) {
    const { movements, pagination: pg, filter, products, types, query } = pd.data;
    const canWrite = pd.user ? roleCanWrite(pd.user.role) : false;

    return html`<div class="page">

  <div class="page-head">
    <div>
      <h2 class="page-title">库存流水</h2>
      <p class="page-desc">记录每一次库存变动，共 ${formatNumber(pg.total)} 条记录</p>
    </div>
    <div class="page-actions">
      <a href="/stock/movements/export?${query}" class="btn btn-outline">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M3 19h18"/></svg>
        导出 CSV
      </a>
      ${canWrite ? html`<a href="/stock/in" class="btn btn-primary">商品入库</a>` : ""}
    </div>
  </div>

  <form method="get" action="/stock/movements" class="filter-bar">
    <div class="filter-search">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input type="search" name="q" value="${filter.keyword}" placeholder="搜索商品 / SKU / 单号 / 备注">
    </div>

    <select name="type" class="select">
      <option value="">全部类型</option>
      ${types.map(
        (t) =>
          html`<option value="${t}" ${filter.type === t ? html`selected` : ""}>${movementTypeLabel(t)}</option>`,
      )}
    </select>

    <select name="product" class="select">
      <option value="">全部商品</option>
      ${products.map(
        (p) =>
          html`<option value="${p.id}" ${filter.productId === p.id ? html`selected` : ""}>${truncate(p.name, 18)}</option>`,
      )}
    </select>

    <input type="date" name="start" value="${filter.startDate}" class="input date-input" title="开始日期">
    <input type="date" name="end" value="${filter.endDate}" class="input date-input" title="结束日期">

    <button type="submit" class="btn btn-secondary">筛选</button>
    <a href="/stock/movements" class="btn btn-ghost">重置</a>
  </form>

  <div class="card">
    <div class="card-body no-pad">
      ${movements.length > 0
        ? html`<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>商品</th>
              <th class="num">变动</th>
              <th class="num">变动前</th>
              <th class="num">变动后</th>
              <th class="num">单价</th>
              <th class="num">金额</th>
              <th>单据号</th>
              <th>供应商</th>
              <th>操作人</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            ${movements.map((m) => movementRow(m))}
          </tbody>
        </table>
      </div>`
        : empty({
            title: "暂无库存流水",
            hint: "执行入库、出库或盘点后，这里会记录每一次变动",
            actionUrl: "/stock/in",
            actionLabel: "去入库",
          })}
    </div>
    <div class="card-foot">${pagination(pg, query)}</div>
  </div>

</div>`;
  },
};

function movementRow(m: StockMovement): Html {
  return html`<tr>
              <td class="muted nowrap">${formatDateTime(m.createdAt)}</td>
              <td>${movementBadge(m.type)}</td>
              <td>
                <a href="/products/${m.productId}" class="cell-link">${truncate(m.productName, 18)}</a>
                <div class="cell-sub">${m.productSku}</div>
              </td>
              <td class="num ${m.delta < 0 ? "text-out" : "text-in"} strong">${movementSignedQuantity(m)}</td>
              <td class="num muted">${formatNumber(m.beforeQty)}</td>
              <td class="num">${formatNumber(m.afterQty)}</td>
              <td class="num">${formatMoney(m.unitPrice)}</td>
              <td class="num">${formatMoney(movementAmount(m))}</td>
              <td class="mono">${m.refNo || "—"}</td>
              <td class="muted">${m.supplierName || "—"}</td>
              <td>${m.operatorName}</td>
              <td class="muted">${truncate(m.note || "—", 18)}</td>
            </tr>`;
}

function movementBadge(t: string): Html {
  if (t === "in") return html`<span class="badge badge-in">入库</span>`;
  if (t === "out") return html`<span class="badge badge-out">出库</span>`;
  if (t === "adjust") return html`<span class="badge badge-adjust">盘点</span>`;
  return html`<span class="badge badge-muted">期初</span>`;
}

// ---------------------------------------------------------------------------
// 库存预警
// ---------------------------------------------------------------------------

export interface LowStockData {
  products: Product[];
  pagination: Pagination;
  outOfStock: number;
  lowStock: number;
  /** 不含 page 的查询串，供分页链接复用。 */
  query: string;
}

export const lowStockView: View<LowStockData> = {
  content(pd) {
    const { products, pagination: pg, outOfStock, lowStock, query } = pd.data;
    const canWrite = pd.user ? roleCanWrite(pd.user.role) : false;

    return html`<div class="page">

  <div class="page-head">
    <div>
      <h2 class="page-title">库存预警</h2>
      <p class="page-desc">库存低于或等于安全库存的商品，共 ${formatNumber(pg.total)} 项</p>
    </div>
    <div class="page-actions">
      <a href="/products/export?low=1" class="btn btn-outline">导出清单</a>
      ${canWrite ? html`<a href="/stock/in" class="btn btn-primary">批量补货</a>` : ""}
    </div>
  </div>

  <section class="stat-grid stat-grid-3">
    <div class="stat-card alert-card">
      <div class="stat-label">预警商品</div>
      <div class="stat-value">${formatNumber(pg.total)}</div>
      <div class="stat-foot">需要关注补货</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">已缺货</div>
      <div class="stat-value text-danger">${formatNumber(outOfStock)}</div>
      <div class="stat-foot">当前库存为 0</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">库存偏低</div>
      <div class="stat-value text-warning">${formatNumber(lowStock)}</div>
      <div class="stat-foot">低于安全库存但仍有存货</div>
    </div>
  </section>

  <div class="card">
    <div class="card-body no-pad">
      ${products.length > 0
        ? html`<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>商品</th>
              <th>分类</th>
              <th class="num">当前库存</th>
              <th class="num">安全库存</th>
              <th class="num">缺口</th>
              <th>库位</th>
              <th>供应商</th>
              <th class="actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            ${products.map((p) => lowStockRow(p, canWrite))}
          </tbody>
        </table>
      </div>`
        : html`<div class="empty-state success">
        <div class="empty-icon success">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>
        </div>
        <p class="empty-title">所有商品库存充足</p>
        <p class="empty-hint">当前没有低于安全库存的商品，继续保持</p>
      </div>`}
    </div>
    <div class="card-foot">${pagination(pg, query)}</div>
  </div>

</div>`;
  },
};

function lowStockRow(p: Product, canWrite: boolean): Html {
  return html`<tr>
              <td>
                <a href="/products/${p.id}" class="cell-link">${p.name}</a>
                <div class="cell-sub">${p.sku}</div>
              </td>
              <td>${p.categoryName ? html`<span class="chip">${p.categoryName}</span>` : html`<span class="muted">未分类</span>`}</td>
              <td class="num">
                ${isOutOfStock(p)
                  ? html`<span class="badge badge-danger">缺货</span>`
                  : html`<span class="text-warning strong">${formatNumber(p.quantity)}</span>`}
                <span class="unit">${p.unit}</span>
              </td>
              <td class="num muted">${formatNumber(p.safetyStock)}</td>
              <td class="num strong text-warning">${formatNumber(p.safetyStock - p.quantity)}</td>
              <td class="muted">${p.location || "—"}</td>
              <td class="muted">${p.supplierName || "—"}</td>
              <td class="actions-col">
                ${canWrite
                  ? html`<a href="/stock/in?product_id=${p.id}" class="btn btn-xs btn-primary">补货</a>`
                  : ""}
              </td>
            </tr>`;
}
