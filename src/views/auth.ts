// 认证相关页面 —— 对应原 Go 版 web/templates/auth/*.html。

import { SECURITY_ANSWER_MIN_LEN, SECURITY_QUESTION_MAX_LEN } from "../db/security";
import { SECURITY_QUESTION_COUNT } from "../types";
import { html, type Html } from "./html";
import type { PageData, View } from "./render";
import {
  alertError,
  alertInfo,
  alertWarning,
  fieldError,
  passwordInput,
  strengthMeter,
  textInput,
} from "./ui";

type Values = Record<string, string>;
type Errors = Record<string, string>;

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

export interface LoginData {
  values: Values;
  errors: Errors;
  next: string;
}

export const loginView: View<LoginData> = {
  content(pd) {
    const { values, errors, next } = pd.data;
    return html`<div class="auth-card">
  <h2 class="auth-title">登录</h2>
  <p class="auth-subtitle">使用您的账号继续访问库存管理系统</p>

  ${alertError(errors.form)}

  <form method="post" action="/login" class="form" novalidate>
    <input type="hidden" name="_csrf" value="${pd.csrf}">
    <input type="hidden" name="next" value="${next}">

    <div class="field">
      <label for="identifier">用户名或邮箱</label>
      ${textInput({
        id: "identifier",
        name: "identifier",
        value: values.identifier ?? "",
        placeholder: "请输入用户名或邮箱",
        invalid: !!errors.identifier,
        autocomplete: "username",
        required: true,
        autofocus: true,
      })}
      ${fieldError(errors.identifier)}
    </div>

    <div class="field">
      <label for="password">密码</label>
      ${passwordInput({
        id: "password",
        name: "password",
        placeholder: "请输入密码",
        invalid: !!errors.password,
        autocomplete: "current-password",
      })}
      ${fieldError(errors.password)}
    </div>

    <div class="field-row">
      <label class="checkbox">
        <input type="checkbox" name="remember" value="1">
        <span>记住我（30 天内免登录）</span>
      </label>
      <a href="/forgot-password" class="link">忘记密码？</a>
    </div>

    <button type="submit" class="btn btn-primary btn-block">登录</button>
  </form>

  ${pd.allowRegistration
    ? html`<p class="auth-switch">还没有账号？<a href="/register" class="link">立即注册</a></p>`
    : html`<p class="auth-switch">系统已关闭自助注册，请联系管理员开通账号。</p>`}
</div>`;
  },
};

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export interface RegisterData {
  values: Values;
  errors: Errors;
  disabled: boolean;
}

export const registerView: View<RegisterData> = {
  content(pd) {
    const { values, errors, disabled } = pd.data;
    const questionNos = Array.from({ length: SECURITY_QUESTION_COUNT }, (_, i) => i + 1);

    return html`<div class="auth-card">
  <h2 class="auth-title">创建账号</h2>
  <p class="auth-subtitle">注册后即可开始管理您的库存</p>

  ${alertError(errors.form)}

  ${disabled
    ? html`<div class="alert alert-warning">
      <span>系统当前已关闭自助注册，请联系管理员为您开通账号。</span>
    </div>
    <a href="/login" class="btn btn-primary btn-block">返回登录</a>`
    : html`<form method="post" action="/register" class="form" novalidate>
    <input type="hidden" name="_csrf" value="${pd.csrf}">

    <div class="field">
      <label for="username">用户名 <span class="req">*</span></label>
      ${textInput({
        id: "username",
        name: "username",
        value: values.username ?? "",
        placeholder: "3-32 位字母、数字、下划线",
        invalid: !!errors.username,
        autocomplete: "username",
        required: true,
        autofocus: true,
      })}
      ${fieldError(errors.username)}
    </div>

    <div class="field">
      <label for="full_name">姓名</label>
      ${textInput({
        id: "full_name",
        name: "full_name",
        value: values.full_name ?? "",
        placeholder: "选填，用于界面展示",
        autocomplete: "name",
      })}
    </div>

    <div class="field">
      <label for="email">邮箱 <span class="req">*</span></label>
      ${textInput({
        type: "email",
        id: "email",
        name: "email",
        value: values.email ?? "",
        placeholder: "用于联系与身份标识",
        invalid: !!errors.email,
        autocomplete: "email",
        required: true,
      })}
      ${fieldError(errors.email)}
    </div>

    <div class="field">
      <label for="password">密码 <span class="req">*</span></label>
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
      <label for="password_confirm">确认密码 <span class="req">*</span></label>
      ${passwordInput({
        id: "password_confirm",
        name: "password_confirm",
        placeholder: "请再次输入密码",
        invalid: !!errors.password_confirm,
        autocomplete: "new-password",
      })}
      ${fieldError(errors.password_confirm)}
    </div>

    <div class="form-divider">
      <span>安全问题</span>
    </div>

    ${alertInfo(
      "忘记密码时需要用这些问题验证身份，请自行编写问题并牢记答案。答案不区分大小写与前后空格。",
    )}

    ${questionNos.map((no) => securityQuestionField(no, values, errors))}

    <button type="submit" class="btn btn-primary btn-block">注册</button>
  </form>`}

  <p class="auth-switch">已有账号？<a href="/login" class="link">返回登录</a></p>
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

      <input type="text" id="${aKey}" name="${aKey}"
             class="input security-answer ${errors[aKey] ? "is-invalid" : ""}"
             placeholder="请填写答案（${SECURITY_ANSWER_MIN_LEN}-100 个字）"
             maxlength="100" autocomplete="off" required>
      ${fieldError(errors[aKey])}
    </div>`;
}

// ---------------------------------------------------------------------------
// 找回密码
// ---------------------------------------------------------------------------

export interface ForgotQuestionItem {
  no: number;
  field: string;
  text: string;
  error: string;
  answer: string;
}

export interface ForgotData {
  step: 1 | 2;
  identifier: string;
  username: string;
  questions: ForgotQuestionItem[];
  values: Values;
  errors: Errors;
}

export const forgotView: View<ForgotData> = {
  content(pd) {
    if (pd.data.step === 2) return forgotStep2(pd);
    return forgotStep1(pd);
  },
};

function forgotStep1(pd: PageData<ForgotData>): Html {
  const { values, errors } = pd.data;
  return html`<div class="auth-card">
    <h2 class="auth-title">忘记密码</h2>
    <p class="auth-subtitle">输入您的用户名或邮箱，回答注册时设置的安全问题即可重置密码</p>

    ${alertError(errors.form)}

    <form method="post" action="/forgot-password" class="form" novalidate>
      <input type="hidden" name="_csrf" value="${pd.csrf}">

      <div class="field">
        <label for="identifier">用户名或邮箱</label>
        ${textInput({
          id: "identifier",
          name: "identifier",
          value: values.identifier ?? "",
          placeholder: "请输入用户名或注册邮箱",
          invalid: !!errors.identifier,
          autocomplete: "username",
          required: true,
          autofocus: true,
        })}
        ${fieldError(errors.identifier)}
      </div>

      <button type="submit" class="btn btn-primary btn-block">下一步</button>
    </form>

    ${alertInfo("如果忘记了安全问题的答案，请联系管理员为您重置密码。")}

    <p class="auth-switch"><a href="/login" class="link">返回登录</a></p>
</div>`;
}

function forgotStep2(pd: PageData<ForgotData>): Html {
  const { identifier, username, questions, errors } = pd.data;
  return html`<div class="auth-card">
    <h2 class="auth-title">回答安全问题</h2>
    <p class="auth-subtitle">
      正在为账号 <strong>${username}</strong> 重置密码，请回答注册时设置的安全问题
    </p>

    ${alertError(errors.form)}

    <form method="post" action="/forgot-password/reset" class="form" novalidate>
      <input type="hidden" name="_csrf" value="${pd.csrf}">
      <input type="hidden" name="identifier" value="${identifier}">

      ${questions.map(
        (q) => html`<div class="field security-item">
        <label for="${q.field}">问题 ${q.no}</label>
        <p class="security-question">${q.text}</p>
        <input type="text" id="${q.field}" name="${q.field}"
               value="${q.answer}"
               class="input security-answer ${q.error ? "is-invalid" : ""}"
               placeholder="请输入答案（不区分大小写）"
               maxlength="100" autocomplete="off" required>
        ${fieldError(q.error)}
      </div>`,
      )}

      <div class="form-divider"><span>设置新密码</span></div>

      <div class="field">
        <label for="password">新密码</label>
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
        <label for="password_confirm">确认新密码</label>
        ${passwordInput({
          id: "password_confirm",
          name: "password_confirm",
          placeholder: "请再次输入新密码",
          invalid: !!errors.password_confirm,
          autocomplete: "new-password",
        })}
        ${fieldError(errors.password_confirm)}
      </div>

      <button type="submit" class="btn btn-primary btn-block">重置密码</button>
    </form>

    <p class="auth-switch">
      <a href="/forgot-password" class="link">换一个账号</a>
      <span class="dot">·</span>
      <a href="/login" class="link">返回登录</a>
    </p>
</div>`;
}
