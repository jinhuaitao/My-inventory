// 商品管理页面 —— 对应原 Go 版 web/templates/products/list.html、
// form.html、detail.html 三个模板。

import type { ProductFilter } from "../db/products";
import { barHeight, formatFloat, formatMoney, formatNumber } from "../lib/format";
import type { Pagination } from "../lib/pagination";
import { formatDate, formatDateTime } from "../lib/time";
import {
  expectedRevenue,
  grossMarginPercent,
  isLowStock,
  isOutOfStock,
  movementSignedQuantity,
  roleCanWrite,
  stockValue,
  type Category,
  type Product,
  type StockMovement,
  type Supplier,
} from "../types";
import { html, type Html } from "./html";
import { empty, pagination } from "./partials";
import type { View } from "./render";
import { alertError, fieldError } from "./ui";

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

export interface ProductListData {
  products: Product[];
  pagination: Pagination;
  filter: ProductFilter;
  categories: Category[];
  suppliers: Supplier[];
  /** 不含 page 的查询串，供导出链接与分页复用。 */
  query: string;
}

export const productListView: View<ProductListData> = {
  content(pd) {
    const d = pd.data;
    const canWrite = pd.user ? roleCanWrite(pd.user.role) : false;

    return html`<div class="page">

  <div class="page-head">
    <div>
      <h2 class="page-title">商品列表</h2>
      <p class="page-desc">共 ${formatNumber(d.pagination.total)} 个商品</p>
    </div>
    <div class="page-actions">
      <a href="/products/export?${d.query}" class="btn btn-outline">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M3 19h18"/></svg>
        导出 CSV
      </a>
      ${canWrite
        ? html`<a href="/products/new" class="btn btn-primary">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        新建商品
      </a>`
        : ""}
    </div>
  </div>

  <form method="get" action="/products" class="filter-bar">
    <div class="filter-search">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input type="search" name="q" value="${d.filter.search ?? ""}" placeholder="搜索商品名称 / SKU / 条码 / 库位">
    </div>

    <select name="category" class="select">
      <option value="">全部分类</option>
      ${d.categories.map(
        (cat) =>
          html`<option value="${cat.id}" ${d.filter.categoryId === cat.id ? "selected" : ""}>${cat.name}</option>`,
      )}
    </select>

    <select name="supplier" class="select">
      <option value="">全部供应商</option>
      ${d.suppliers.map(
        (sup) =>
          html`<option value="${sup.id}" ${d.filter.supplierId === sup.id ? "selected" : ""}>${sup.name}</option>`,
      )}
    </select>

    <select name="status" class="select">
      <option value="" ${d.filter.status === "" ? "selected" : ""}>在售商品</option>
      <option value="all" ${d.filter.status === "all" ? "selected" : ""}>全部状态</option>
      <option value="archived" ${d.filter.status === "archived" ? "selected" : ""}>已归档</option>
    </select>

    <label class="checkbox">
      <input type="checkbox" name="low" value="1" ${d.filter.lowStockOnly ? "checked" : ""}>
      <span>仅看预警</span>
    </label>

    <button type="submit" class="btn btn-secondary">筛选</button>
    <a href="/products" class="btn btn-ghost">重置</a>
  </form>

  <div class="card">
    <div class="card-body no-pad">
      ${d.products.length > 0
        ? html`<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>商品名称</th>
              <th>分类</th>
              <th class="num">库存</th>
              <th class="num">安全库存</th>
              <th class="num">进价</th>
              <th class="num">售价</th>
              <th class="num">库存价值</th>
              <th>状态</th>
              <th class="actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            ${d.products.map((p) => productRow(p, canWrite))}
          </tbody>
        </table>
      </div>`
        : empty({
            title: "没有找到符合条件的商品",
            hint: "尝试调整筛选条件，或新建一个商品",
            actionUrl: "/products/new",
            actionLabel: "新建商品",
          })}
    </div>

    <div class="card-foot">
      ${pagination(d.pagination, d.query)}
    </div>
  </div>
</div>`;
  },
};

function productRow(p: Product, canWrite: boolean): Html {
  return html`<tr>
              <td><span class="mono">${p.sku}</span></td>
              <td>
                <a href="/products/${p.id}" class="cell-link">${p.name}</a>
                ${p.barcode ? html`<div class="cell-sub">条码 ${p.barcode}</div>` : ""}
                ${p.location ? html`<div class="cell-sub">库位 ${p.location}</div>` : ""}
              </td>
              <td>
                ${p.categoryName
                  ? html`<span class="chip">${p.categoryName}</span>`
                  : html`<span class="muted">未分类</span>`}
              </td>
              <td class="num">
                ${isOutOfStock(p)
                  ? html`<span class="badge badge-danger">缺货</span>`
                  : isLowStock(p)
                    ? html`<span class="badge badge-warning">${formatNumber(p.quantity)}</span>`
                    : html`<span class="strong">${formatNumber(p.quantity)}</span>`}
                <span class="unit">${p.unit}</span>
              </td>
              <td class="num muted">${formatNumber(p.safetyStock)}</td>
              <td class="num">${formatMoney(p.costPrice)}</td>
              <td class="num">${formatMoney(p.salePrice)}</td>
              <td class="num strong">${formatMoney(stockValue(p))}</td>
              <td>
                ${p.status === "archived"
                  ? html`<span class="badge badge-muted">已归档</span>`
                  : html`<span class="badge badge-success">在售</span>`}
              </td>
              <td class="actions-col">
                <div class="row-actions">
                  ${canWrite
                    ? html`<a href="/stock/in?product_id=${p.id}" class="icon-action" title="入库">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v8"/><path d="M9 9l3 3 3-3"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/></svg>
                  </a>
                  <a href="/stock/out?product_id=${p.id}" class="icon-action" title="出库">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12V4"/><path d="M9 7l3-3 3 3"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/></svg>
                  </a>
                  <a href="/products/${p.id}/edit" class="icon-action" title="编辑">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg>
                  </a>`
                    : ""}
                  <a href="/products/${p.id}" class="icon-action" title="详情">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/></svg>
                  </a>
                </div>
              </td>
            </tr>`;
}

// ---------------------------------------------------------------------------
// 新建 / 编辑表单
// ---------------------------------------------------------------------------

export interface ProductFormData {
  product: Product | null;
  values: Record<string, string>;
  errors: Record<string, string>;
  categories: Category[];
  suppliers: Supplier[];
  isEdit: boolean;
}

export const productFormView: View<ProductFormData> = {
  content(pd) {
    const d = pd.data;
    const isEdit = d.isEdit;
    const backUrl = isEdit && d.product ? `/products/${d.product.id}` : "/products";

    return html`<div class="page page-narrow">

  <div class="page-head">
    <div>
      <h2 class="page-title">${isEdit ? "编辑商品" : "新建商品"}</h2>
      <p class="page-desc">
        ${isEdit
          ? "修改商品基础资料。库存数量请通过「入库 / 出库 / 盘点」调整，以保证流水可追溯。"
          : "填写商品基础信息。若已有现货，可在「期初库存」中直接录入，系统会自动生成期初流水。"}
      </p>
    </div>
    <div class="page-actions">
      <a href="${backUrl}" class="btn btn-ghost">返回</a>
    </div>
  </div>

  ${alertError(d.errors.form)}

  <form method="post"
        action="${backUrl}"
        class="card form">
    <input type="hidden" name="_csrf" value="${pd.csrf}">

    <div class="card-body">
      <h3 class="section-title">基本信息</h3>

      <div class="form-grid">
        <div class="field">
          <label for="sku">SKU 编码 <span class="req">*</span></label>
          <input type="text" id="sku" name="sku" value="${d.values.sku ?? ""}"
                 class="input ${d.errors.sku ? "is-invalid" : ""}"
                 placeholder="例如 SKU-1001" required>
          ${fieldError(d.errors.sku)}
        </div>

        <div class="field">
          <label for="name">商品名称 <span class="req">*</span></label>
          <input type="text" id="name" name="name" value="${d.values.name ?? ""}"
                 class="input ${d.errors.name ? "is-invalid" : ""}"
                 placeholder="例如 Type-C 数据线 1m" required>
          ${fieldError(d.errors.name)}
        </div>

        <div class="field">
          <label for="barcode">条形码</label>
          <input type="text" id="barcode" name="barcode" value="${d.values.barcode ?? ""}"
                 class="input" placeholder="选填">
        </div>

        <div class="field">
          <label for="unit">计量单位</label>
          <input type="text" id="unit" name="unit" value="${d.values.unit ?? ""}"
                 class="input" placeholder="件 / 箱 / 包">
        </div>

        <div class="field">
          <label for="category_id">所属分类</label>
          <select id="category_id" name="category_id" class="select">
            <option value="">未分类</option>
            ${d.categories.map(
              (cat) =>
                html`<option value="${cat.id}" ${d.values.category_id === String(cat.id) ? "selected" : ""}>${cat.name}</option>`,
            )}
          </select>
        </div>

        <div class="field">
          <label for="supplier_id">默认供应商</label>
          <select id="supplier_id" name="supplier_id" class="select">
            <option value="">未指定</option>
            ${d.suppliers.map(
              (sup) =>
                html`<option value="${sup.id}" ${d.values.supplier_id === String(sup.id) ? "selected" : ""}>${sup.name}</option>`,
            )}
          </select>
        </div>

        <div class="field">
          <label for="location">库位</label>
          <input type="text" id="location" name="location" value="${d.values.location ?? ""}"
                 class="input" placeholder="例如 A-01-03">
        </div>

        <div class="field">
          <label for="status">状态</label>
          <select id="status" name="status" class="select">
            <option value="active" ${d.values.status === "active" ? "selected" : ""}>在售</option>
            <option value="archived" ${d.values.status === "archived" ? "selected" : ""}>已归档</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card-body border-top">
      <h3 class="section-title">价格与库存</h3>

      <div class="form-grid">
        <div class="field">
          <label for="cost_price">进价（元）</label>
          <input type="number" id="cost_price" name="cost_price" step="0.01" min="0"
                 value="${d.values.cost_price ?? ""}" class="input" placeholder="0.00">
          ${fieldError(d.errors.cost_price)}
        </div>

        <div class="field">
          <label for="sale_price">售价（元）</label>
          <input type="number" id="sale_price" name="sale_price" step="0.01" min="0"
                 value="${d.values.sale_price ?? ""}" class="input" placeholder="0.00">
          ${fieldError(d.errors.sale_price)}
        </div>

        <div class="field">
          <label for="safety_stock">安全库存</label>
          <input type="number" id="safety_stock" name="safety_stock" min="0"
                 value="${d.values.safety_stock ?? ""}" class="input" placeholder="低于该值将触发预警">
          ${fieldError(d.errors.safety_stock)}
        </div>

        <div class="field">
          <label for="quantity">
            ${isEdit ? "当前库存" : "期初库存"}
            ${isEdit ? html`<span class="hint-inline">（不可直接修改）</span>` : ""}
          </label>
          ${isEdit
            ? html`<input type="text" id="quantity" class="input" value="${formatNumber(d.product?.quantity ?? 0)}" disabled>`
            : html`<input type="number" id="quantity" name="quantity" min="0"
                   value="${d.values.quantity ?? ""}" class="input" placeholder="0">
                   ${fieldError(d.errors.quantity)}`}
        </div>
      </div>
    </div>

    <div class="card-body border-top">
      <h3 class="section-title">备注</h3>
      <div class="field">
        <textarea id="description" name="description" class="input textarea" rows="3"
                  placeholder="选填，例如规格、品牌、采购注意事项">${d.values.description ?? ""}</textarea>
      </div>
    </div>

    <div class="card-foot form-actions">
      <a href="${backUrl}" class="btn btn-ghost">取消</a>
      <button type="submit" class="btn btn-primary">${isEdit ? "保存修改" : "创建商品"}</button>
    </div>
  </form>

</div>`;
  },
};

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

export interface ProductDetailData {
  product: Product;
  movements: StockMovement[];
}

export const productDetailView: View<ProductDetailData> = {
  content(pd) {
    const p = pd.data.product;
    const movements = pd.data.movements;
    const canWrite = pd.user ? roleCanWrite(pd.user.role) : false;

    return html`<div class="page">

  <div class="page-head">
    <div>
      <div class="breadcrumb">
        <a href="/products">商品管理</a>
        <span>/</span>
        <span>${p.name}</span>
      </div>
      <h2 class="page-title">${p.name}</h2>
      <p class="page-desc">
        <span class="mono">${p.sku}</span>
        ${p.barcode ? html` · 条码 ${p.barcode}` : ""}
        ${p.status === "archived" ? html` · <span class="badge badge-muted">已归档</span>` : ""}
      </p>
    </div>
    <div class="page-actions">
      ${canWrite
        ? html`<a href="/stock/in?product_id=${p.id}" class="btn btn-outline">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M8 8l4 4 4-4"/><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/></svg>
        入库
      </a>
      <a href="/stock/out?product_id=${p.id}" class="btn btn-outline">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 13V4"/><path d="M8 8l4-4 4 4"/><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/></svg>
        出库
      </a>
      <a href="/stock/adjust?product_id=${p.id}" class="btn btn-outline">盘点</a>
      <a href="/products/${p.id}/edit" class="btn btn-primary">编辑</a>`
        : ""}
    </div>
  </div>

  <!-- 库存概览 -->
  <section class="stat-grid stat-grid-4">
    <div class="stat-card">
      <div class="stat-label">当前库存</div>
      <div class="stat-value ${isOutOfStock(p) ? "text-danger" : isLowStock(p) ? "text-warning" : ""}">
        ${formatNumber(p.quantity)} <span class="stat-unit">${p.unit}</span>
      </div>
      <div class="stat-foot">
        ${isOutOfStock(p)
          ? "已缺货，请尽快补货"
          : isLowStock(p)
            ? html`低于安全库存（${formatNumber(p.safetyStock)}）`
            : "库存充足"}
      </div>
    </div>

    <div class="stat-card">
      <div class="stat-label">库存价值</div>
      <div class="stat-value">${formatMoney(stockValue(p))}</div>
      <div class="stat-foot">按进价 ${formatMoney(p.costPrice)} 计算</div>
    </div>

    <div class="stat-card">
      <div class="stat-label">售价 / 毛利率</div>
      <div class="stat-value">${formatMoney(p.salePrice)}</div>
      <div class="stat-foot">
        ${p.salePrice > 0
          ? html`毛利率 ${formatFloat(grossMarginPercent(p), 1)}%`
          : "未设置售价"}
      </div>
    </div>

    <div class="stat-card">
      <div class="stat-label">最近更新</div>
      <div class="stat-value sm">${formatDateTime(p.updatedAt)}</div>
      <div class="stat-foot">创建于 ${formatDate(p.createdAt)}</div>
    </div>
  </section>

  <div class="grid-2">
    <section class="card">
      <div class="card-head"><h2 class="card-title">基础信息</h2></div>
      <div class="card-body">
        <dl class="detail-list">
          <div class="detail-row"><dt>SKU 编码</dt><dd class="mono">${p.sku}</dd></div>
          <div class="detail-row"><dt>条形码</dt><dd>${p.barcode || "—"}</dd></div>
          <div class="detail-row"><dt>所属分类</dt><dd>${p.categoryName || "未分类"}</dd></div>
          <div class="detail-row"><dt>默认供应商</dt>
            <dd>${p.supplierId ? html`<a href="/suppliers/${p.supplierId}" class="link">${p.supplierName}</a>` : "—"}</dd>
          </div>
          <div class="detail-row"><dt>计量单位</dt><dd>${p.unit || "—"}</dd></div>
          <div class="detail-row"><dt>库位</dt><dd>${p.location || "—"}</dd></div>
          <div class="detail-row"><dt>安全库存</dt><dd>${formatNumber(p.safetyStock)}</dd></div>
          <div class="detail-row"><dt>备注</dt><dd>${p.description || "—"}</dd></div>
        </dl>
      </div>
      ${canWrite
        ? html`<div class="card-foot form-actions">
        <form method="post" action="/products/${p.id}/status" class="inline-form">
          <input type="hidden" name="_csrf" value="${pd.csrf}">
          ${p.status === "archived"
            ? html`<input type="hidden" name="status" value="active">
            <button type="submit" class="btn btn-outline btn-sm">恢复为在售</button>`
            : html`<input type="hidden" name="status" value="archived">
            <button type="submit" class="btn btn-outline btn-sm">归档该商品</button>`}
        </form>
        <form method="post" action="/products/${p.id}/delete" class="inline-form"
              data-confirm="确定要删除商品「${p.name}」吗？此操作不可撤销。">
          <input type="hidden" name="_csrf" value="${pd.csrf}">
          <button type="submit" class="btn btn-danger-ghost btn-sm">删除</button>
        </form>
      </div>`
        : ""}
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">库存水位</h2>
      </div>
      <div class="card-body">
        <div class="gauge">
          <div class="gauge-head">
            <span>当前 ${formatNumber(p.quantity)} ${p.unit}</span>
            <span class="muted">安全库存 ${formatNumber(p.safetyStock)}</span>
          </div>
          <div class="gauge-track">
            <div class="gauge-fill ${isOutOfStock(p) ? "danger" : isLowStock(p) ? "warning" : ""}"
                 style="width: ${barHeight(p.quantity, Math.max(p.safetyStock * 3, Math.max(p.quantity, 1)))}%"></div>
          </div>
          <div class="gauge-marks">
            <span>0</span>
            <span>安全线 ${formatNumber(p.safetyStock)}</span>
            <span>${formatNumber(p.safetyStock * 3)}</span>
          </div>
        </div>

        <div class="mini-stats">
          <div class="mini-stat">
            <span class="mini-label">库存金额</span>
            <span class="mini-value">${formatMoney(stockValue(p))}</span>
          </div>
          <div class="mini-stat">
            <span class="mini-label">预计销售额</span>
            <span class="mini-value">${formatMoney(expectedRevenue(p))}</span>
          </div>
        </div>
      </div>
    </section>
  </div>

  <section class="card">
    <div class="card-head">
      <h2 class="card-title">库存流水（最近 20 条）</h2>
      <a href="/stock/movements?product=${p.id}" class="card-link">查看全部</a>
    </div>
    <div class="card-body no-pad">
      ${movements.length > 0
        ? html`<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>时间</th><th>类型</th><th class="num">变动</th>
              <th class="num">变动前</th><th class="num">变动后</th>
              <th class="num">单价</th><th>单号</th><th>操作人</th><th>备注</th>
            </tr>
          </thead>
          <tbody>
            ${movements.map((m) => movementRow(m))}
          </tbody>
        </table>
      </div>`
        : html`<div class="empty-inline">该商品暂无库存流水</div>`}
    </div>
  </section>

</div>`;
  },
};

function movementRow(m: StockMovement): Html {
  return html`<tr>
              <td class="muted nowrap">${formatDateTime(m.createdAt)}</td>
              <td>
                ${m.type === "in"
                  ? html`<span class="badge badge-in">入库</span>`
                  : m.type === "out"
                    ? html`<span class="badge badge-out">出库</span>`
                    : m.type === "adjust"
                      ? html`<span class="badge badge-adjust">盘点</span>`
                      : html`<span class="badge badge-muted">期初</span>`}
              </td>
              <td class="num ${m.delta < 0 ? "text-out" : "text-in"} strong">${movementSignedQuantity(m)}</td>
              <td class="num muted">${formatNumber(m.beforeQty)}</td>
              <td class="num">${formatNumber(m.afterQty)}</td>
              <td class="num">${formatMoney(m.unitPrice)}</td>
              <td class="mono">${m.refNo || "—"}</td>
              <td>${m.operatorName}</td>
              <td class="muted">${m.note || "—"}</td>
            </tr>`;
}
