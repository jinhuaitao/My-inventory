// 运行期配置 —— 对应原 Go 版 internal/config/config.go。
//
// 配置来源：wrangler 的 vars（非敏感）+ secrets（敏感）。
// 变量名沿用原版的 INVENTORY_* 前缀，运维心智模型不变。

import { roleValid, type Role } from "./types";

/** Worker 绑定与变量。 */
export interface Env {
  /** D1 数据库绑定。 */
  DB: D1Database;
  /** 静态资源绑定（wrangler 的 assets.binding）。 */
  ASSETS?: Fetcher;
  /** R2 备份桶（可选）。未绑定时「数据维护」页只能直接下载备份。 */
  BACKUPS?: R2Bucket;

  INVENTORY_APP_NAME?: string;
  INVENTORY_VERSION?: string;
  INVENTORY_ENV?: string;
  INVENTORY_LOG_LEVEL?: string;
  INVENTORY_BASE_URL?: string;

  INVENTORY_SESSION_SECRET?: string;
  INVENTORY_SESSION_LIFETIME?: string;
  INVENTORY_REMEMBER_LIFETIME?: string;
  INVENTORY_MAX_LOGIN_ATTEMPTS?: string;
  INVENTORY_LOCKOUT_WINDOW?: string;

  INVENTORY_ALLOW_REGISTRATION?: string;
  INVENTORY_DEFAULT_ROLE?: string;
  INVENTORY_ADMIN_USERNAME?: string;
  INVENTORY_ADMIN_EMAIL?: string;
  INVENTORY_ADMIN_PASSWORD?: string;
  INVENTORY_SEED_DEMO_DATA?: string;

  INVENTORY_UPDATE_ENABLED?: string;
  INVENTORY_UPDATE_REPO?: string;
  INVENTORY_UPDATE_INTERVAL?: string;
  INVENTORY_UPDATE_TOKEN?: string;

  INVENTORY_BACKUP_KEEP?: string;
  /**
   * R2 对象键前缀（Workers 版新增）。
   *
   * 对应原 Go 版的 INVENTORY_BACKUP_DIR —— R2 是扁平命名空间、没有目录，
   * 但用键前缀能起到同样的隔离作用：同一个桶可以放多个环境 / 多个应用的备份。
   */
  INVENTORY_BACKUP_PREFIX?: string;
  /**
   * 部署钩子地址（Workers 版新增）。
   *
   * 原版「立即更新」会下载安装包、替换可执行文件再重启进程；Workers 上
   * Worker 不能替换自己的代码，等效做法是触发一次重新部署 ——
   * 填上 Cloudflare Workers Builds 的 Deploy Hook（或任意能触发部署的
   * Webhook）后，「立即更新」就能真正跑起来。留空则该按钮只给出部署指引。
   */
  INVENTORY_UPDATE_DEPLOY_HOOK?: string;
}

/** 配置错误。与原版一样，非法配置直接让服务不可用，而不是静默回落。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  appName: string;
  version: string;
  env: string;
  baseUrl: string;
  logLevel: string;

  sessionSecret: string;
  sessionLifetimeMs: number;
  rememberLifetimeMs: number;

  updateEnabled: boolean;
  updateRepo: string;
  updateIntervalMs: number;
  updateToken: string;
  /** 部署钩子地址；为空表示「立即更新」只能给出人工指引。 */
  updateDeployHook: string;

  seedAdminUsername: string;
  seedAdminEmail: string;
  seedAdminPassword: string;
  seedDemoData: boolean;

  maxLoginAttempts: number;
  lockoutWindowMs: number;

  allowRegistration: boolean;
  defaultRole: Role;

  backupKeep: number;
  backupPrefix: string;
}

/** 生产模式判定。 */
export function isProduction(cfg: Config): boolean {
  return cfg.env.toLowerCase() === "production";
}

/** 站点是否以 HTTPS 对外服务（决定 cookie 的 Secure 属性与 HSTS）。 */
export function isHttps(cfg: Config): boolean {
  return cfg.baseUrl.startsWith("https://");
}

// ---------------------------------------------------------------------------
// 环境变量读取
// ---------------------------------------------------------------------------

function str(env: Env, key: keyof Env, fallback: string): string {
  const v = env[key];
  return typeof v === "string" && v !== "" ? v : fallback;
}

/** 读取布尔值；显式设置但无法解析时报错（不静默回落）。 */
function bool(env: Env, key: keyof Env, fallback: boolean): boolean {
  const v = env[key];
  if (typeof v !== "string" || v === "") return fallback;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  throw new ConfigError(`${String(key)} 需要 true/false，当前取值 ${JSON.stringify(v)}`);
}

/** 读取整数；显式设置但无法解析时报错。 */
function int(env: Env, key: keyof Env, fallback: number): number {
  const v = env[key];
  if (typeof v !== "string" || v === "") return fallback;
  const n = Number(v.trim());
  if (!Number.isInteger(n)) {
    throw new ConfigError(`${String(key)} 需要整数，当前取值 ${JSON.stringify(v)}`);
  }
  return n;
}

/**
 * 解析时长。支持 Go 的 time.ParseDuration 语法（如 12h、15m、90m、1h30m），
 * 另外额外接受 d（天）以便书写 remember_lifetime。
 */
export function parseDuration(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  if (s === "0") return 0;

  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h|d)/g;
  let total = 0;
  let matched = 0;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(s)) !== null) {
    if (m.index !== lastIndex) return null; // 出现无法解析的片段
    const value = Number(m[1]);
    const unit = m[2];
    const factor: Record<string, number> = {
      ns: 1e-6,
      us: 1e-3,
      "µs": 1e-3,
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    total += value * factor[unit];
    lastIndex = re.lastIndex;
    matched++;
  }
  if (matched === 0 || lastIndex !== s.length) return null;
  return Math.round(total);
}

function duration(env: Env, key: keyof Env, fallbackMs: number): number {
  const v = env[key];
  if (typeof v !== "string" || v === "") return fallbackMs;
  const ms = parseDuration(v);
  if (ms === null) {
    throw new ConfigError(`${String(key)} 需要时长（如 90m、24h、30d），当前取值 ${JSON.stringify(v)}`);
  }
  return ms;
}

// ---------------------------------------------------------------------------
// 加载与校验
// ---------------------------------------------------------------------------

const DEFAULT_BACKUP_KEEP = 14;

/**
 * 从绑定中读取配置并做合法性校验。
 *
 * 对显式设置但无法解析的取值直接报错而不是静默回落默认值：静默回落会让运维
 * 以为配置生效了，实际跑的却是另一套值 —— 在安全参数（锁定阈值、会话时长）
 * 上这类偏差尤其致命。
 */
export function loadConfig(env: Env): Config {
  const sessionLifetimeMs = duration(env, "INVENTORY_SESSION_LIFETIME", 12 * 3600_000);
  const rememberLifetimeMs = duration(env, "INVENTORY_REMEMBER_LIFETIME", 720 * 3600_000);
  const lockoutWindowMs = duration(env, "INVENTORY_LOCKOUT_WINDOW", 15 * 60_000);
  const updateIntervalMs = duration(env, "INVENTORY_UPDATE_INTERVAL", 6 * 3600_000);

  const defaultRoleRaw = str(env, "INVENTORY_DEFAULT_ROLE", "viewer").trim().toLowerCase();
  if (defaultRoleRaw === "admin") {
    // 开放注册 + 默认管理员 = 任何人自助拿到最高权限。宁可拒绝启动也不要静默放行。
    throw new ConfigError(
      "INVENTORY_DEFAULT_ROLE 不能是 admin：自助注册者会直接获得管理员权限。" +
        "请改为 viewer / manager，或关闭自助注册（INVENTORY_ALLOW_REGISTRATION=false）",
    );
  }
  if (!roleValid(defaultRoleRaw)) {
    throw new ConfigError(`INVENTORY_DEFAULT_ROLE 取值不合法：${JSON.stringify(defaultRoleRaw)}（可选 viewer / manager）`);
  }

  const maxLoginAttempts = int(env, "INVENTORY_MAX_LOGIN_ATTEMPTS", 5);
  if (maxLoginAttempts < 1) {
    throw new ConfigError(
      `INVENTORY_MAX_LOGIN_ATTEMPTS 至少为 1（当前 ${maxLoginAttempts}；0 或负数会锁死全部登录）`,
    );
  }
  if (lockoutWindowMs <= 0) {
    throw new ConfigError("INVENTORY_LOCKOUT_WINDOW 必须为正时长");
  }
  if (sessionLifetimeMs <= 0) {
    throw new ConfigError("INVENTORY_SESSION_LIFETIME 必须为正时长");
  }
  if (rememberLifetimeMs < sessionLifetimeMs) {
    throw new ConfigError(
      `INVENTORY_REMEMBER_LIFETIME（${rememberLifetimeMs}ms）不应短于 INVENTORY_SESSION_LIFETIME（${sessionLifetimeMs}ms）`,
    );
  }
  if (updateIntervalMs <= 0) {
    throw new ConfigError("INVENTORY_UPDATE_INTERVAL 必须为正时长");
  }

  const backupKeep = int(env, "INVENTORY_BACKUP_KEEP", DEFAULT_BACKUP_KEEP);
  if (backupKeep < 0) {
    throw new ConfigError(`INVENTORY_BACKUP_KEEP 不能为负数（当前 ${backupKeep}）`);
  }

  const envName = str(env, "INVENTORY_ENV", "development");
  // 与原版一致：默认 http://localhost:8080。真正部署时必须改成 Worker 的
  // 对外地址，否则 isHttps 为假，Secure cookie 与 HSTS 都不会启用。
  const baseUrl = str(env, "INVENTORY_BASE_URL", "http://localhost:8080").replace(/\/+$/, "");

  let sessionSecret = str(env, "INVENTORY_SESSION_SECRET", "");
  if (sessionSecret === "") {
    if (envName.toLowerCase() === "production") {
      throw new ConfigError(
        "生产环境必须设置 INVENTORY_SESSION_SECRET（至少 32 个字符的随机字符串）。" +
          "可用 `wrangler secret put INVENTORY_SESSION_SECRET` 写入。",
      );
    }
    sessionSecret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  }
  if (sessionSecret.length < 16) {
    throw new ConfigError("INVENTORY_SESSION_SECRET 太短，请使用至少 16 个字符的随机字符串");
  }

  const seedAdminPassword = str(env, "INVENTORY_ADMIN_PASSWORD", "") || "Admin@12345";

  // 演示数据默认跟随环境：生产环境不写入，开发 / 测试环境写入便于试用。
  // 与原版一致 —— 「没配置」和「配了 false」是两回事，但这里的默认值
  // 必须由环境推导，否则本地跑起来一片空白，第一次体验会很困惑。
  const seedDemoData = bool(env, "INVENTORY_SEED_DEMO_DATA", envName.toLowerCase() !== "production");

  return {
    appName: str(env, "INVENTORY_APP_NAME", "库存管理系统"),
    version: str(env, "INVENTORY_VERSION", "1.0.0"),
    env: envName,
    baseUrl,
    logLevel: str(env, "INVENTORY_LOG_LEVEL", "info"),

    sessionSecret,
    sessionLifetimeMs,
    rememberLifetimeMs,

    updateEnabled: bool(env, "INVENTORY_UPDATE_ENABLED", true),
    updateRepo: str(env, "INVENTORY_UPDATE_REPO", "").trim(),
    updateIntervalMs,
    updateToken: str(env, "INVENTORY_UPDATE_TOKEN", ""),
    updateDeployHook: str(env, "INVENTORY_UPDATE_DEPLOY_HOOK", "").trim(),

    seedAdminUsername: str(env, "INVENTORY_ADMIN_USERNAME", "admin"),
    seedAdminEmail: str(env, "INVENTORY_ADMIN_EMAIL", "admin@example.com"),
    seedAdminPassword,
    seedDemoData,

    maxLoginAttempts,
    lockoutWindowMs,

    allowRegistration: bool(env, "INVENTORY_ALLOW_REGISTRATION", true),
    defaultRole: defaultRoleRaw as Role,

    backupKeep,
    backupPrefix: normalizeKeyPrefix(str(env, "INVENTORY_BACKUP_PREFIX", "backups/")),
  };
}

/**
 * 规范化 R2 键前缀：去掉开头的 `/`，保证以 `/` 结尾（空串表示直接放在桶根下）。
 *
 * 前缀是要拼进对象键的，写法不一致会让「列表」和「写入」落到不同位置 ——
 * 表现是刚备份完却看不到任何备份。这里统一在配置入口收敛掉。
 */
function normalizeKeyPrefix(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+/, "");
  if (trimmed === "") return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** 在线更新功能是否可用（仓库已配置）。 */
export function updateConfigured(cfg: Config): boolean {
  return cfg.updateEnabled && cfg.updateRepo.includes("/");
}
