// 个人中心路由 —— 对应原 Go 版 internal/handlers/profile.go 与 security.go。
//
// 涵盖个人资料、修改密码、安全问题、登录设备四块。

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import {
  SECURITY_QUESTION_COUNT,
  type AnswerInput,
  type SecurityQuestion,
  type Session,
} from "../types";
import { AppError, isErrorCode, stripCodePrefix } from "../lib/errors";
import { isValidEmail, validatePassword } from "../lib/validate";
import { validateSecurityAnswers } from "../db/security";
import {
  passwordView,
  profileView,
  securityView,
  sessionsView,
  type ProfileData,
  type SecurityData,
} from "../views/profile";
import {
  businessErrorMessage,
  formInt,
  formRaw,
  formValue,
  redirectWith,
  render,
  serverError,
} from "./helpers";

export const profileRoutes = new Hono<AppEnv>();

type Values = Record<string, string>;
type Errors = Record<string, string>;

// ---------------------------------------------------------------------------
// 个人资料
// ---------------------------------------------------------------------------

/**
 * 组装个人资料页所需的全部上下文。
 *
 * 附属信息取不到时不再伪装成「无设备 / 未设置安全问题」——
 * 那会把数据库故障粉饰成正常状态，用户与运维都被误导。
 * 出错记 Warn，页面上的空态同时附上「可能未刷新成功」提示。
 */
async function profileData(c: Context<AppEnv>, values: Values, errors: Errors): Promise<ProfileData> {
  const user = c.get("user")!;
  const store = c.get("store");
  const logger = c.get("logger");

  let sessions: Session[] = [];
  try {
    sessions = await store.listUserSessions(user.id);
  } catch (err) {
    logger.warn("加载登录设备列表失败", { 错误: err instanceof Error ? err.message : String(err) });
    sessions = [];
    errors = mergeProfileNotice(errors, "部分信息加载失败，请刷新页面重试");
  }

  const currentId = c.get("session")?.id ?? 0;

  let securityConfigured = false;
  try {
    securityConfigured = await store.hasSecurityQuestions(user.id);
  } catch (err) {
    logger.warn("检查安全问题设置状态失败", { 错误: err instanceof Error ? err.message : String(err) });
    errors = mergeProfileNotice(errors, "部分信息加载失败，请刷新页面重试");
  }

  return {
    values,
    errors,
    sessions,
    currentSessionId: currentId,
    sessionCount: sessions.length,
    securityConfigured,
  };
}

/**
 * 在不覆盖既有表单错误的前提下补一条页面级提示，
 * 让「附属信息加载失败」对用户可见，而不是静默显示成空数据。
 */
function mergeProfileNotice(errors: Errors, msg: string): Errors {
  if (!errors.form) errors.form = msg;
  return errors;
}

/** 展示个人资料与登录设备。 */
profileRoutes.get("/profile", async (c) => {
  const user = c.get("user")!;
  const data = await profileData(
    c,
    { full_name: user.fullName, email: user.email },
    {},
  );
  return render(c, 200, "个人资料", "profile", data, profileView);
});

/**
 * 更新当前用户的资料。
 *
 * 姓名可以随意改；**邮箱不行** —— 它是账号的唯一标识与找回密码的通道，
 * 属于敏感的身份变更，必须做一次「再验证」（要求重新输入当前密码）。
 *
 * 否则只要会话被窃取（XSS、未锁屏的设备、被复制走的 cookie），
 * 攻击者改掉邮箱就等于把找回通道指向自己，随后完成账号接管 ——
 * 而受害者连一条通知都收不到。站内「修改安全问题」已经有这个要求，
 * 改邮箱的敏感度相当，不应例外。
 */
profileRoutes.post("/profile", async (c) => {
  const user = c.get("user")!;
  const store = c.get("store");
  const logger = c.get("logger");

  const fullName = await formValue(c, "full_name");
  const email = await formValue(c, "email");
  const current = await formRaw(c, "current_password");

  const values: Values = { full_name: fullName, email };
  const errors: Errors = {};
  if (!isValidEmail(email)) {
    errors.email = "请输入有效的邮箱地址";
  }

  // 只有邮箱确实发生变化时才要求密码 —— 避免改个姓名也要输密码的无谓摩擦。
  const emailChanged = email.trim().toLowerCase() !== user.email.trim().toLowerCase();
  if (emailChanged && current === "") {
    errors.current_password = "修改邮箱需要输入当前密码";
  }

  if (Object.keys(errors).length > 0) {
    return render(c, 422, "个人资料", "profile", await profileData(c, values, errors), profileView);
  }

  // 密码校验放在最后：先做完廉价的格式检查，避免无意义的计算开销。
  if (emailChanged && !(await store.checkPassword(user.passwordHash, current)).ok) {
    logger.warn("修改邮箱时当前密码校验失败", { 用户: user.username });
    errors.current_password = "当前密码不正确";
    return render(c, 422, "个人资料", "profile", await profileData(c, values, errors), profileView);
  }

  try {
    await store.updateProfile(user.id, fullName, email);
  } catch (err) {
    if (isErrorCode(err, "conflict")) {
      errors.email = businessErrorMessage(err);
    } else {
      errors.form = businessErrorMessage(err);
    }
    return render(c, 422, "个人资料", "profile", await profileData(c, values, errors), profileView);
  }

  if (emailChanged) {
    logger.info("用户修改了邮箱", { 用户: user.username, 新邮箱: email });
  }
  return redirectWith(c, "/profile", "success", "个人资料已更新");
});

// ---------------------------------------------------------------------------
// 修改密码
// ---------------------------------------------------------------------------

/** 展示修改密码表单。 */
profileRoutes.get("/profile/password", async (c) => {
  return render(c, 200, "修改密码", "profile", { errors: {} }, passwordView);
});

/** 处理修改密码提交。 */
profileRoutes.post("/profile/password", async (c) => {
  const user = c.get("user")!;
  const store = c.get("store");
  const logger = c.get("logger");

  const current = await formRaw(c, "current_password");
  const password = await formRaw(c, "password");
  const confirm = await formRaw(c, "password_confirm");

  const errors: Errors = {};

  if (current === "") {
    errors.current_password = "请输入当前密码";
  }
  const pwError = validatePassword(password);
  if (pwError) errors.password = pwError;
  if (password !== confirm) {
    errors.password_confirm = "两次输入的密码不一致";
  }
  if (current !== "" && password !== "" && current === password) {
    errors.password = "新密码不能与当前密码相同";
  }

  if (Object.keys(errors).length > 0) {
    return render(c, 422, "修改密码", "profile", { errors }, passwordView);
  }

  try {
    await store.changePassword(user.id, current, password);
  } catch (err) {
    if (isErrorCode(err, "invalidCredentials")) {
      errors.current_password = "当前密码不正确";
    } else {
      errors.form = businessErrorMessage(err);
    }
    return render(c, 422, "修改密码", "profile", { errors }, passwordView);
  }

  // 保留当前设备会话，踢掉其它设备
  const keepHash = c.get("session")?.tokenHash;
  try {
    await store.deleteSessionsByUser(user.id, keepHash);
  } catch (err) {
    logger.warn("清理其它会话失败", { 错误: err instanceof Error ? err.message : String(err) });
  }

  logger.info("用户修改了密码", { 用户: user.username });
  return redirectWith(c, "/profile", "success", "密码修改成功，其它设备已被强制退出");
});

// ---------------------------------------------------------------------------
// 安全问题
// ---------------------------------------------------------------------------

/**
 * 展示并允许修改当前用户的安全问题。
 *
 * 安全问题直接决定能否自助找回密码，因此修改前必须验证当前密码。
 */
profileRoutes.get("/profile/security", async (c) => {
  const user = c.get("user")!;
  const store = c.get("store");

  let questions: SecurityQuestion[];
  try {
    questions = await store.getSecurityQuestions(user.id);
  } catch (err) {
    return serverError(c, err);
  }

  const values: Values = {};
  for (const q of questions) {
    values[`question_${q.position}`] = q.question;
  }

  return render(
    c,
    200,
    "安全问题",
    "profile",
    {
      values,
      errors: {},
      count: questions.length,
      required: SECURITY_QUESTION_COUNT,
      configured: questions.length >= SECURITY_QUESTION_COUNT,
    },
    securityView,
  );
});

/** 保存安全问题。 */
profileRoutes.post("/profile/security", async (c) => {
  const user = c.get("user")!;
  const store = c.get("store");
  const logger = c.get("logger");

  const current = await formRaw(c, "current_password");
  const security = await parseSecurityInputs(c);

  const values = securityValues(security);
  const errors: Errors = {};

  if (current === "") {
    errors.current_password = "请输入当前密码以确认身份";
  }
  // 服务层校验会抛错，逐字段映射后用于标红
  try {
    validateSecurityAnswers(security);
  } catch (err) {
    Object.assign(errors, securityErrors(err));
  }

  if (Object.keys(errors).length > 0) {
    return renderSecurityForm(c, 422, values, errors);
  }

  // 校验当前密码
  if (!(await store.checkPassword(user.passwordHash, current)).ok) {
    errors.current_password = "当前密码不正确";
    return renderSecurityForm(c, 422, values, errors);
  }

  try {
    await store.setSecurityQuestions(user.id, security);
  } catch (err) {
    if (isErrorCode(err, "invalidInput")) {
      Object.assign(errors, securityErrors(err));
    } else {
      errors.form = businessErrorMessage(err);
    }
    return renderSecurityForm(c, 422, values, errors);
  }

  logger.info("用户更新了安全问题", { 用户: user.username });
  return redirectWith(
    c,
    "/profile/security",
    "success",
    "安全问题已更新，请牢记答案——它们是您找回密码的唯一凭据",
  );
});

/** 统一渲染安全问题表单。 */
async function renderSecurityForm(
  c: Context<AppEnv>,
  status: 422,
  values: Values,
  errors: Errors,
): Promise<Response> {
  const user = c.get("user")!;
  const store = c.get("store");

  let count = 0;
  try {
    count = await store.countSecurityQuestions(user.id);
  } catch {
    // 读不到就当作「未设置」展示，具体错误已由上层决定是否提示
    count = 0;
  }

  const data: SecurityData = {
    values,
    errors,
    count,
    required: SECURITY_QUESTION_COUNT,
    configured: count >= SECURITY_QUESTION_COUNT,
  };
  return render(c, status, "安全问题", "profile", data, securityView);
}

// ---------------------------------------------------------------------------
// 登录设备
// ---------------------------------------------------------------------------

/** 展示登录设备列表。 */
profileRoutes.get("/profile/sessions", async (c) => {
  const user = c.get("user")!;
  const store = c.get("store");

  let sessions: Session[];
  try {
    sessions = await store.listUserSessions(user.id);
  } catch (err) {
    return serverError(c, err);
  }

  const currentId = c.get("session")?.id ?? 0;
  return render(
    c,
    200,
    "登录设备",
    "profile",
    { sessions, currentSessionId: currentId },
    sessionsView,
  );
});

/** 注销指定的其它设备。 */
profileRoutes.post("/profile/sessions/revoke", async (c) => {
  const user = c.get("user")!;
  const store = c.get("store");

  const id = await formInt(c, "session_id", 0);
  if (id <= 0) {
    return redirectWith(c, "/profile/sessions", "error", "参数不正确");
  }

  if (c.get("session")?.id === id) {
    return redirectWith(c, "/profile/sessions", "warning", "当前设备请使用「退出登录」");
  }

  try {
    await store.deleteSessionById(id, user.id);
  } catch (err) {
    return redirectWith(c, "/profile/sessions", "error", businessErrorMessage(err));
  }
  return redirectWith(c, "/profile/sessions", "success", "该设备已退出登录");
});

/** 注销除当前设备外的全部会话。 */
profileRoutes.post("/profile/sessions/revoke-all", async (c) => {
  const user = c.get("user")!;
  const store = c.get("store");

  // 保留当前设备会话：把用户从自己正在用的这台设备上踢下线，
  // 只会逼他重新登录一次，没有任何安全收益。
  const keepHash = c.get("session")?.tokenHash;

  let n: number;
  try {
    n = await store.deleteSessionsByUser(user.id, keepHash);
  } catch (err) {
    return redirectWith(c, "/profile/sessions", "error", businessErrorMessage(err));
  }

  if (n === 0) {
    return redirectWith(c, "/profile/sessions", "info", "没有其它登录设备需要退出");
  }
  return redirectWith(c, "/profile/sessions", "success", `已退出其它 ${n} 个设备`);
});

// ---------------------------------------------------------------------------
// 安全问题解析辅助（对应 Go 版 handlers/auth.go 的同名函数）
// ---------------------------------------------------------------------------

/** 从表单中读取 N 组「问题 + 答案」。 */
async function parseSecurityInputs(c: Context<AppEnv>): Promise<AnswerInput[]> {
  const out: AnswerInput[] = [];
  for (let i = 1; i <= SECURITY_QUESTION_COUNT; i++) {
    out.push({
      question: await formValue(c, `question_${i}`),
      answer: await formValue(c, `answer_${i}`),
    });
  }
  return out;
}

/**
 * 收集安全问题表单值，用于校验失败时回填。
 * 出于安全考虑，答案不回填到页面。
 */
function securityValues(inputs: AnswerInput[]): Values {
  const out: Values = {};
  for (let i = 0; i < inputs.length; i++) {
    out[`question_${i + 1}`] = inputs[i].question;
  }
  return out;
}

/**
 * 把安全问题校验错误映射到具体字段，便于逐项标红。
 *
 * 服务层错误形如「参数不合法：第 2 个问题的答案至少需要 2 个字」。
 */
function securityErrors(err: unknown): Errors {
  const out: Errors = {};
  if (!(err instanceof AppError)) return out;

  const msg = err.message;
  for (let i = 1; i <= SECURITY_QUESTION_COUNT; i++) {
    if (msg.includes(`第 ${i} 个问题`)) {
      const field = msg.includes("答案") ? `answer_${i}` : `question_${i}`;
      out[field] = stripCodePrefix(msg);
      return out;
    }
  }
  out.form = stripCodePrefix(msg);
  return out;
}
