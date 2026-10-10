// 用户管理页面 —— 对应原 Go 版 web/templates/users/list.html 与 form.html。

import { formatNumber } from "../lib/format";
import type { Pagination } from "../lib/pagination";
import { formatDate, formatDateTimePtr } from "../lib/time";
import { roleLabel, userDisplayName, userInitials, type Role, type User } from "../types";
import { html, type Html } from "./html";
import { empty, pagination as paginationNav } from "./partials";
import type { View } from "./render";
import { alertError, fieldError, textInput } from "./ui";

// ---------------------------------------------------------------------------
// 用户列表
// ---------------------------------------------------------------------------

export interface UserListFilter {
  search: string;
  role: string;
  status: string;
  page: number;
  perPage: number;
}

export interface UserListData {
  users: User[];
  pagination: Pagination;
  filter: UserListFilter;
  roles: Role[];
  registration: { enabled: boolean; defaultRole: string };
  query: string;
}

export const userListView: View<UserListData> = {
  content(pd) {
    const { users, pagination, filter, roles, registration, query } = pd.data;
    const selfId = pd.user?.id;

    return html`<div class="page">

  <div class="page-head">
    <div>
      <h2 class="page-title">用户管理</h2>
      <p class="page-desc">共 ${formatNumber(pagination.total)} 个账号</p>
    </div>
    <div class="page-actions">
      <a href="/users/new" class="btn btn-primary">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        新建用户
      </a>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <h3 class="card-title">自助注册</h3>
      ${registration.enabled
        ? html`<span class="badge badge-success">已开启</span>`
        : html`<span class="badge badge-muted">已关闭</span>`}
    </div>
    <div class="card-body">
      ${/* 下面几段刻意写成整行：模板里的换行会被 HTML 折叠成一个空格，
           在中文标点前后留下空隙，看起来是「排版松散」而不是有意留白。 */ ""}
      <p class="muted">${registration.enabled
        ? html`当前已开启：任何能访问本站的人都可以在登录页点「立即注册」自行创建账号，新账号的角色默认为「${registration.defaultRole}」。`
        : html`当前已关闭：登录页不再显示注册入口，直接访问或提交 <code>/register</code> 都会被拒绝，新账号只能由管理员在这里创建。`}调整后立即生效，无需重启服务。</p>
      <p class="field-hint">该设置保存在数据库中，服务重启后依然保留。</p>

      <div class="form-actions">
        ${/* 提交的是**目标状态**而不是「切换」：重复提交、或另一个标签页里已经改过
             时，结果依然可预期。按钮文字就是点下去会得到的状态。 */ ""}
        ${registration.enabled
          ? html`<form method="post" action="/users/registration" class="inline-form"
              data-confirm="关闭后注册入口立即消失，/register 将直接拒绝访问。确认关闭？">
          <input type="hidden" name="_csrf" value="${pd.csrf}">
          <input type="hidden" name="enabled" value="false">
          <button type="submit" class="btn btn-secondary">关闭自助注册</button>
        </form>`
          : html`<form method="post" action="/users/registration" class="inline-form"
              data-confirm="开启后任何能访问本站的人都可以自助注册账号（默认角色：${registration.defaultRole}）。确认开启？">
          <input type="hidden" name="_csrf" value="${pd.csrf}">
          <input type="hidden" name="enabled" value="true">
          <button type="submit" class="btn btn-primary">开启自助注册</button>
        </form>`}
      </div>
    </div>
  </div>

  <form method="get" action="/users" class="filter-bar">
    <div class="filter-search">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input type="search" name="q" value="${filter.search}" placeholder="搜索用户名 / 邮箱 / 姓名">
    </div>

    <select name="role" class="select">
      <option value="">全部角色</option>
      ${roles.map(
        (r) => html`<option value="${r}" ${filter.role === r ? html`selected` : ""}>${roleLabel(r)}</option>`,
      )}
    </select>

    <select name="status" class="select">
      <option value="" ${filter.status === "" ? html`selected` : ""}>全部状态</option>
      <option value="active" ${filter.status === "active" ? html`selected` : ""}>已启用</option>
      <option value="disabled" ${filter.status === "disabled" ? html`selected` : ""}>已禁用</option>
    </select>

    <button type="submit" class="btn btn-secondary">筛选</button>
    <a href="/users" class="btn btn-ghost">重置</a>
  </form>

  <div class="card">
    <div class="card-body no-pad">
      ${users.length > 0
        ? html`<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>用户</th>
              <th>角色</th>
              <th>状态</th>
              <th>最后登录</th>
              <th>创建时间</th>
              <th class="actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            ${users.map((u) => userRow(u, selfId, pd.csrf))}
          </tbody>
        </table>
      </div>`
        : empty({
            title: "没有找到用户",
            hint: "尝试调整筛选条件，或新建一个账号",
            actionUrl: "/users/new",
            actionLabel: "新建用户",
          })}
    </div>
    <div class="card-foot">${paginationNav(pagination, query)}</div>
  </div>

  <div class="card">
    <div class="card-head"><h2 class="card-title">角色权限说明</h2></div>
    <div class="card-body">
      <table class="table table-compact">
        <thead><tr><th>角色</th><th>查看数据</th><th>出入库 / 商品管理</th><th>用户管理</th></tr></thead>
        <tbody>
          <tr><td><span class="badge badge-role-admin">管理员</span></td><td>✔</td><td>✔</td><td>✔</td></tr>
          <tr><td><span class="badge badge-role-manager">仓管员</span></td><td>✔</td><td>✔</td><td>—</td></tr>
          <tr><td><span class="badge badge-role-viewer">只读用户</span></td><td>✔</td><td>—</td><td>—</td></tr>
        </tbody>
      </table>
    </div>
  </div>

</div>`;
  },
};

function userRow(u: User, selfId: number | undefined, csrf: string): Html {
  const isSelf = u.id === selfId;
  return html`<tr>
              <td>
                <div class="user-cell">
                  <span class="avatar sm">${userInitials(u)}</span>
                  <div>
                    <div class="cell-title">
                      ${userDisplayName(u)}
                      ${isSelf ? html`<span class="badge badge-info">我</span>` : ""}
                    </div>
                    <div class="cell-sub">@${u.username} · ${u.email}</div>
                  </div>
                </div>
              </td>
              <td>${roleBadge(u.role)}</td>
              <td>
                ${u.status === "active"
                  ? html`<span class="badge badge-success">已启用</span>`
                  : html`<span class="badge badge-muted">已禁用</span>`}
              </td>
              <td class="muted nowrap">${formatDateTimePtr(u.lastLoginAt)}</td>
              <td class="muted nowrap">${formatDate(u.createdAt)}</td>
              <td class="actions-col">
                <div class="row-actions">
                  <a href="/users/${u.id}/edit" class="icon-action" title="编辑">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg>
                  </a>
                  ${isSelf
                    ? ""
                    : html`<form method="post" action="/users/${u.id}/delete" class="inline-form"
                        data-confirm="确定删除用户「${userDisplayName(u)}」吗？该操作不可撤销。">
                    <input type="hidden" name="_csrf" value="${csrf}">
                    <button type="submit" class="icon-action danger" title="删除">
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>
                    </button>
                  </form>`}
                </div>
              </td>
            </tr>`;
}

function roleBadge(role: Role): Html {
  if (role === "admin") return html`<span class="badge badge-role-admin">管理员</span>`;
  if (role === "manager") return html`<span class="badge badge-role-manager">仓管员</span>`;
  return html`<span class="badge badge-role-viewer">只读用户</span>`;
}

// ---------------------------------------------------------------------------
// 用户表单（新建 / 编辑共用）
// ---------------------------------------------------------------------------

export interface UserFormData {
  target: User | null;
  values: Record<string, string>;
  errors: Record<string, string>;
  roles: Role[];
  isEdit: boolean;
}

export const userFormView: View<UserFormData> = {
  content(pd) {
    const { target, values, errors, roles, isEdit } = pd.data;
    const action = isEdit && target ? `/users/${target.id}` : "/users";

    return html`<div class="page page-narrow">

  <div class="page-head">
    <div>
      <h2 class="page-title">${isEdit ? "编辑用户" : "新建用户"}</h2>
      <p class="page-desc">
        ${isEdit ? "修改用户资料、角色与状态。留空密码表示不修改密码。" : "为团队成员创建账号并分配角色。"}
      </p>
    </div>
    <div class="page-actions">
      <a href="/users" class="btn btn-ghost">返回列表</a>
    </div>
  </div>

  ${alertError(errors.form)}

  <form method="post" action="${action}" class="card form">
    <input type="hidden" name="_csrf" value="${pd.csrf}">

    <div class="card-body">
      <div class="form-grid">
        <div class="field">
          <label for="username">用户名 <span class="req">*</span></label>
          ${isEdit
            ? html`<input type="text" id="username" class="input" value="${values.username ?? ""}" disabled>
            <p class="field-hint">用户名创建后不可修改</p>`
            : html`${textInput({
                id: "username",
                name: "username",
                value: values.username ?? "",
                placeholder: "3-32 位字母、数字、下划线",
                invalid: !!errors.username,
                required: true,
                autofocus: true,
              })}
            ${fieldError(errors.username)}`}
        </div>

        <div class="field">
          <label for="full_name">姓名</label>
          ${textInput({
            id: "full_name",
            name: "full_name",
            value: values.full_name ?? "",
            placeholder: "选填，用于界面展示",
          })}
        </div>

        <div class="field span-2">
          <label for="email">邮箱 <span class="req">*</span></label>
          ${textInput({
            type: "email",
            id: "email",
            name: "email",
            value: values.email ?? "",
            placeholder: "用于登录与找回密码",
            invalid: !!errors.email,
            required: true,
          })}
          ${fieldError(errors.email)}
        </div>

        <div class="field">
          <label for="role">角色 <span class="req">*</span></label>
          <select id="role" name="role" class="select" required>
            ${roles.map(
              (r) => html`<option value="${r}" ${values.role === r ? html`selected` : ""}>${roleLabel(r)}</option>`,
            )}
          </select>
          ${fieldError(errors.role)}
          <p class="field-hint">管理员可管理用户；仓管员可操作库存；只读用户仅能查看。</p>
        </div>

        ${isEdit
          ? html`<div class="field">
          <label for="status">账号状态</label>
          <select id="status" name="status" class="select">
            <option value="active" ${values.status === "active" ? html`selected` : ""}>已启用</option>
            <option value="disabled" ${values.status === "disabled" ? html`selected` : ""}>已禁用</option>
          </select>
          <p class="field-hint">禁用后该账号将无法登录，已登录的会话立即失效。</p>
        </div>`
          : ""}

        ${passwordField(isEdit, errors.password)}
      </div>
    </div>

    <div class="card-foot form-actions">
      <a href="/users" class="btn btn-ghost">取消</a>
      <button type="submit" class="btn btn-primary">${isEdit ? "保存修改" : "创建用户"}</button>
    </div>
  </form>

</div>`;
  },
};

/**
 * 密码字段。
 *
 * 编辑时**不能**用 ui.ts 的 passwordInput：它固定带 required，
 * 而编辑页留空表示「不修改密码」，浏览器会直接把提交挡下来。
 */
function passwordField(isEdit: boolean, error: string | undefined): Html {
  const label = isEdit ? html`重置密码` : html`初始密码 <span class="req">*</span>`;
  const placeholder = isEdit ? "留空表示不修改密码" : "至少 8 位，需包含字母和数字";
  return html`<div class="field span-2">
          <label for="password">${label}</label>
          <div class="input-group">
            <input type="password" id="password" name="password"
                   class="input ${error ? "is-invalid" : ""}"
                   placeholder="${placeholder}"
                   autocomplete="new-password" ${isEdit ? "" : html`required`}>
            <button type="button" class="input-suffix" data-toggle-password="password">显示</button>
          </div>
          ${fieldError(error)}
        </div>`;
}
