// 分类与供应商页面 —— 对应原 Go 版 web/templates/categories/*.html
// 与 web/templates/suppliers/*.html。

import type { Pagination } from "../lib/pagination";
import { defaultString, formatMoney, formatNumber, truncate } from "../lib/format";
import { formatDate, formatDateTime } from "../lib/time";
import { isLowStock, roleCanWrite, type Category, type Product, type Supplier } from "../types";
import { html } from "./html";
import { empty, pagination } from "./partials";
import type { PageData, View } from "./render";
import { alertError, fieldError, textInput } from "./ui";

type Values = Record<string, string>;
type Errors = Record<string, string>;

// 复用同一段「编辑 / 删除」图标，避免两个列表页各写一份。
const ICON_EDIT = html`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg>`;
const ICON_DELETE = html`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>`;
const ICON_PLUS = html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;

/** 侧边栏高亮标识固定为 categories / suppliers，这里集中取当前用户能否写。 */
function canWrite(pd: PageData<unknown>): boolean {
  return pd.user ? roleCanWrite(pd.user.role) : false;
}

// ---------------------------------------------------------------------------
// 分类列表
// ---------------------------------------------------------------------------

export interface CategoryListData {
  categories: Category[];
  pagination: Pagination;
  search: string;
  query: string;
}

export const categoryListView: View<CategoryListData> = {
  content(pd) {
    const { categories, pagination: pg, search, query } = pd.data;
    const writable = canWrite(pd);

    return html`<div class="page">
  <div class="page-head">
    <div>
      <h2 class="page-title">分类管理</h2>
      <p class="page-desc">共 ${formatNumber(pg.total)} 个分类</p>
    </div>
    <div class="page-actions">
      <form method="get" action="/categories" class="inline-search">
        <input type="search" name="q" value="${search}" placeholder="搜索分类">
        <button type="submit" class="btn btn-secondary">搜索</button>
      </form>
      ${writable
        ? html`<a href="/categories/new" class="btn btn-primary">
        ${ICON_PLUS}
        新建分类
      </a>`
        : ""}
    </div>
  </div>

  <div class="card">
    <div class="card-body no-pad">
      ${categories.length > 0
        ? html`<table class="table">
        <thead>
          <tr>
            <th>分类名称</th>
            <th>描述</th>
            <th class="num">商品数</th>
            <th>创建时间</th>
            <th class="actions-col">操作</th>
          </tr>
        </thead>
        <tbody>
          ${categories.map(
            (cat) => html`<tr>
            <td><span class="strong">${cat.name}</span></td>
            <td class="muted">${defaultString(cat.description, "—")}</td>
            <td class="num">
              <a href="/products?category=${cat.id}" class="link">${formatNumber(cat.productCount)}</a>
            </td>
            <td class="muted nowrap">${formatDate(cat.createdAt)}</td>
            <td class="actions-col">
              <div class="row-actions">
                ${writable
                  ? html`<a href="/categories/${cat.id}/edit" class="icon-action" title="编辑">
                  ${ICON_EDIT}
                </a>
                <form method="post" action="/categories/${cat.id}/delete" class="inline-form"
                      data-confirm="确定删除分类「${cat.name}」吗？该分类下商品的分类信息将被清空。">
                  <input type="hidden" name="_csrf" value="${pd.csrf}">
                  <button type="submit" class="icon-action danger" title="删除">
                    ${ICON_DELETE}
                  </button>
                </form>`
                  : ""}
              </div>
            </td>
          </tr>`,
          )}
        </tbody>
      </table>`
        : empty({
            title: "暂无分类",
            hint: "创建分类后，可以更方便地组织和筛选商品",
            actionUrl: "/categories/new",
            actionLabel: "新建分类",
          })}
    </div>
    <div class="card-foot">${pagination(pg, query)}</div>
  </div>
</div>`;
  },
};

// ---------------------------------------------------------------------------
// 分类表单（新建 / 编辑）
// ---------------------------------------------------------------------------

export interface CategoryFormData {
  category: Category | null;
  values: Values;
  errors: Errors;
  isEdit: boolean;
}

export const categoryFormView: View<CategoryFormData> = {
  content(pd) {
    const { category, values, errors, isEdit } = pd.data;

    return html`<div class="page page-narrow">
  <div class="page-head">
    <div>
      <h2 class="page-title">${isEdit ? "编辑分类" : "新建分类"}</h2>
      <p class="page-desc">分类用于对商品进行归类，便于筛选与统计。</p>
    </div>
    <div class="page-actions">
      <a href="/categories" class="btn btn-ghost">返回列表</a>
    </div>
  </div>

  ${alertError(errors.form)}

  <form method="post" action="${isEdit && category ? `/categories/${category.id}` : "/categories"}" class="card form">
    <input type="hidden" name="_csrf" value="${pd.csrf}">

    <div class="card-body">
      <div class="field">
        <label for="name">分类名称 <span class="req">*</span></label>
        ${textInput({
          id: "name",
          name: "name",
          value: values.name ?? "",
          placeholder: "例如 电子配件",
          invalid: !!errors.name,
          required: true,
          autofocus: true,
        })}
        ${fieldError(errors.name)}
      </div>

      <div class="field">
        <label for="description">描述</label>
        <textarea id="description" name="description" rows="3" class="input textarea"
                  placeholder="选填，简单说明该分类包含哪些商品">${values.description ?? ""}</textarea>
      </div>
    </div>

    <div class="card-foot form-actions">
      <a href="/categories" class="btn btn-ghost">取消</a>
      <button type="submit" class="btn btn-primary">${isEdit ? "保存修改" : "创建分类"}</button>
    </div>
  </form>
</div>`;
  },
};

// ---------------------------------------------------------------------------
// 供应商列表
// ---------------------------------------------------------------------------

export interface SupplierListData {
  suppliers: Supplier[];
  pagination: Pagination;
  search: string;
  query: string;
}

export const supplierListView: View<SupplierListData> = {
  content(pd) {
    const { suppliers, pagination: pg, search, query } = pd.data;
    const writable = canWrite(pd);

    return html`<div class="page">
  <div class="page-head">
    <div>
      <h2 class="page-title">供应商管理</h2>
      <p class="page-desc">共 ${formatNumber(pg.total)} 个供应商</p>
    </div>
    <div class="page-actions">
      <form method="get" action="/suppliers" class="inline-search">
        <input type="search" name="q" value="${search}" placeholder="搜索名称 / 联系人 / 电话">
        <button type="submit" class="btn btn-secondary">搜索</button>
      </form>
      ${writable
        ? html`<a href="/suppliers/new" class="btn btn-primary">
        ${ICON_PLUS}
        新建供应商
      </a>`
        : ""}
    </div>
  </div>

  <div class="card">
    <div class="card-body no-pad">
      ${suppliers.length > 0
        ? html`<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>供应商名称</th>
              <th>联系人</th>
              <th>联系方式</th>
              <th>地址</th>
              <th class="num">供货商品</th>
              <th class="actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            ${suppliers.map(
              (sup) => html`<tr>
              <td><a href="/suppliers/${sup.id}" class="cell-link">${sup.name}</a></td>
              <td>${defaultString(sup.contactPerson, "—")}</td>
              <td>
                ${sup.phone ? html`<div>${sup.phone}</div>` : ""}
                ${sup.email ? html`<div class="cell-sub">${sup.email}</div>` : ""}
                ${!sup.phone && !sup.email ? html`<span class="muted">—</span>` : ""}
              </td>
              <td class="muted">${truncate(defaultString(sup.address, "—"), 24)}</td>
              <td class="num">
                <a href="/products?supplier=${sup.id}" class="link">${formatNumber(sup.productCount)}</a>
              </td>
              <td class="actions-col">
                <div class="row-actions">
                  ${writable
                    ? html`<a href="/suppliers/${sup.id}/edit" class="icon-action" title="编辑">
                    ${ICON_EDIT}
                  </a>
                  <form method="post" action="/suppliers/${sup.id}/delete" class="inline-form"
                        data-confirm="确定删除供应商「${sup.name}」吗？相关商品的供应商信息将被清空。">
                    <input type="hidden" name="_csrf" value="${pd.csrf}">
                    <button type="submit" class="icon-action danger" title="删除">
                      ${ICON_DELETE}
                    </button>
                  </form>`
                    : ""}
                  <a href="/suppliers/${sup.id}" class="icon-action" title="详情">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/></svg>
                  </a>
                </div>
              </td>
            </tr>`,
            )}
          </tbody>
        </table>
      </div>`
        : empty({
            title: "暂无供应商",
            hint: "录入供应商后，入库时可以直接关联，方便后续对账",
            actionUrl: "/suppliers/new",
            actionLabel: "新建供应商",
          })}
    </div>
    <div class="card-foot">${pagination(pg, query)}</div>
  </div>
</div>`;
  },
};

// ---------------------------------------------------------------------------
// 供应商表单（新建 / 编辑）
// ---------------------------------------------------------------------------

export interface SupplierFormData {
  supplier: Supplier | null;
  values: Values;
  errors: Errors;
  isEdit: boolean;
}

export const supplierFormView: View<SupplierFormData> = {
  content(pd) {
    const { supplier, values, errors, isEdit } = pd.data;

    return html`<div class="page page-narrow">
  <div class="page-head">
    <div>
      <h2 class="page-title">${isEdit ? "编辑供应商" : "新建供应商"}</h2>
      <p class="page-desc">记录供应商联系方式，便于采购与对账。</p>
    </div>
    <div class="page-actions">
      <a href="/suppliers" class="btn btn-ghost">返回列表</a>
    </div>
  </div>

  ${alertError(errors.form)}

  <form method="post" action="${isEdit && supplier ? `/suppliers/${supplier.id}` : "/suppliers"}" class="card form">
    <input type="hidden" name="_csrf" value="${pd.csrf}">

    <div class="card-body">
      <div class="form-grid">
        <div class="field span-2">
          <label for="name">供应商名称 <span class="req">*</span></label>
          ${textInput({
            id: "name",
            name: "name",
            value: values.name ?? "",
            placeholder: "例如 深圳市宏远电子有限公司",
            invalid: !!errors.name,
            required: true,
            autofocus: true,
          })}
          ${fieldError(errors.name)}
        </div>

        <div class="field">
          <label for="contact_person">联系人</label>
          ${textInput({
            id: "contact_person",
            name: "contact_person",
            value: values.contact_person ?? "",
            placeholder: "例如 张伟",
          })}
        </div>

        <div class="field">
          <label for="phone">联系电话</label>
          ${textInput({
            id: "phone",
            name: "phone",
            value: values.phone ?? "",
            placeholder: "例如 0755-88886666",
          })}
        </div>

        <div class="field span-2">
          <label for="email">邮箱</label>
          ${textInput({
            type: "email",
            id: "email",
            name: "email",
            value: values.email ?? "",
            placeholder: "例如 sales@example.com",
            invalid: !!errors.email,
          })}
          ${fieldError(errors.email)}
        </div>

        <div class="field span-2">
          <label for="address">地址</label>
          ${textInput({
            id: "address",
            name: "address",
            value: values.address ?? "",
            placeholder: "例如 广东省深圳市南山区科技园",
          })}
        </div>

        <div class="field span-2">
          <label for="note">备注</label>
          <textarea id="note" name="note" rows="3" class="input textarea"
                    placeholder="选填，例如结算方式、供货周期">${values.note ?? ""}</textarea>
        </div>
      </div>
    </div>

    <div class="card-foot form-actions">
      <a href="/suppliers" class="btn btn-ghost">取消</a>
      <button type="submit" class="btn btn-primary">${isEdit ? "保存修改" : "创建供应商"}</button>
    </div>
  </form>
</div>`;
  },
};

// ---------------------------------------------------------------------------
// 供应商详情
// ---------------------------------------------------------------------------

export interface SupplierDetailData {
  supplier: Supplier;
  products: Product[];
}

export const supplierDetailView: View<SupplierDetailData> = {
  content(pd) {
    const { supplier: s, products } = pd.data;
    const writable = canWrite(pd);

    return html`<div class="page">
  <div class="page-head">
    <div>
      <div class="breadcrumb">
        <a href="/suppliers">供应商管理</a><span>/</span><span>${s.name}</span>
      </div>
      <h2 class="page-title">${s.name}</h2>
      <p class="page-desc">合作商品 ${formatNumber(s.productCount)} 项</p>
    </div>
    <div class="page-actions">
      ${writable ? html`<a href="/suppliers/${s.id}/edit" class="btn btn-primary">编辑</a>` : ""}
      <a href="/suppliers" class="btn btn-ghost">返回</a>
    </div>
  </div>

  <div class="grid-2">
    <section class="card">
      <div class="card-head"><h2 class="card-title">联系方式</h2></div>
      <div class="card-body">
        <dl class="detail-list">
          <div class="detail-row"><dt>联系人</dt><dd>${defaultString(s.contactPerson, "—")}</dd></div>
          <div class="detail-row"><dt>联系电话</dt><dd>${defaultString(s.phone, "—")}</dd></div>
          <div class="detail-row"><dt>邮箱</dt><dd>${defaultString(s.email, "—")}</dd></div>
          <div class="detail-row"><dt>地址</dt><dd>${defaultString(s.address, "—")}</dd></div>
          <div class="detail-row"><dt>备注</dt><dd>${defaultString(s.note, "—")}</dd></div>
          <div class="detail-row"><dt>创建时间</dt><dd>${formatDateTime(s.createdAt)}</dd></div>
        </dl>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">供货商品</h2>
        <a href="/products?supplier=${s.id}" class="card-link">查看全部</a>
      </div>
      <div class="card-body no-pad">
        ${products.length > 0
          ? html`<table class="table table-compact">
          <thead>
            <tr><th>商品</th><th class="num">库存</th><th class="num">进价</th></tr>
          </thead>
          <tbody>
            ${products.map(
              (p) => html`<tr>
              <td>
                <a href="/products/${p.id}" class="cell-link">${truncate(p.name, 18)}</a>
                <div class="cell-sub">${p.sku}</div>
              </td>
              <td class="num">
                ${isLowStock(p)
                  ? html`<span class="text-warning strong">${formatNumber(p.quantity)}</span>`
                  : formatNumber(p.quantity)}
              </td>
              <td class="num">${formatMoney(p.costPrice)}</td>
            </tr>`,
            )}
          </tbody>
        </table>`
          : html`<div class="empty-inline">该供应商暂无关联商品</div>`}
      </div>
    </section>
  </div>
</div>`;
  },
};
