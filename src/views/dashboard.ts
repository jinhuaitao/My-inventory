// 仪表盘页面 —— 对应原 Go 版 web/templates/dashboard.html。

import { barHeight, formatMoney, formatNumber, percent, truncate } from "../lib/format";
import { formatDateTime } from "../lib/time";
import {
  isOutOfStock,
  movementSignedQuantity,
  roleCanWrite,
  type CategoryStat,
  type DashboardStats,
  type Product,
  type ProductStat,
  type StockMovement,
  type TrendPoint,
} from "../types";
import { html, type Html } from "./html";
import type { View } from "./render";

export interface DashboardData {
  stats: DashboardStats;
  trend: TrendPoint[];
  /** 趋势图纵轴上限（由 trend 的 MaxValue 求出）。 */
  maxTrend: number;
  categoryStats: CategoryStat[];
  /** 分类占比图的分母：各分类库存价值之和。 */
  categoryTotal: number;
  topProducts: ProductStat[];
  topMoving: ProductStat[];
  lowStock: Product[];
  recent: StockMovement[];
}

export const dashboardView: View<DashboardData> = {
  content(pd) {
    const d = pd.data;
    const canWrite = pd.user ? roleCanWrite(pd.user.role) : false;

    return html`<div class="page">

  <!-- ============ 核心指标 ============ -->
  <section class="stat-grid">
    <div class="stat-card">
      <div class="stat-head">
        <span class="stat-label">商品总数</span>
        <span class="stat-icon blue">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>
        </span>
      </div>
      <div class="stat-value">${formatNumber(d.stats.totalProducts)}</div>
      <div class="stat-foot">${formatNumber(d.stats.totalCategories)} 个分类 · ${formatNumber(d.stats.totalSuppliers)} 个供应商</div>
    </div>

    <div class="stat-card">
      <div class="stat-head">
        <span class="stat-label">库存总量</span>
        <span class="stat-icon teal">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 11h18"/><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </span>
      </div>
      <div class="stat-value">${formatNumber(d.stats.totalStock)}</div>
      <div class="stat-foot">全部商品在库数量合计</div>
    </div>

    <div class="stat-card">
      <div class="stat-head">
        <span class="stat-label">库存总价值</span>
        <span class="stat-icon green">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M17 7.5c0-1.7-2.2-3-5-3s-5 1.3-5 3 2.2 3 5 3 5 1.3 5 3-2.2 3-5 3-5-1.3-5-3"/></svg>
        </span>
      </div>
      <div class="stat-value">${formatMoney(d.stats.stockValue)}</div>
      <div class="stat-foot">按进价计算的库存成本</div>
    </div>

    ${/* 徽标口径必须与「库存预警」列表（ProductFilter.lowStockOnly）严格一致：
         都统计 quantity <= safety_stock，缺货商品也计入 lowStockCount。
         早先这里多了一个 quantity > 0，把缺货商品排除在计数之外，于是徽标
         显示 5、点进去的列表却有 8 条 —— 用户只会认为有一半数据没加载出来。
         缺货是「低库存」里更严重的一档，单独用 outOfStockCount 呈现，
         两者是包含关系而非并列关系（口径实现见 db/stats.ts）。 */ ""}
    <div class="stat-card ${d.stats.lowStockCount > 0 ? "alert-card" : ""}">
      <div class="stat-head">
        <span class="stat-label">库存预警</span>
        <span class="stat-icon amber">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l9.2 16H2.8l9.2-16z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none"/></svg>
        </span>
      </div>
      <div class="stat-value">${formatNumber(d.stats.lowStockCount)}</div>
      <div class="stat-foot">
        低于安全库存${d.stats.outOfStockCount > 0
          ? html` · <a href="/stock/low" class="link-danger">${formatNumber(d.stats.outOfStockCount)} 项已缺货</a>`
          : ""}
      </div>
    </div>

    <div class="stat-card">
      <div class="stat-head">
        <span class="stat-label">今日入库</span>
        <span class="stat-icon blue">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M8 8l4 4 4-4"/><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/></svg>
        </span>
      </div>
      <div class="stat-value">${formatNumber(d.stats.todayIn)}</div>
      <div class="stat-foot">本月累计 ${formatNumber(d.stats.monthIn)}</div>
    </div>

    <div class="stat-card">
      <div class="stat-head">
        <span class="stat-label">今日出库</span>
        <span class="stat-icon purple">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 13V4"/><path d="M8 8l4-4 4 4"/><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/></svg>
        </span>
      </div>
      <div class="stat-value">${formatNumber(d.stats.todayOut)}</div>
      <div class="stat-foot">本月累计 ${formatNumber(d.stats.monthOut)}</div>
    </div>
  </section>

  <!-- ============ 快捷操作 ============ -->
  <section class="quick-actions">
    ${canWrite
      ? html`<a href="/stock/in" class="quick-btn">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v9"/><path d="M8 8l4 4 4-4"/><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/></svg>
      商品入库
    </a>
    <a href="/stock/out" class="quick-btn">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 13V4"/><path d="M8 8l4-4 4 4"/><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/></svg>
      商品出库
    </a>
    <a href="/products/new" class="quick-btn">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      新建商品
    </a>`
      : ""}
    <a href="/stock/movements" class="quick-btn">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>
      查看流水
    </a>
    <a href="/products/export" class="quick-btn">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M3 19h18"/></svg>
      导出商品
    </a>
  </section>

  <!-- ============ 出入库趋势 ============ -->
  <section class="card">
    <div class="card-head">
      <h2 class="card-title">近 14 天出入库趋势</h2>
      <div class="legend">
        <span class="legend-item"><i class="dot in"></i>入库</span>
        <span class="legend-item"><i class="dot out"></i>出库</span>
      </div>
    </div>
    <div class="card-body">
      ${d.maxTrend > 0
        ? html`<div class="chart">
        ${d.trend.map(
          (p) => html`<div class="chart-col" title="${p.label}　入库 ${p.in}　出库 ${p.out}">
          <div class="chart-pair">
            <div class="chart-bar bar-in" style="height: ${barHeight(p.in, d.maxTrend)}%"></div>
            <div class="chart-bar bar-out" style="height: ${barHeight(p.out, d.maxTrend)}%"></div>
          </div>
          <span class="chart-label">${p.label}</span>
        </div>`,
        )}
      </div>`
        : html`<div class="empty-inline">近 14 天暂无出入库记录</div>`}
    </div>
  </section>

  <!-- ============ 两列：分类分布 + 库存价值 TOP ============ -->
  <div class="grid-2">
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">分类库存价值分布</h2>
        <a href="/reports" class="card-link">查看报表</a>
      </div>
      <div class="card-body">
        ${d.categoryStats.length > 0
          ? html`<div class="hbar-list">
          ${d.categoryStats.map(
            (cs) => html`<div class="hbar-row">
            <span class="hbar-name" title="${cs.name}">${truncate(cs.name, 10)}</span>
            <div class="hbar-track">
              <div class="hbar-fill" style="width: ${percent(cs.value, d.categoryTotal)}%"></div>
            </div>
            <span class="hbar-value">${formatMoney(cs.value)}</span>
          </div>`,
          )}
        </div>`
          : html`<div class="empty-inline">暂无商品数据</div>`}
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">库存价值 TOP 8</h2>
        <a href="/products?sort=value&amp;dir=desc" class="card-link">全部商品</a>
      </div>
      <div class="card-body no-pad">
        ${d.topProducts.length > 0
          ? html`<table class="table table-compact">
          <thead>
            <tr><th>商品</th><th class="num">库存</th><th class="num">价值</th></tr>
          </thead>
          <tbody>
            ${d.topProducts.map(
              (p) => html`<tr>
              <td>
                <div class="cell-title">${truncate(p.name, 16)}</div>
                <div class="cell-sub">${p.sku}</div>
              </td>
              <td class="num">${formatNumber(p.quantity)}</td>
              <td class="num strong">${formatMoney(p.value)}</td>
            </tr>`,
            )}
          </tbody>
        </table>`
          : html`<div class="empty-inline">暂无商品数据</div>`}
      </div>
    </section>
  </div>

  <!-- ============ 两列：库存预警 + 出库排行 ============ -->
  <div class="grid-2">
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">库存预警</h2>
        <a href="/stock/low" class="card-link">查看全部</a>
      </div>
      <div class="card-body no-pad">
        ${d.lowStock.length > 0
          ? html`<table class="table table-compact">
          <thead>
            <tr><th>商品</th><th class="num">当前</th><th class="num">安全库存</th><th></th></tr>
          </thead>
          <tbody>
            ${d.lowStock.map(
              (p) => html`<tr>
              <td>
                <div class="cell-title">${truncate(p.name, 14)}</div>
                <div class="cell-sub">${p.sku}</div>
              </td>
              <td class="num">
                ${isOutOfStock(p)
                  ? html`<span class="badge badge-danger">缺货</span>`
                  : html`<span class="text-warning strong">${formatNumber(p.quantity)}</span>`}
              </td>
              <td class="num muted">${formatNumber(p.safetyStock)}</td>
              <td class="num">
                ${canWrite
                  ? html`<a href="/stock/in?product_id=${p.id}" class="btn btn-xs btn-outline">补货</a>`
                  : ""}
              </td>
            </tr>`,
            )}
          </tbody>
        </table>`
          : html`<div class="empty-inline success">所有商品库存充足</div>`}
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">近 30 天出库排行</h2>
      </div>
      <div class="card-body no-pad">
        ${d.topMoving.length > 0
          ? html`<table class="table table-compact">
          <thead>
            <tr><th>商品</th><th class="num">出库量</th><th class="num">金额</th></tr>
          </thead>
          <tbody>
            ${d.topMoving.map(
              (p) => html`<tr>
              <td>
                <div class="cell-title">${truncate(p.name, 16)}</div>
                <div class="cell-sub">${p.sku}</div>
              </td>
              <td class="num strong">${formatNumber(p.quantity)}</td>
              <td class="num">${formatMoney(p.value)}</td>
            </tr>`,
            )}
          </tbody>
        </table>`
          : html`<div class="empty-inline">近 30 天暂无出库记录</div>`}
      </div>
    </section>
  </div>

  <!-- ============ 最近操作 ============ -->
  <section class="card">
    <div class="card-head">
      <h2 class="card-title">最近库存操作</h2>
      <a href="/stock/movements" class="card-link">查看全部</a>
    </div>
    <div class="card-body no-pad">
      ${d.recent.length > 0
        ? html`<table class="table">
        <thead>
          <tr>
            <th>时间</th><th>类型</th><th>商品</th>
            <th class="num">变动</th><th class="num">结存</th>
            <th>操作人</th><th>备注</th>
          </tr>
        </thead>
        <tbody>
          ${d.recent.map(
            (m) => html`<tr>
            <td class="muted nowrap">${formatDateTime(m.createdAt)}</td>
            <td>${movementBadge(m.type)}</td>
            <td>
              <a href="/products/${m.productId}" class="cell-link">${truncate(m.productName, 16)}</a>
              <div class="cell-sub">${m.productSku}</div>
            </td>
            <td class="num ${m.delta < 0 ? "text-out" : "text-in"} strong">${movementSignedQuantity(m)}</td>
            <td class="num">${formatNumber(m.afterQty)}</td>
            <td>${m.operatorName}</td>
            <td class="muted">${truncate(m.note, 20)}</td>
          </tr>`,
          )}
        </tbody>
      </table>`
        : html`<div class="empty-inline">暂无库存操作记录</div>`}
    </div>
  </section>

</div>`;
  },
};

function movementBadge(t: string): Html {
  if (t === "in") return html`<span class="badge badge-in">入库</span>`;
  if (t === "out") return html`<span class="badge badge-out">出库</span>`;
  if (t === "adjust") return html`<span class="badge badge-adjust">盘点</span>`;
  return html`<span class="badge badge-muted">期初</span>`;
}
