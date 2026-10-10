// 首次运行初始化 —— 对应原 Go 版 main.go 启动时调用的 database.Seed。
//
// Workers 没有「进程启动」这个时机（实例随时创建、随时回收），因此改成
// **首次请求时惰性初始化**，并用模块级 Promise 保证同一个 isolate 内只跑一次。
//
// 与原版一致的语义：
//   * 先确保表结构存在（对应原版启动时的 database.Migrate，见 db/schema.ts）；
//   * 只有在 users 表为空时才创建默认管理员；
//   * 只有在 products 表为空、且开启了 INVENTORY_SEED_DEMO_DATA 时才写演示数据；
//   * 两个判断都由数据库侧的守卫保证并发安全（见 db/seed.ts）。

import type { Store } from "./db";
// 直接从 schema 模块引入（而不是 db 的桶文件），避免任何潜在的循环依赖 ——
// 它只依赖 logger 的类型和打包进来的 .sql 文本。
import { ensureSchema } from "./db/schema";
import { DEFAULT_ADMIN_PASSWORD } from "./env";
import type { Config } from "./env";
import type { Logger } from "./lib/logger";

let seedPromise: Promise<void> | null = null;

/** 保证数据库已完成初始化；同一 isolate 内只真正执行一次。 */
export function ensureSeeded(store: Store, cfg: Config, logger: Logger): Promise<void> {
  if (!seedPromise) {
    seedPromise = runSeed(store, cfg, logger).catch((err) => {
      // 失败后允许下一次请求重试：数据库瞬时不可用不应该让这个实例
      // 永久停留在「未初始化」状态（否则管理员账号永远建不出来）。
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

async function runSeed(store: Store, cfg: Config, logger: Logger): Promise<void> {
  // 先保证表结构存在 —— 对应原版 main.go 启动时调用的 database.Migrate。
  // 空库（典型场景：部署流程漏跑了迁移）会自动建表，而不是让整个站点 500。
  // 已有结构时这一步只是一次 `SELECT 1 FROM users LIMIT 1`。
  await ensureSchema(store.db, logger);

  await store.seed({
    adminUsername: cfg.seedAdminUsername,
    adminEmail: cfg.seedAdminEmail,
    adminPassword: cfg.seedAdminPassword,
    withDemoData: cfg.seedDemoData,
  });

  if (cfg.seedDemoData) {
    await store.seedDemoData();
  }

  logDefaultAdminWarning(cfg, logger);

  logger.debug("数据库初始化检查完成");
}

/**
 * 默认管理员密码的风险提示 —— 对应原版 main.go 的启动日志。
 *
 * 原版在进程启动时打印一次；Workers 没有「进程启动」这个时机，改在每个
 * isolate 首次初始化时打印一次（同一 isolate 内 ensureSeeded 只跑一次，
 * 因此不会刷屏）。
 *
 * 判据只看**配置值**，不看库里是否真的建过管理员：管理员可能早已在页面上
 * 改过密码，这个环境变量就不再被使用，但配置里留着弱口令本身仍是隐患 ——
 * 空库首次启动时，任何人用 admin + 默认密码就能直接拿到最高权限。
 */
function logDefaultAdminWarning(cfg: Config, logger: Logger): void {
  if (cfg.seedAdminPassword !== DEFAULT_ADMIN_PASSWORD) return;

  if (cfg.env.toLowerCase() === "production") {
    logger.warn("生产环境仍在使用内置的默认管理员密码，请尽快处理", {
      用户名: cfg.seedAdminUsername,
      处置: "登录后立即修改密码；并通过 INVENTORY_ADMIN_PASSWORD 指定强密码后重新部署",
    });
  } else {
    logger.info("默认管理员账号已就绪", {
      用户名: cfg.seedAdminUsername,
      密码: cfg.seedAdminPassword,
      提醒: "生产环境请通过 INVENTORY_ADMIN_PASSWORD 覆盖，并登录后立即修改",
    });
  }
}
