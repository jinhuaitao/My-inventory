// 库存报表页面 —— 对应原 Go 版 web/templates/reports/index.html。

import type { MovementSummary } from "../db/stats";
import { barHeight, formatMoney, formatNumber, percent, truncate } from "../lib/format";
import type { CategoryStat, DashboardStats, ProductStat, TrendPoint } from "../types";
import { html } from "./html";
import type { View } from "./render";

export interface ReportsData {
  summary: MovementSummary;
  trend: TrendPoint[];
  /** 趋势图纵轴上限（由 trend 的 MaxValue 求出）。 */
  maxTrend: number;
  categoryStats: CategoryStat[];
  /** 分类占比图的分母：各分类库存价值之和。 */
  categoryTotal: number;
  topProducts: ProductStat[];
  topMoving: ProductStat[];
  stats: DashboardStats;
  /** 统计区间起止（YYYY-MM-DD，本地时区）。 */
  start: string;
  end: string;
}

export const reportsView: View<ReportsData> = {
  content(pd) {
    const d = pd.data;

    return html`<div class="page">

  <div class="page-head">
    <div>
      <h2 class="page-title">库存报表</h2>
      <p class="page-desc">统计区间 ${d.start} 至 ${d.end}</p>
    </div>
    <div class="page-actions">
      <form method="get" action="/reports" class="inline-search">
        <input type="date" name="start" value="${d.start}" class="input date-input">
        <span class="range-sep">至</span>
        <input type="date" name="end" value="${d.end}" class="input date-input">
        <button type="submit" class="btn btn-secondary">查询</button>
      </form>
    </div>
  </div>

  <!-- 区间汇总 -->
  <section class="stat-grid stat-grid-4">
    <div class="stat-card">
      <div class="stat-label">区间入库量</div>
      <div class="stat-value text-in">${formatNumber(d.summary.inQuantity)}</div>
      <div class="stat-foot">金额 ${formatMoney(d.summary.inAmount)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">区间出库量</div>
      <div class="stat-value text-out">${formatNumber(d.summary.outQuantity)}</div>
      <div class="stat-foot">金额 ${formatMoney(d.summary.outAmount)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">净库存变化</div>
      <div class="stat-value">${formatNumber(d.summary.inQuantity - d.summary.outQuantity)}</div>
      <div class="stat-foot">入库减出库</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">当前库存总值</div>
      <div class="stat-value">${formatMoney(d.stats.stockValue)}</div>
      <div class="stat-foot">${formatNumber(d.stats.totalProducts)} 个在售商品</div>
    </div>
  </section>

  <!-- 趋势 -->
  <section class="card">
    <div class="card-head">
      <h2 class="card-title">近 30 天出入库趋势</h2>
      <div class="legend">
        <span class="legend-item"><i class="dot in"></i>入库</span>
        <span class="legend-item"><i class="dot out"></i>出库</span>
      </div>
    </div>
    <div class="card-body">
      ${d.maxTrend > 0
        ? html`<div class="chart chart-wide">
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
        : html`<div class="empty-inline">近 30 天暂无出入库记录</div>`}
    </div>
  </section>

  <div class="grid-2">
    <section class="card">
      <div class="card-head"><h2 class="card-title">分类库存价值分布</h2></div>
      <div class="card-body">
        ${d.categoryStats.length > 0
          ? html`<div class="hbar-list">
          ${d.categoryStats.map(
            (cs) => html`<div class="hbar-row">
            <span class="hbar-name" title="${cs.name}">${truncate(cs.name, 10)}</span>
            <div class="hbar-track"><div class="hbar-fill" style="width: ${percent(cs.value, d.categoryTotal)}%"></div></div>
            <span class="hbar-value">${formatMoney(cs.value)}</span>
          </div>`,
          )}
        </div>`
          : html`<div class="empty-inline">暂无数据</div>`}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2 class="card-title">近 30 天出库排行</h2></div>
      <div class="card-body no-pad">
        ${d.topMoving.length > 0
          ? html`<table class="table table-compact">
          <thead><tr><th>商品</th><th class="num">出库量</th><th class="num">金额</th></tr></thead>
          <tbody>
            ${d.topMoving.map(
              (p) => html`<tr>
              <td>
                <div class="cell-title">${truncate(p.name, 18)}</div>
                <div class="cell-sub">${p.sku}</div>
              </td>
              <td class="num strong">${formatNumber(p.quantity)}</td>
              <td class="num">${formatMoney(p.value)}</td>
            </tr>`,
            )}
          </tbody>
        </table>`
          : html`<div class="empty-inline">暂无数据</div>`}
      </div>
    </section>
  </div>

  <section class="card">
    <div class="card-head">
      <h2 class="card-title">库存价值 TOP 10</h2>
      <a href="/products/export" class="card-link">导出商品明细</a>
    </div>
    <div class="card-body no-pad">
      ${d.topProducts.length > 0
        ? html`<table class="table">
        <thead>
          <tr><th>商品</th><th class="num">库存</th><th class="num">价值</th><th>占比</th></tr>
        </thead>
        <tbody>
          ${d.topProducts.map(
            (p) => html`<tr>
            <td>
              <div class="cell-title">${p.name}</div>
              <div class="cell-sub">${p.sku}</div>
            </td>
            <td class="num">${formatNumber(p.quantity)}</td>
            <td class="num strong">${formatMoney(p.value)}</td>
            <td>
              <div class="hbar-track thin"><div class="hbar-fill" style="width: ${percent(p.value, d.stats.stockValue)}%"></div></div>
            </td>
          </tr>`,
          )}
        </tbody>
      </table>`
        : html`<div class="empty-inline">暂无数据</div>`}
    </div>
  </section>

</div>`;
  },
};
