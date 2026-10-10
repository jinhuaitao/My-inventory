// 个人中心页面 —— 对应原 Go 版 web/templates/profile.html、password.html、
// security.html、sessions.html。

import {
  SECURITY_ANSWER_MAX_LEN,
  SECURITY_QUESTION_MAX_LEN,
} from "../db/security";
import { defaultString, formatNumber, truncate } from "../lib/format";
import { formatDateTime, formatDateTimePtr, relativeTime } from "../lib/time";
import {
  roleLabel,
  SECURITY_QUESTION_COUNT,
  userDisplayName,
  userInitials,
  userIsActive,
  type Session,
} from "../types";
import { html, type Html } from "./html";
import type { View } from "./render";
import {
  alertError,
  alertInfo,
  alertSuccess,
  alertWarning,
  fieldError,
  passwordInput,
  strengthMeter,
  textInput,
} from "./ui";

type Values = Record<string, string>;
type Errors = Record<string, string>;

// ---------------------------------------------------------------------------
// 个人资料
// ---------------------------------------------------------------------------

export interface ProfileData {
  values: Values;
  errors: Errors;
  sessions: Session[];
  currentSessionId: number;
  sessionCount: number;
  securityConfigured: boolean;
}

export const profileView: View<ProfileData> = {
  content(pd) {
    const user = pd.user!;
    const { values, errors, sessions, currentSessionId, sessionCount, securityConfigured } = pd.data;

    return html`<div class="page">

  <div class="page-head">
    <div>
      <h2 class="page-title">个人资料</h2>
      <p class="page-desc">管理您的账号信息与登录设备</p>
    </div>
  </div>

  <div class="grid-2">
    <section class="card">
      <div class="card-head"><h2 class="card-title">基本信息</h2></div>

      ${errors.form
        ? html`<div class="card-body no-pad-bottom">${alertError(errors.form)}</div>`
        : ""}

      <form method="post" action="/profile" class="form">
        <input type="hidden" name="_csrf" value="${pd.csrf}">
        <div class="card-body">
          <div class="profile-head">
            <span class="avatar lg">${userInitials(user)}</span>
            <div>
              <div class="profile-name">${userDisplayName(user)}</div>
              <div class="profile-meta">@${user.username} · ${roleLabel(user.role)}</div>
            </div>
          </div>

          <div class="field">
            <label>用户名</label>
            <input type="text" class="input" value="${user.username}" disabled>
            <p class="field-hint">用户名不可修改</p>
          </div>

          <div class="field">
            <label for="full_name">姓名</label>
            <input type="text" id="full_name" name="full_name" value="${values.full_name ?? ""}"
                   class="input" placeholder="用于界面展示">
          </div>

          <div class="field">
            <label for="email">邮箱</label>
            <input type="email" id="email" name="email" value="${values.email ?? ""}"
                   class="input ${errors.email ? "is-invalid" : ""}"
                   placeholder="用于找回密码" required>
            ${fieldError(errors.email)}
          </div>

          <div class="field">
            <label for="current_password">当前密码</label>
            <input type="password" id="current_password" name="current_password"
                   class="input ${errors.current_password ? "is-invalid" : ""}"
                   autocomplete="current-password" placeholder="仅在修改邮箱时需要填写">
            ${fieldError(errors.current_password)}
            <p class="field-hint">邮箱是找回密码的凭据，修改时需要验证当前密码；只改姓名可留空</p>
          </div>
        </div>

        <div class="card-foot form-actions">
          <button type="submit" class="btn btn-primary">保存修改</button>
        </div>
      </form>
    </section>

    <div class="stack">
      <section class="card">
        <div class="card-head"><h2 class="card-title">账号安全</h2></div>
        <div class="card-body">
          <dl class="detail-list">
            <div class="detail-row"><dt>角色</dt><dd>${roleLabel(user.role)}</dd></div>
            <div class="detail-row"><dt>账号状态</dt>
              <dd>${userIsActive(user)
                ? html`<span class="badge badge-success">已启用</span>`
                : html`<span class="badge badge-muted">已禁用</span>`}</dd>
            </div>
            <div class="detail-row"><dt>最后登录</dt><dd>${formatDateTimePtr(user.lastLoginAt)}</dd></div>
            <div class="detail-row"><dt>注册时间</dt><dd>${formatDateTime(user.createdAt)}</dd></div>
            <div class="detail-row"><dt>活跃设备</dt><dd>${formatNumber(sessionCount)} 台</dd></div>
            <div class="detail-row"><dt>安全问题</dt>
              <dd>
                ${securityConfigured
                  ? html`<span class="badge badge-success">已设置</span>`
                  : html`<span class="badge badge-warning">未设置</span>
                  <span class="muted">忘记密码时无法自助重置</span>`}
              </dd>
            </div>
          </dl>
          <div class="card-actions-row">
            <a href="/profile/password" class="btn btn-outline btn-sm">修改密码</a>
            <a href="/profile/security" class="btn btn-outline btn-sm">安全问题</a>
            <a href="/profile/sessions" class="btn btn-outline btn-sm">管理登录设备</a>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2 class="card-title">最近登录设备</h2>
          <a href="/profile/sessions" class="card-link">全部</a>
        </div>
        <div class="card-body no-pad">
          ${sessions.length > 0
            ? html`<table class="table table-compact">
            <thead><tr><th>设备</th><th>IP</th><th>时间</th></tr></thead>
            <tbody>
              ${sessions.map(
                (s) => html`<tr>
                <td>
                  ${truncate(defaultString(s.userAgent, "未知设备"), 28)}
                  ${s.id === currentSessionId ? html`<span class="badge badge-info">当前</span>` : ""}
                </td>
                <td class="mono muted">${defaultString(s.ip, "—")}</td>
                <td class="muted nowrap">${relativeTime(s.createdAt)}</td>
              </tr>`,
              )}
            </tbody>
          </table>`
            : html`<div class="empty-inline">暂无登录记录</div>`}
        </div>
      </section>
    </div>
  </div>

</div>`;
  },
};

// ---------------------------------------------------------------------------
// 修改密码
// ---------------------------------------------------------------------------

export interface PasswordData {
  errors: Errors;
}

export const passwordView: View<PasswordData> = {
  content(pd) {
    const { errors } = pd.data;

    return html`<div class="page page-narrow">

  <div class="page-head">
    <div>
      <h2 class="page-title">修改密码</h2>
      <p class="page-desc">修改成功后，其它设备上的登录状态将立即失效。</p>
    </div>
    <div class="page-actions">
      <a href="/profile" class="btn btn-ghost">返回个人资料</a>
    </div>
  </div>

  ${alertError(errors.form)}

  <form method="post" action="/profile/password" class="card form">
    <input type="hidden" name="_csrf" value="${pd.csrf}">

    <div class="card-body">
      <div class="field">
        <label for="current_password">当前密码 <span class="req">*</span></label>
        ${passwordInput({
          id: "current_password",
          name: "current_password",
          placeholder: "",
          invalid: !!errors.current_password,
          autocomplete: "current-password",
        })}
        ${fieldError(errors.current_password)}
      </div>

      <div class="field">
        <label for="password">新密码 <span class="req">*</span></label>
        ${passwordInput({
          id: "password",
          name: "password",
          placeholder: "至少 8 位，需包含字母和数字",
          invalid: !!errors.password,
          autocomplete: "new-password",
          strength: true,
        })}
        ${strengthMeter()}
        ${fieldError(errors.password)}
      </div>

      <div class="field">
        <label for="password_confirm">确认新密码 <span class="req">*</span></label>
        ${passwordInput({
          id: "password_confirm",
          name: "password_confirm",
          placeholder: "",
          invalid: !!errors.password_confirm,
          autocomplete: "new-password",
        })}
        ${fieldError(errors.password_confirm)}
      </div>
    </div>

    <div class="card-foot form-actions">
      <a href="/profile" class="btn btn-ghost">取消</a>
      <button type="submit" class="btn btn-primary">确认修改</button>
    </div>
  </form>

</div>`;
  },
};

// ---------------------------------------------------------------------------
// 安全问题
// ---------------------------------------------------------------------------

export interface SecurityData {
  values: Values;
  errors: Errors;
  count: number;
  required: number;
  configured: boolean;
}

export const securityView: View<SecurityData> = {
  content(pd) {
    const { values, errors, count, required, configured } = pd.data;
    const questionNos = Array.from({ length: SECURITY_QUESTION_COUNT }, (_, i) => i + 1);

    return html`<div class="page page-narrow">

  <div class="page-head">
    <div>
      <h2 class="page-title">安全问题</h2>
      <p class="page-desc">
        忘记密码时需要用这些问题验证身份。共需设置 ${required} 个问题，请牢记答案。
      </p>
    </div>
    <div class="page-actions">
      <a href="/profile" class="btn btn-ghost">返回个人资料</a>
    </div>
  </div>

  ${configured
    ? alertSuccess(`已完成 ${count} 个安全问题的设置，忘记密码时可自助重置。`)
    : alertWarning("您尚未设置完整的安全问题，目前无法自助找回密码，请尽快在下方完成设置。")}

  ${alertError(errors.form)}

  <form method="post" action="/profile/security" class="card form">
    <input type="hidden" name="_csrf" value="${pd.csrf}">

    <div class="card-body">
      ${alertInfo(
        "答案不区分大小写，前后的空格会被自动忽略。建议选择只有您本人知道、且长期不会改变的答案——因为它是您找回密码的唯一凭据。",
      )}

      ${questionNos.map((no) => securityQuestionField(no, values, errors))}

      <div class="form-divider"><span>身份确认</span></div>

      <div class="field">
        <label for="current_password">当前密码 <span class="req">*</span></label>
        ${passwordInput({
          id: "current_password",
          name: "current_password",
          placeholder: "修改安全问题需要验证当前密码",
          invalid: !!errors.current_password,
          autocomplete: "current-password",
        })}
        ${fieldError(errors.current_password)}
      </div>
    </div>

    <div class="card-foot form-actions">
      <a href="/profile" class="btn btn-ghost">取消</a>
      <button type="submit" class="btn btn-primary">保存安全问题</button>
    </div>
  </form>

</div>`;
  },
};

function securityQuestionField(no: number, values: Values, errors: Errors): Html {
  const qKey = `question_${no}`;
  const aKey = `answer_${no}`;
  return html`<div class="field security-item">
        <label for="${qKey}">问题 ${no} <span class="req">*</span></label>
        ${textInput({
          id: qKey,
          name: qKey,
          value: values[qKey] ?? "",
          placeholder: "例如：我小学班主任的姓名是？",
          invalid: !!errors[qKey],
          maxlength: SECURITY_QUESTION_MAX_LEN,
          required: true,
        })}
        ${fieldError(errors[qKey])}

        ${/* 答案刻意不回填：它等同于第二把钥匙，重新渲染到页面上等于把它
             交回给任何能读到 HTML 的人（含浏览器的表单恢复与共享设备）。 */ ""}
        ${textInput({
          id: aKey,
          name: aKey,
          className: "security-answer",
          placeholder: "请重新填写答案（出于安全考虑不回显）",
          invalid: !!errors[aKey],
          autocomplete: "off",
          maxlength: SECURITY_ANSWER_MAX_LEN,
          required: true,
        })}
        ${fieldError(errors[aKey])}
      </div>`;
}

// ---------------------------------------------------------------------------
// 登录设备
// ---------------------------------------------------------------------------

export interface SessionsData {
  sessions: Session[];
  currentSessionId: number;
}

export const sessionsView: View<SessionsData> = {
  content(pd) {
    const { sessions, currentSessionId } = pd.data;

    return html`<div class="page page-narrow">

  <div class="page-head">
    <div>
      <h2 class="page-title">登录设备</h2>
      <p class="page-desc">当前共有 ${formatNumber(sessions.length)} 台设备处于登录状态</p>
    </div>
    <div class="page-actions">
      <form method="post" action="/profile/sessions/revoke-all" class="inline-form"
            data-confirm="确定退出除当前设备外的所有登录吗？">
        <input type="hidden" name="_csrf" value="${pd.csrf}">
        <button type="submit" class="btn btn-outline">退出其它设备</button>
      </form>
      <a href="/profile" class="btn btn-ghost">返回</a>
    </div>
  </div>

  <div class="card">
    <div class="card-body no-pad">
      ${sessions.length > 0
        ? html`<table class="table">
        <thead>
          <tr><th>设备信息</th><th>IP 地址</th><th>登录时间</th><th>有效期至</th><th class="actions-col">操作</th></tr>
        </thead>
        <tbody>
          ${sessions.map(
            (s) => html`<tr>
            <td>
              <div class="cell-title">
                ${truncate(defaultString(s.userAgent, "未知设备"), 40)}
                ${s.id === currentSessionId ? html`<span class="badge badge-info">当前设备</span>` : ""}
              </div>
            </td>
            <td class="mono muted">${defaultString(s.ip, "—")}</td>
            <td class="muted nowrap">${formatDateTime(s.createdAt)}</td>
            <td class="muted nowrap">${formatDateTime(s.expiresAt)}</td>
            <td class="actions-col">
              ${s.id !== currentSessionId
                ? html`<form method="post" action="/profile/sessions/revoke" class="inline-form">
                <input type="hidden" name="_csrf" value="${pd.csrf}">
                <input type="hidden" name="session_id" value="${s.id}">
                <button type="submit" class="btn btn-xs btn-danger-ghost">退出</button>
              </form>`
                : html`<span class="muted">—</span>`}
            </td>
          </tr>`,
          )}
        </tbody>
      </table>`
        : html`<div class="empty-inline">暂无登录设备</div>`}
    </div>
  </div>

</div>`;
  },
};
