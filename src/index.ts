// Worker 入口 —— 对应原 Go 版 cmd/server/main.go + internal/handlers/routes.go。
//
// 路由表与中间件链顺序都照搬原版：
//   recoverer → provide → accessLogger → securityHeaders → authenticate → csrf
// 之后才是「需要登录」的业务路由（appRoutes 上挂 requireAuth，
// 对应 Go 版 root.Handle("/", h.mw.RequireAuth(app))）。

import { Hono } from "hono";
import {
  accessLogger,
  authenticate,
  csrf,
  provide,
  recoverer,
  requireAuth,
  securityHeaders,
} from "./middleware";
import type { AppEnv } from "./context";
import { loadConfig } from "./env";
import { Store } from "./db";
import { newLogger } from "./lib/logger";
import { assetVersion } from "./views/assets";
import { renderError } from "./views/render";

import { authRoutes } from "./routes/auth";
import { dashboardRoutes } from "./routes/dashboard";
import { profileRoutes } from "./routes/profile";
import { productRoutes } from "./routes/products";
import { catalogRoutes } from "./routes/catalog";
import { stockRoutes } from "./routes/stock";
import { reportRoutes } from "./routes/reports";
import { userRoutes } from "./routes/users";
import { maintenanceRoutes } from "./routes/maintenance";

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// 全局中间件
// ---------------------------------------------------------------------------

app.use("*", recoverer);
app.use("*", provide);
app.use("*", accessLogger);
app.use("*", securityHeaders);
app.use("*", authenticate);
app.use("*", csrf);

// ---------------------------------------------------------------------------
// 静态资源与运维探针
// ---------------------------------------------------------------------------

/**
 * 静态资源由 Workers Assets 提供（wrangler.jsonc 的 assets.directory）。
 *
 * 缓存策略写在 public/_headers 里：/static/* 长缓存 + immutable。
 * 由于模板给每个 URL 都带了 ?v=<内容指纹>，内容一变 URL 就变，
 * 长缓存不会导致「升级后仍跑旧代码」。
 */
app.get("/static/*", async (c) => {
  if (!c.env.ASSETS) return c.text("静态资源未配置（缺少 assets 绑定）", 500);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.get("/favicon.ico", async (c) => {
  // 带上内容指纹：静态资源是按长期缓存下发的，而这个 301 本身也会被
  // 浏览器永久缓存，不带指纹就等于把某个旧版本的图标钉死。
  const v = await assetVersion(c.env, c.get("cfg").version);
  return c.redirect(`/static/favicon.svg?v=${v}`, 301);
});

/**
 * 存活探针：进程能响应即视为存活（刻意不碰数据库）。
 *
 * 移植时曾加过一个 `?expect=<版本>` 用法，供「等待部署生效」页面轮询版本号 ——
 * 那个页面随「系统更新」功能一起删掉了，因此这里只保留最基本的返回。
 * 部署是否已生效改由平台侧判断（wrangler 会等版本就绪，Workers Builds 也有构建日志）。
 */
app.get("/healthz", (c) => {
  return c.json({ status: "ok", version: c.get("cfg").version });
});

/** 就绪探针：额外检查数据库连通性。 */
app.get("/readyz", async (c) => {
  try {
    await c.get("store").db.prepare("SELECT 1").first();
  } catch (err) {
    c.get("logger").error("数据库健康检查失败", {
      错误: err instanceof Error ? err.message : String(err),
    });
    return c.json({ status: "unavailable", error: "数据库连接异常" }, 503);
  }
  return c.json({ status: "ready" });
});

// ---------------------------------------------------------------------------
// 认证（无需登录）
// ---------------------------------------------------------------------------

app.route("/", authRoutes);

// ---------------------------------------------------------------------------
// 需要登录的业务路由
//
// 注册顺序对应 Go 版 registerAppRoutes；Hono 按注册顺序匹配，
// 因此各模块内部把 /xxx/new、/xxx/export 这类字面量路径排在 /xxx/:id 之前。
// ---------------------------------------------------------------------------

const appRoutes = new Hono<AppEnv>();

// 对应 Go 版 root.Handle("/", h.mw.RequireAuth(app))：业务路由一律要求登录。
appRoutes.use("*", requireAuth);

appRoutes.route("/", dashboardRoutes);
appRoutes.route("/", profileRoutes);
appRoutes.route("/", productRoutes);
appRoutes.route("/", catalogRoutes);
appRoutes.route("/", stockRoutes);
appRoutes.route("/", reportRoutes);
appRoutes.route("/", userRoutes);
appRoutes.route("/", maintenanceRoutes);

app.route("/", appRoutes);

/**
 * 兜底 404。
 *
 * 走到这里的一定是已登录用户：未登录的请求在 requireAuth 就被拦下并跳转登录页了。
 * 渲染失败（例如数据库不可用导致公共骨架取不到数据）时退回纯文本 ——
 * 一个 404 不该因为「顺便查了一下注册开关」而变成 500。
 */
app.notFound(async (c) => {
  try {
    return await renderError(c, 404, "页面不存在");
  } catch {
    return c.text("404 页面不存在", 404);
  }
});

// ---------------------------------------------------------------------------
// 定时任务：清理过期数据
// ---------------------------------------------------------------------------

/**
 * 对应原版 main.go 的 runCleanupLoop（每小时一次）。
 *
 * Workers 里用 Cron Triggers 代替常驻 goroutine —— 不需要一个进程 24 小时
 * 守着，也更省资源。cron 表达式写在 wrangler.jsonc 的 triggers.crons。
 */
async function runCleanup(env: AppEnv["Bindings"]): Promise<void> {
  const cfg = loadConfig(env);
  const logger = newLogger(cfg);
  const store = new Store(env.DB, logger);

  const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
  try {
    const sessions = await store.cleanupExpiredSessions();
    const attempts = await store.cleanupLoginAttempts(yesterday);
    const recoveries = await store.cleanupRecoveryAttempts(yesterday);
    if (sessions + attempts + recoveries > 0) {
      logger.info("清理过期数据完成", {
        会话: sessions,
        登录记录: attempts,
        找回密码记录: recoveries,
      });
    }
  } catch (err) {
    logger.warn("清理过期数据失败", {
      错误: err instanceof Error ? err.message : String(err),
    });
  }
}

export default {
  fetch: app.fetch,

  async scheduled(
    _event: ScheduledController,
    env: AppEnv["Bindings"],
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runCleanup(env));
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;

export { app };
