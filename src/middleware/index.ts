// HTTP 中间件 —— 对应原 Go 版 internal/middleware/middleware.go。
//
// 执行顺序（与原版一致）：
//   recoverer → provide → accessLogger → securityHeaders → authenticate → csrf
//
// provide 被提前到 Logger 之前，因为安全响应头需要读取配置（是否生产环境、
// 是否 HTTPS），而原版是通过构造函数把 cfg 注进 Manager 的。

import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { ensureSeeded } from "../bootstrap";
import {
  CSRF_COOKIE_NAME,
  MAX_UPLOAD_BYTES,
  SessionManager,
  providedCsrfToken,
  writeCsrfCookie,
} from "../auth/session";
import type { AppEnv } from "../context";
import { Store } from "../db";
import { loadConfig, isHttps, isProduction, ConfigError } from "../env";
import { secureCompare, randomToken } from "../lib/crypto";
import { getCookie } from "hono/cookie";
import { isFormRequest, isMultipartForm, readForm } from "../lib/form";
import { newLogger } from "../lib/logger";
import { clientIp, requestUri, wantsJson } from "../lib/request";
import { roleCanWrite, type Role } from "../types";

// ---------------------------------------------------------------------------
// 基础中间件
// ---------------------------------------------------------------------------

/**
 * 注入配置、日志器与数据访问层。
 *
 * 配置非法时直接返回可读的错误页而不是 500 堆栈：这类问题必须让运维
 * 一眼看出是哪一项配错了（原版同样是「配置错误 = 服务不可用」）。
 */
export const provide = createMiddleware<AppEnv>(async (c, next) => {
  let cfg;
  try {
    cfg = loadConfig(c.env);
  } catch (err) {
    const detail = err instanceof ConfigError ? err.message : "配置解析失败";
    return c.text(`服务配置错误，无法启动：${detail}`, 500);
  }

  const logger = newLogger(cfg);

  // D1 未绑定是最容易犯的配置错误（例如 wrangler.jsonc 的 d1_databases 段
  // 被注释掉了）。单独判一次，否则后面会抛出难以定位的 TypeError。
  if (!c.env.DB) {
    logger.error("D1 绑定缺失", { 绑定: "DB" });
    return c.text(
      "服务配置错误，无法启动：没有绑定 D1 数据库（环境变量 DB）。\n" +
        "请检查 wrangler.jsonc 的 d1_databases 段，然后重新部署。",
      500,
    );
  }

  const store = new Store(c.env.DB, logger);
  c.set("cfg", cfg);
  c.set("logger", logger);
  c.set("store", store);

  // 惰性初始化（默认管理员 / 演示数据）。同一个 isolate 内只会真正执行一次，
  // 之后的请求只是一次已 resolve 的 Promise。
  try {
    await ensureSeeded(store, cfg, logger);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("数据库初始化失败", { 错误: detail });
    return c.text(initFailureMessage(detail), 500);
  }

  await next();
});

/**
 * 初始化失败时给运维看的提示。
 *
 * 「表不存在」是部署阶段最常见的失败：D1 绑定配好了、库也建出来了，但迁移
 * 没跑（默认的 `wrangler deploy` **不含**迁移），于是库里一张表都没有。
 * 这种情况必须把「具体怎么办」直接写在响应里 —— 否则页面上只有一句笼统的
 * 「请检查 D1 绑定与迁移」，真正的原因（`no such table: users`）只躺在日志里，
 * 排查要绕一大圈。
 *
 * 其余错误仍然保持笼统：连接失败、权限不足之类的异常信息可能带出内部细节，
 * 不值得直接暴露给访问者。
 */
function initFailureMessage(detail: string): string {
  if (/no such table/i.test(detail)) {
    return (
      "数据库尚未初始化：D1 里没有任何表，说明迁移没有执行。\n\n" +
      "在项目目录执行一次迁移即可：\n" +
      "  npx wrangler d1 migrations apply inventory --remote\n\n" +
      "想让每次部署都自动跑迁移，把 Workers Builds 的 Deploy command 改成 `npm run deploy:ci`。"
    );
  }
  return "数据库初始化失败，请检查 D1 绑定与迁移是否已执行";
}

/** 捕获未处理的异常，记录日志并返回 500。 */
export const recoverer = createMiddleware<AppEnv>(async (c, next) => {
  try {
    await next();
  } catch (err) {
    const logger = c.get("logger");
    logger?.error("请求处理发生异常", {
      路径: c.req.path,
      方法: c.req.method,
      错误: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      堆栈: err instanceof Error ? err.stack : undefined,
    });
    if (wantsJson(c.req.raw)) {
      return c.json({ error: "服务器内部错误" }, 500);
    }
    return c.text("服务器内部错误，请稍后重试", 500);
  }
});

/** 访问日志（静态资源不记录，避免噪音）。 */
export const accessLogger = createMiddleware<AppEnv>(async (c, next) => {
  const path = c.req.path;
  if (path.startsWith("/static/")) {
    await next();
    return;
  }

  const start = Date.now();
  await next();

  c.get("logger")?.info("http", {
    方法: c.req.method,
    路径: path,
    状态: c.res.status,
    耗时: `${Date.now() - start}ms`,
    IP: clientIp(c.req.raw),
  });
});

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

/**
 * 安全响应头。
 *
 * 用 c.header() 在 next() **之前**写入：Hono 会把预备头合并进最终响应，
 * 因此即便是直接 return 的静态资源 Response（其 headers 可能是只读的）
 * 也能正确带上这些头。
 */
export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Content-Security-Policy", CSP);
  c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  const cfg = c.get("cfg");
  if (isProduction(cfg) && isHttps(cfg)) {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  await next();
});

// ---------------------------------------------------------------------------
// 会话与权限
// ---------------------------------------------------------------------------

/**
 * 该路径是否可以跳过会话加载。
 *
 * 静态资源与运维探针被排除在外，有两个理由：
 *
 *  1. 静态资源是浏览器同源请求，会自动带上会话 cookie。逐个文件去查
 *     sessions 表纯属浪费 —— 一个页面十几个资源就是十几次查询，
 *     而它们的响应内容与「你是谁」毫无关系。
 *
 *  2. /healthz 是**存活**探针，语义是「进程还能响应吗」。让它依赖数据库，
 *     数据库一抖动就会把本可自愈的故障放大成重启风暴。/readyz 仍然检查
 *     数据库 —— 那才是它该管的事，而且检查写在 handler 里，比中间件更贴近语义。
 */
function skipsSessionLoad(path: string): boolean {
  if (path.startsWith("/static/")) return true;
  return path === "/healthz" || path === "/readyz" || path === "/favicon.ico";
}

/**
 * 加载会话并把用户与 CSRF 令牌注入上下文。
 * 未登录同样放行，由后续的 requireAuth 决定是否拦截。
 */
export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  if (skipsSessionLoad(c.req.path)) {
    c.set("csrfToken", "");
    await next();
    return;
  }

  const cfg = c.get("cfg");
  const sessions = new SessionManager(c.get("store"), cfg);

  let found;
  try {
    found = await sessions.load(c);
  } catch (err) {
    c.get("logger")?.error("加载会话失败", {
      路径: c.req.path,
      错误: err instanceof Error ? err.message : String(err),
    });
    return c.text("服务器内部错误，请稍后重试", 500);
  }

  if (found) {
    const { session, user } = found;
    c.set("session", session);
    c.set("user", user);
    c.set("csrfToken", session.csrfToken);
    // 保持 cookie 与会话中的令牌同步
    if (getCookie(c, CSRF_COOKIE_NAME) !== session.csrfToken) {
      writeCsrfCookie(c, session.csrfToken, cfg);
    }
  } else {
    // 未登录：使用 double-submit cookie 方案保护登录 / 注册等表单
    const existing = getCookie(c, CSRF_COOKIE_NAME);
    if (existing) {
      c.set("csrfToken", existing);
    } else {
      const token = randomToken(32);
      c.set("csrfToken", token);
      writeCsrfCookie(c, token, cfg);
    }
  }

  await next();
});

/** 要求登录，未登录时跳转到登录页并带上回跳地址。 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) return unauthorized(c);
  await next();
});

/** 要求用户具备指定角色之一。 */
export function requireRole(...roles: Role[]) {
  const allowed = new Set<Role>(roles);
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    if (!user) return unauthorized(c);
    if (!allowed.has(user.role)) return forbidden(c);
    await next();
  });
}

/** 要求具备写权限（管理员或仓管员）。 */
export const requireWrite = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) return unauthorized(c);
  if (!roleCanWrite(user.role)) return forbidden(c);
  await next();
});

/** 已登录用户访问登录 / 注册页时直接跳转到首页。 */
export const redirectIfAuthenticated = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user")) return c.redirect("/", 303);
  await next();
});

function unauthorized(c: Context<AppEnv>) {
  if (wantsJson(c.req.raw)) {
    return c.json({ error: "请先登录" }, 401);
  }
  let target = "/login";
  if (c.req.method === "GET" && c.req.path !== "/") {
    target += "?next=" + encodeURIComponent(requestUri(c.req.raw));
  }
  return c.redirect(target, 303);
}

function forbidden(c: Context<AppEnv>) {
  if (wantsJson(c.req.raw)) {
    return c.json({ error: "没有权限执行该操作" }, 403);
  }
  return c.text("403 没有权限执行该操作", 403);
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * 校验所有非幂等请求携带的令牌。
 *
 * 已登录：与会话中保存的令牌比对（最强）。
 * 未登录：与 CSRF cookie 比对（double-submit）。
 */
export const csrf = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    await next();
    return;
  }

  const session = c.get("session");
  const expected = session ? session.csrfToken : c.get("csrfToken");

  if (!expected) {
    return csrfFail(c, "会话已失效，请刷新页面后重试");
  }

  // ⚠️ multipart 的处理必须赶在取令牌之前，而且**与令牌从哪来无关**。
  //
  // 早先的写法把这段塞在「令牌来自表单字段」的分支里，于是客户端只要
  // 改用 X-CSRF-Token 头提交令牌，就能整段绕过去：体积上限没了，
  // 「未登录不许上传」的检查也跟着失效 —— 防护变成了「看客户端心情」。
  // 这两件事保护的是请求解析本身，理应无条件执行。
  if (isMultipartForm(c.req.header("Content-Type"))) {
    // 本中间件跑在鉴权之后，而未登录的请求也可能带 multipart body。
    // 站内所有 multipart 接口都要求登录，因此这里直接拒绝。
    if (!session) {
      return csrfFail(c, "请先登录后再上传");
    }
    // 体积上限必须在解析之前判断，否则超大请求会先被完整读进内存。
    const len = Number(c.req.header("Content-Length") ?? "0");
    if (Number.isFinite(len) && len > MAX_UPLOAD_BYTES) {
      return csrfFail(c, "上传内容过大");
    }
  }

  const provided = await providedCsrfToken(c);
  if (!provided || !secureCompare(provided, expected)) {
    return csrfFail(c, "安全校验未通过，请刷新页面后重试");
  }

  await next();
});

function csrfFail(c: Context<AppEnv>, msg: string) {
  c.get("logger")?.warn("CSRF 校验失败", {
    路径: c.req.path,
    方法: c.req.method,
    IP: clientIp(c.req.raw),
  });
  if (wantsJson(c.req.raw)) {
    return c.json({ error: msg }, 403);
  }
  return c.text("403 " + msg, 403);
}

/** 供处理器读取已缓存的表单（导出便于统一调用点）。 */
export { readForm, isFormRequest };
