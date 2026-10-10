// 页面级小组件 —— 对应原 Go 版模板里反复出现的 alert / field-error 结构。

import { html, type Html } from "./html";

const ICON_ERROR = html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><circle cx="12" cy="16" r="0.9" fill="currentColor" stroke="none"/></svg>`;
const ICON_INFO = html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/></svg>`;

/** 错误提示条。message 为空时不渲染。 */
export function alertError(message: string | undefined | null): Html {
  if (!message) return html``;
  return html`<div class="alert alert-error">${ICON_ERROR}<span>${message}</span></div>`;
}

export function alertInfo(message: string | undefined | null): Html {
  if (!message) return html``;
  return html`<div class="alert alert-info">${ICON_INFO}<span>${message}</span></div>`;
}

export function alertWarning(message: string | undefined | null): Html {
  if (!message) return html``;
  return html`<div class="alert alert-warning"><span>${message}</span></div>`;
}

export function alertSuccess(message: string | undefined | null): Html {
  if (!message) return html``;
  return html`<div class="alert alert-success"><span>${message}</span></div>`;
}

/** 字段级错误提示。 */
export function fieldError(message: string | undefined | null): Html {
  if (!message) return html``;
  return html`<p class="field-error">${message}</p>`;
}

/** 密码强度条（纯前端计算，data-strength-meter 由 app.js 驱动）。 */
export function strengthMeter(): Html {
  return html`<div class="strength" data-strength-meter>
        <span class="strength-seg"></span>
        <span class="strength-seg"></span>
        <span class="strength-seg"></span>
        <span class="strength-seg"></span>
        <span class="strength-label"></span>
      </div>`;
}

/** 带「显示/隐藏」按钮的密码输入框。 */
export function passwordInput(opts: {
  id: string;
  name: string;
  value?: string;
  placeholder: string;
  invalid?: boolean;
  autocomplete: string;
  strength?: boolean;
}): Html {
  return html`<div class="input-group">
        <input type="password" id="${opts.id}" name="${opts.name}"
               value="${opts.value ?? ""}"
               class="input ${opts.invalid ? "is-invalid" : ""}"
               placeholder="${opts.placeholder}"
               autocomplete="${opts.autocomplete}" required
               ${opts.strength ? html`data-strength-input` : ""}>
        <button type="button" class="input-suffix" data-toggle-password="${opts.id}">显示</button>
      </div>`;
}

/** 文本输入框。 */
export function textInput(opts: {
  type?: string;
  id: string;
  name: string;
  value?: string;
  placeholder?: string;
  invalid?: boolean;
  autocomplete?: string;
  required?: boolean;
  autofocus?: boolean;
  maxlength?: number;
  className?: string;
}): Html {
  return html`<input type="${opts.type ?? "text"}" id="${opts.id}" name="${opts.name}"
             value="${opts.value ?? ""}"
             class="input ${opts.className ?? ""} ${opts.invalid ? "is-invalid" : ""}"
             placeholder="${opts.placeholder ?? ""}"
             ${opts.autocomplete ? html`autocomplete="${opts.autocomplete}"` : ""}
             ${opts.maxlength ? html`maxlength="${opts.maxlength}"` : ""}
             ${opts.required ? html`required` : ""}
             ${opts.autofocus ? html`autofocus` : ""}>`;
}
