// 公共局部模板 —— 对应原 Go 版 web/templates/partials/*.html。

import { html, type Html } from "./html";
import type { Pagination } from "../lib/pagination";
import { formatNumber } from "../lib/format";
import { roleCanManageUsers, roleCanWrite, type User } from "../types";
import type { Flash } from "../lib/flash";

// ---------------------------------------------------------------------------
// flash 提示条
// ---------------------------------------------------------------------------

const FLASH_ICONS: Record<string, Html> = {
  success: html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
  error: html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`,
  warning: html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l9.2 16H2.8l9.2-16z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none"/></svg>`,
  info: html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/></svg>`,
};

export function flash(f: Flash | null): Html {
  if (!f) return html``;
  const icon = FLASH_ICONS[f.type] ?? FLASH_ICONS.info;
  return html`<div class="flash flash-${f.type}" role="alert">
  <span class="flash-icon">${icon}</span>
  <span class="flash-text">${f.message}</span>
  ${/* 关闭按钮不能使用内联事件处理器：站点 CSP 为 script-src 'self'，
       会被浏览器直接拒绝执行，表现为点了没反应。交给 app.js 绑定。 */ ""}
  <button type="button" class="flash-close" aria-label="关闭" data-dismiss-flash>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
  </button>
</div>`;
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

/**
 * 分页导航。
 *
 * query 是**不含 page** 的查询串（由 currentQueryWithoutPage 生成）：
 * 列表页若传空串，用户搜索后翻到第 2 页时筛选条件会全部丢失，
 * 看起来就像「搜索没生效」。
 */
export function pagination(pg: Pagination, query: string): Html {
  const prefix = query ? `${query}&` : "";

  if (pg.totalPages > 1) {
    const items: Html[] = pg.pages.map((p) => {
      if (p === 0) return html`<span class="page-ellipsis">…</span>`;
      if (p === pg.page) return html`<span class="page-link active" aria-current="page">${p}</span>`;
      return html`<a class="page-link" href="?${prefix}page=${p}">${p}</a>`;
    });

    return html`<nav class="pagination" aria-label="分页导航">
  <span class="page-info">
    共 ${formatNumber(pg.total)} 条 · 第 ${pg.page} / ${pg.totalPages} 页
    ${pg.total > 0 ? html`（当前显示 ${pg.start}-${pg.end}）` : ""}
  </span>
  <div class="page-links">
    ${pg.hasPrev
      ? html`<a class="page-link" href="?${prefix}page=${pg.prevPage}" rel="prev">上一页</a>`
      : html`<span class="page-link disabled">上一页</span>`}
    ${items}
    ${pg.hasNext
      ? html`<a class="page-link" href="?${prefix}page=${pg.nextPage}" rel="next">下一页</a>`
      : html`<span class="page-link disabled">下一页</span>`}
  </div>
</nav>`;
  }

  if (pg.total > 0) {
    return html`<nav class="pagination" aria-label="分页导航">
  <span class="page-info">共 ${formatNumber(pg.total)} 条</span>
</nav>`;
  }
  return html``;
}

// ---------------------------------------------------------------------------
// 空状态
// ---------------------------------------------------------------------------

export interface EmptyState {
  title: string;
  hint?: string;
  actionUrl?: string;
  actionLabel?: string;
}

export function empty(state: EmptyState): Html {
  return html`<div class="empty-state">
  <div class="empty-icon">
    <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>
  </div>
  <p class="empty-title">${state.title}</p>
  ${state.hint ? html`<p class="empty-hint">${state.hint}</p>` : ""}
  ${state.actionUrl ? html`<a href="${state.actionUrl}" class="btn btn-primary">${state.actionLabel ?? ""}</a>` : ""}
</div>`;
}

// ---------------------------------------------------------------------------
// 侧边栏
// ---------------------------------------------------------------------------

const ICONS = {
  dashboard: html`<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>`,
  products: html`<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>`,
  categories: html`<path d="M3 7.5A2.5 2.5 0 015.5 5H9l2 2.5h7.5A2.5 2.5 0 0121 10v7a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 17V7.5z"/>`,
  suppliers: html`<path d="M1 4h13v12H1z"/><path d="M14 8h4l3 3.5V16h-7z"/><circle cx="5.5" cy="18.5" r="1.8"/><circle cx="17.5" cy="18.5" r="1.8"/>`,
  stockIn: html`<path d="M12 3v9"/><path d="M8 8l4 4 4-4"/><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/>`,
  stockOut: html`<path d="M12 13V4"/><path d="M8 8l4-4 4 4"/><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/>`,
  adjust: html`<path d="M9 5h11M9 12h11M9 19h11"/><path d="M3 5l1.4 1.4L7 4"/><path d="M3 12l1.4 1.4L7 11"/><path d="M3 19l1.4 1.4L7 18"/>`,
  movements: html`<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>`,
  lowStock: html`<path d="M12 3.5l9.2 16H2.8l9.2-16z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none"/>`,
  reports: html`<path d="M4 20V11"/><path d="M10 20V4"/><path d="M16 20v-6"/><path d="M22 20H2"/>`,
  users: html`<circle cx="12" cy="8" r="3.6"/><path d="M4.6 20a7.4 7.4 0 0114.8 0"/>`,
  update: html`<path d="M21 12a9 9 0 11-3.2-6.9"/><path d="M21 4v5h-5"/>`,
  maintenance: html`<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>`,
} as const;

function navItem(href: string, active: string, key: string, label: string, icon: Html): Html {
  return html`<a href="${href}" class="nav-item ${active === key ? "active" : ""}">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
      <span>${label}</span>
    </a>`;
}

export function sidebar(active: string, user: User, appName: string, envName: string): Html {
  const canWrite = roleCanWrite(user.role);
  const canManage = roleCanManageUsers(user.role);

  return html`<aside class="sidebar" id="sidebar">
  <a href="/" class="sidebar-brand">
    <span class="brand-mark">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v9"/></svg>
    </span>
    <span class="brand-text">${appName}</span>
  </a>

  <nav class="sidebar-nav">
    ${navItem("/", active, "dashboard", "仪表盘", ICONS.dashboard)}

    <div class="nav-group">基础数据</div>

    ${navItem("/products", active, "products", "商品管理", ICONS.products)}
    ${navItem("/categories", active, "categories", "分类管理", ICONS.categories)}
    ${navItem("/suppliers", active, "suppliers", "供应商", ICONS.suppliers)}

    <div class="nav-group">库存作业</div>

    ${canWrite
      ? html`${navItem("/stock/in", active, "stock-in", "商品入库", ICONS.stockIn)}
    ${navItem("/stock/out", active, "stock-out", "商品出库", ICONS.stockOut)}
    ${navItem("/stock/adjust", active, "stock-adjust", "库存盘点", ICONS.adjust)}`
      : ""}

    ${navItem("/stock/movements", active, "movements", "库存流水", ICONS.movements)}
    ${navItem("/stock/low", active, "low-stock", "库存预警", ICONS.lowStock)}

    <div class="nav-group">分析与管理</div>

    ${navItem("/reports", active, "reports", "库存报表", ICONS.reports)}

    ${canManage
      ? html`${navItem("/users", active, "users", "用户管理", ICONS.users)}
    ${navItem("/admin/update", active, "update", "系统更新", ICONS.update)}
    ${navItem("/admin/maintenance", active, "maintenance", "数据维护", ICONS.maintenance)}`
      : ""}
  </nav>

  <div class="sidebar-foot">
    <span class="env-badge">${envName}</span>
  </div>
</aside>`;
}
