// 认证路由 —— 对应原 Go 版 internal/handlers/auth.go。

import { Hono } from "hono";
import type { Context } from "hono";
import { SessionManager } from "../auth/session";
import type { AppEnv } from "../context";
import { SECURITY_QUESTION_COUNT, type AnswerInput, roleLabel } from "../types";
import { burnPasswordCheck } from "../lib/crypto";
import { AppError, isAppError, isErrorCode, stripCodePrefix } from "../lib/errors";
import { setError } from "../lib/flash";
import { clientIp } from "../lib/request";
import { isValidEmail, isValidUsername, sanitizeNext, validatePassword } from "../lib/validate";
import { validateSecurityAnswers } from "../db/security";
import { forgotView, loginView, registerView } from "../views/auth";
import {
  businessErrorMessage,
  formBool,
  formRaw,
  formValue,
  redirectWith,
  render,
  serverError,
} from "./helpers";

export const authRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

authRoutes.get("/login", async (c) => {
  return render(c, 200, "登录", "", emptyLoginData(sanitizeNext(c.req.query("next"))), loginView);
});

authRoutes.post("/login", async (c) => {
  const cfg = c.get("cfg");
  const store = c.get("store");
  const logger = c.get("logger");

  const identifier = await formValue(c, "identifier");
  const password = await formRaw(c, "password");
  const remember = await formBool(c, "remember");
  const next = sanitizeNext(await formValue(c, "next"));

  const values: Record<string, string> = { identifier };
  const errors: Record<string, string> = {};
  if (identifier === "") errors.identifier = "请输入用户名或邮箱";
  if (password === "") errors.password = "请输入密码";
  if (Object.keys(errors).length > 0) {
    return render(c, 422, "登录", "", { values, errors, next }, loginView);
  }

  const ip = clientIp(c.req.raw);
  const since = new Date(Date.now() - cfg.lockoutWindowMs).toISOString();

  // 失败次数限制，抵御暴力破解
  if (await loginLocked(c, identifier, ip, since)) {
    // 只留痕、不计入失败次数：否则攻击者持续发请求即可让锁定窗口
    // 无限顺延，把别人的账号永久锁死。
    await store.recordBlockedLoginAttempt(identifier, ip).catch(() => undefined);
    logger.warn("登录已被限流", { 标识: identifier, IP: ip });
    const minutes = Math.floor(cfg.lockoutWindowMs / 60_000);
    return render(
      c,
      429,
      "登录",
      "",
      { values, errors: { form: `登录尝试过于频繁，请 ${minutes} 分钟后再试` }, next },
      loginView,
    );
  }

  const user = await store.getUserByIdentifier(identifier);

  // 账号不存在时也要做一次等量计算：否则「查无此人」比「密码错误」快几十毫秒，
  // 攻击者靠计时差异就能枚举出存在的用户名。
  let passwordOK = false;
  let upgradedHash: string | undefined;
  if (user) {
    const check = await store.checkPassword(user.passwordHash, password);
    passwordOK = check.ok;
    upgradedHash = check.upgradedHash;
  } else {
    await burnPasswordCheck(password);
  }

  if (!passwordOK || !user) {
    await store.recordLoginAttempt(identifier, ip, false).catch(() => undefined);
    return render(
      c,
      401,
      "登录",
      "",
      { values, errors: { form: "用户名或密码错误" }, next },
      loginView,
    );
  }

  if (user.status !== "active") {
    await store.recordLoginAttempt(identifier, ip, false).catch(() => undefined);
    return render(
      c,
      403,
      "登录",
      "",
      { values, errors: { form: "该账号已被禁用，请联系管理员" }, next },
      loginView,
    );
  }

  await store.recordLoginAttempt(identifier, ip, true).catch(() => undefined);
  await store.clearFailedAttempts(identifier).catch(() => undefined);

  // 历史摘要（bcrypt / 低迭代 PBKDF2）在登录成功时透明升级为当前格式
  if (upgradedHash) {
    await store.upgradePasswordHash(user.id, upgradedHash).catch(() => undefined);
  }

  const sessions = new SessionManager(store, cfg);
  await sessions.create(c, user, remember);
  await store.touchLastLogin(user.id).catch(() => undefined);

  const displayName = (user.fullName || "").trim() || user.username;
  return redirectWith(c, next !== "" ? next : "/", "success", `欢迎回来，${displayName}！`);
});

// ---------------------------------------------------------------------------
// 退出登录
// ---------------------------------------------------------------------------

authRoutes.post("/logout", async (c) => {
  const sessions = new SessionManager(c.get("store"), c.get("cfg"));
  try {
    await sessions.destroy(c);
  } catch (err) {
    c.get("logger").warn("退出登录失败", {
      错误: err instanceof Error ? err.message : String(err),
    });
  }
  return redirectWith(c, "/login", "info", "您已安全退出");
});

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

authRoutes.get("/register", async (c) => {
  // 用运行期开关而不是配置默认值：管理员可以在「用户管理」页随时关闭注册，
  // 关闭后这个页面必须立刻拒绝访问，而不是等到下次重启。
  const enabled = (await c.get("store").registrationState(c.get("cfg").allowRegistration)).enabled;
  c.set("registration", enabled);

  if (!enabled) {
    return render(
      c,
      403,
      "注册",
      "",
      {
        values: {},
        errors: { form: "系统已关闭自助注册，请联系管理员开通账号" },
        disabled: true,
      },
      registerView,
    );
  }
  return render(c, 200, "注册", "", { values: {}, errors: {}, disabled: false }, registerView);
});

authRoutes.post("/register", async (c) => {
  const cfg = c.get("cfg");
  const store = c.get("store");
  const logger = c.get("logger");

  // 同上：注册页被关闭后，直接 POST 到这个地址也必须被挡住。
  const enabled = (await store.registrationState(cfg.allowRegistration)).enabled;
  c.set("registration", enabled);
  if (!enabled) {
    setError(c, "系统已关闭自助注册");
    return c.redirect("/login", 303);
  }

  const username = await formValue(c, "username");
  const email = await formValue(c, "email");
  const fullName = await formValue(c, "full_name");
  const password = await formRaw(c, "password");
  const confirm = await formRaw(c, "password_confirm");

  const security: AnswerInput[] = [];
  for (let i = 1; i <= SECURITY_QUESTION_COUNT; i++) {
    security.push({
      question: await formValue(c, `question_${i}`),
      answer: await formValue(c, `answer_${i}`),
    });
  }

  const values: Record<string, string> = { username, email, full_name: fullName };
  for (let i = 0; i < security.length; i++) {
    values[`question_${i + 1}`] = security[i].question;
  }

  const errors: Record<string, string> = {};

  if (!isValidUsername(username)) {
    errors.username = "用户名需为 3-32 位字母、数字、下划线或连字符";
  }
  if (!isValidEmail(email)) {
    errors.email = "请输入有效的邮箱地址";
  }
  const pwError = validatePassword(password);
  if (pwError) errors.password = pwError;
  if (password !== confirm) errors.password_confirm = "两次输入的密码不一致";

  // 安全问题在创建账号前先校验，避免产生「半成品」账号
  try {
    validateSecurityAnswers(security);
  } catch (err) {
    Object.assign(errors, securityErrors(err));
  }

  if (Object.keys(errors).length > 0) {
    return render(c, 422, "注册", "", { values, errors, disabled: false }, registerView);
  }

  // 默认角色由配置决定（默认只读，避免任何人注册即可改库存）；
  // 若系统中还没有任何用户，第一个注册者自动成为管理员。
  let role = cfg.defaultRole;
  if ((await store.countUsers()) === 0) role = "admin";

  try {
    const user = await store.createUserWithQuestions(
      { username, email, password, fullName, role },
      security,
    );
    logger.info("新用户注册成功", { 用户名: user.username, 邮箱: user.email, 角色: roleLabel(user.role) });

    let msg = `注册成功！您的角色是「${roleLabel(user.role)}」，请使用 ${user.username} 登录。`;
    if (user.role === "viewer") {
      msg += "只读权限仅可查看数据，如需操作库存请联系管理员调整角色。";
    }
    return redirectWith(c, "/login", "success", msg);
  } catch (err) {
    if (isErrorCode(err, "conflict")) {
      const message = businessErrorMessage(err);
      if (message.includes("用户名")) errors.username = message;
      else if (message.includes("邮箱")) errors.email = message;
      else errors.form = message;
    } else if (isAppError(err)) {
      errors.form = stripCodePrefix(err.message);
    } else {
      return serverError(c, err);
    }
    return render(c, 422, "注册", "", { values, errors, disabled: false }, registerView);
  }
});

// ---------------------------------------------------------------------------
// 找回密码
// ---------------------------------------------------------------------------

authRoutes.get("/forgot-password", async (c) => {
  return render(c, 200, "找回密码", "", step1Data({}, {}), forgotView);
});

authRoutes.post("/forgot-password", async (c) => {
  const cfg = c.get("cfg");
  const store = c.get("store");
  const logger = c.get("logger");

  const identifier = await formValue(c, "identifier");
  const values: Record<string, string> = { identifier };

  if (identifier === "") {
    return render(c, 422, "找回密码", "", step1Data(values, { identifier: "请输入用户名或邮箱" }), forgotView);
  }

  const ip = clientIp(c.req.raw);
  const since = new Date(Date.now() - cfg.lockoutWindowMs).toISOString();

  // 对同一标识的失败尝试做限制，避免被用来批量探测账号。
  if (await recoveryIdentifierLocked(c, identifier, ip, since)) {
    // 只留痕、不计入失败次数，否则锁定会被持续刷新而永不过期。
    await store.recordBlockedRecoveryAttempt(0, identifier, ip).catch(() => undefined);
    return render(
      c,
      429,
      "找回密码",
      "",
      step1Data(values, {
        form: `尝试次数过多，请 ${Math.floor(cfg.lockoutWindowMs / 60_000)} 分钟后再试`,
      }),
      forgotView,
    );
  }

  const user = await store.getUserByIdentifier(identifier);

  if (!user || user.status !== "active") {
    await store.recordRecoveryAttempt(0, identifier, ip, false).catch(() => undefined);
    return render(
      c,
      404,
      "找回密码",
      "",
      step1Data(values, { identifier: "账号不存在或已被禁用，请联系管理员协助处理" }),
      forgotView,
    );
  }

  const questions = await store.getSecurityQuestionTexts(user.id);
  if (questions.length < SECURITY_QUESTION_COUNT) {
    return render(
      c,
      409,
      "找回密码",
      "",
      step1Data(values, {
        identifier: "该账号尚未设置安全问题，无法自助找回密码，请联系管理员重置",
      }),
      forgotView,
    );
  }

  return render(c, 200, "找回密码", "", step2Data(identifier, user.username, questions, {}), forgotView);
});

authRoutes.post("/forgot-password/reset", async (c) => {
  const cfg = c.get("cfg");
  const store = c.get("store");
  const logger = c.get("logger");

  const identifier = await formValue(c, "identifier");
  const password = await formRaw(c, "password");
  const confirm = await formRaw(c, "password_confirm");

  if (identifier === "") {
    return render(
      c,
      400,
      "找回密码",
      "",
      step1Data({}, { form: "会话信息已失效，请重新开始找回流程" }),
      forgotView,
    );
  }

  const ip = clientIp(c.req.raw);
  const user = await store.getUserByIdentifier(identifier);
  if (!user || user.status !== "active") {
    return render(
      c,
      400,
      "找回密码",
      "",
      step1Data({ identifier }, { form: "账号状态已变化，请重新开始找回流程" }),
      forgotView,
    );
  }

  const questions = await store.getSecurityQuestionTexts(user.id);
  if (questions.length < SECURITY_QUESTION_COUNT) {
    return render(
      c,
      409,
      "找回密码",
      "",
      step1Data({ identifier }, { form: "该账号尚未设置安全问题，请联系管理员重置密码" }),
      forgotView,
    );
  }

  const answers: string[] = [];
  for (let i = 1; i <= questions.length; i++) {
    answers.push(await formValue(c, `answer_${i}`));
  }

  // 表单字段校验（先于答案校验，避免无意义的哈希计算）
  const errors: Record<string, string> = {};
  const pwError = validatePassword(password);
  if (pwError) errors.password = pwError;
  if (password !== confirm) errors.password_confirm = "两次输入的密码不一致";
  for (let i = 0; i < answers.length; i++) {
    if (answers[i].trim() === "") errors[`answer_${i + 1}`] = "请填写答案";
  }

  const since = new Date(Date.now() - cfg.lockoutWindowMs).toISOString();

  // 答题失败次数限制。同样以「账号 + 来源 IP」为主力维度：
  // 只按账号计数的话，攻击者乱填几个答案就能把受害者锁在自助找回之外。
  if (await recoveryAnswerLocked(c, user.id, ip, since)) {
    await store.recordBlockedRecoveryAttempt(user.id, identifier, ip).catch(() => undefined);
    errors.form = `答案错误次数过多，请 ${Math.floor(cfg.lockoutWindowMs / 60_000)} 分钟后再试`;
    return render(
      c,
      429,
      "找回密码",
      "",
      step2Data(identifier, user.username, questions, errors),
      forgotView,
    );
  }

  if (Object.keys(errors).length > 0) {
    return render(
      c,
      422,
      "找回密码",
      "",
      step2Data(identifier, user.username, questions, errors),
      forgotView,
    );
  }

  let ok: boolean;
  try {
    ok = await store.verifySecurityAnswers(user.id, answers);
  } catch (err) {
    if (isErrorCode(err, "securityQuestionsNotSet")) {
      return render(
        c,
        409,
        "找回密码",
        "",
        step1Data({ identifier }, { form: "该账号尚未设置安全问题，请联系管理员重置密码" }),
        forgotView,
      );
    }
    return serverError(c, err);
  }

  if (!ok) {
    await store.recordRecoveryAttempt(user.id, identifier, ip, false).catch(() => undefined);

    // 剩余次数取两个维度中更小的那个 —— 实际拦住用户的是先触发的那个，
    // 只按其中一个算会给出偏乐观的数字。
    let remaining = cfg.maxLoginAttempts;
    const n = await store.countFailedRecoveryByUserAndIp(user.id, ip, since);
    remaining = cfg.maxLoginAttempts - n;
    const total = await store.countFailedRecovery(user.id, since);
    const r = cfg.maxLoginAttempts * IDENTIFIER_LOCKOUT_MULTIPLIER - total;
    if (r < remaining) remaining = r;
    if (remaining < 0) remaining = 0;

    logger.warn("安全问题答案错误", { 用户: user.username, IP: ip, 剩余次数: remaining });
    return render(
      c,
      401,
      "找回密码",
      "",
      step2Data(identifier, user.username, questions, {
        form: `安全问题答案不正确，还可尝试 ${remaining} 次`,
      }),
      forgotView,
    );
  }

  await store.setPassword(user.id, password);
  await store.recordRecoveryAttempt(user.id, identifier, ip, true).catch(() => undefined);
  await store.clearFailedRecovery(user.id).catch(() => undefined);

  // 密码已变更，强制所有设备重新登录
  await store.deleteSessionsByUser(user.id).catch(() => undefined);

  logger.info("用户通过安全问题重置了密码", { 用户: user.username, IP: ip });
  return redirectWith(c, "/login", "success", "密码已重置，请使用新密码登录");
});

// ---------------------------------------------------------------------------
// 限流
// ---------------------------------------------------------------------------

/**
 * 「不限来源、仅按标识」这一兜底维度的阈值倍数。
 *
 * 单看某个标识的失败总数就锁定，是最容易被滥用的一种实现：攻击者无需任何
 * 凭据，只要知道受害者的用户名，每 15 分钟发 5 次错误密码就能让对方永远
 * 登不进来。因此这里把它降级为**兜底**，阈值放大到主力维度的 10 倍，
 * 专门用来对付「大量 IP 各试几次」的分布式爆破 —— 那种攻击下单个 IP
 * 的计数永远达不到阈值，只有跨来源的总数才会触发。
 */
const IDENTIFIER_LOCKOUT_MULTIPLIER = 10;

/**
 * 判断当前登录请求是否应当被限流。
 *
 * 采用两个维度叠加，各自解决不同的问题：
 *
 *   维度一（标识 + 来源 IP，阈值 maxLoginAttempts）
 *     主力防线。把限流收敛到具体攻击来源：单个 IP 打满额度只会锁住它自己，
 *     从别处正常登录的账号主人不受影响 —— 这正是「定向锁死他人账号」的解法。
 *
 *   维度二（仅标识，阈值 maxLoginAttempts × 10）
 *     兜底防线。用于对抗分布式爆破：攻击者换 IP 可以绕开维度一，
 *     但所有来源的失败会累加到同一个标识上，最终仍会被拦住。
 */
async function loginLocked(
  c: Context<AppEnv>,
  identifier: string,
  ip: string,
  since: string,
): Promise<boolean> {
  const cfg = c.get("cfg");
  const store = c.get("store");
  const n = await store.countFailedAttemptsByIdentifierAndIp(identifier, ip, since);
  if (n >= cfg.maxLoginAttempts) return true;
  const total = await store.countFailedAttempts(identifier, since);
  return total >= cfg.maxLoginAttempts * IDENTIFIER_LOCKOUT_MULTIPLIER;
}

/** 判断「找回密码第一步（按标识查询）」是否应限流。维度与登录一致。 */
async function recoveryIdentifierLocked(
  c: Context<AppEnv>,
  identifier: string,
  ip: string,
  since: string,
): Promise<boolean> {
  const cfg = c.get("cfg");
  const store = c.get("store");
  const n = await store.countFailedRecoveryByIdentifierAndIp(identifier, ip, since);
  if (n >= cfg.maxLoginAttempts) return true;
  const total = await store.countFailedRecoveryByIdentifier(identifier, since);
  return total >= cfg.maxLoginAttempts * IDENTIFIER_LOCKOUT_MULTIPLIER;
}

/** 判断「找回密码第二步（校验安全问题答案）」是否应限流。 */
async function recoveryAnswerLocked(
  c: Context<AppEnv>,
  userId: number,
  ip: string,
  since: string,
): Promise<boolean> {
  const cfg = c.get("cfg");
  const store = c.get("store");
  const n = await store.countFailedRecoveryByUserAndIp(userId, ip, since);
  if (n >= cfg.maxLoginAttempts) return true;
  const total = await store.countFailedRecovery(userId, since);
  return total >= cfg.maxLoginAttempts * IDENTIFIER_LOCKOUT_MULTIPLIER;
}

// ---------------------------------------------------------------------------
// 数据装配
// ---------------------------------------------------------------------------

function emptyLoginData(next: string) {
  return { values: {} as Record<string, string>, errors: {} as Record<string, string>, next };
}

function step1Data(values: Record<string, string>, errors: Record<string, string>) {
  return {
    step: 1 as const,
    identifier: "",
    username: "",
    questions: [],
    values,
    errors,
  };
}

function step2Data(
  identifier: string,
  username: string,
  questions: string[],
  errors: Record<string, string>,
) {
  return {
    step: 2 as const,
    identifier,
    username,
    questions: questions.map((text, i) => ({
      no: i + 1,
      field: `answer_${i + 1}`,
      text,
      error: errors[`answer_${i + 1}`] ?? "",
      answer: "",
    })),
    values: {} as Record<string, string>,
    errors,
  };
}

/**
 * 把安全问题校验错误映射到具体字段，便于逐项标红。
 *
 * 服务层错误形如「参数不合法：第 2 个问题的答案至少需要 2 个字」。
 */
function securityErrors(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
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
