// 系统更新路由 —— 对应原 Go 版 internal/handlers/update.go + internal/updater。
//
// 能照搬的都照搬了：版本检查（GitHub Releases）、语义化版本比较、发布说明截断、
// 错误文案、甚至 restartCountdown 那个「倒计时必须显著大于切换延迟」的坑。
//
// 搬不过来的只有「应用更新」这一步：Go 版会下载安装包、校验 SHA-256、
// 原子替换可执行文件再重启进程；Worker 不能替换自己的代码。
// 因此 apply 改成触发一次**重新部署**（INVENTORY_UPDATE_DEPLOY_HOOK），
// 随后用一个等待页盯着版本号变化 —— 判据从「/readyz 能通」换成
// 「/healthz 报的版本已是新版本」，理由见下面 DEPLOY_SETTLE_SECONDS 的注释。

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { isNewer, parseVersion } from "../lib/semver";
import { nowUtcIso } from "../lib/time";
import { updateConfigured } from "../env";
import { roleCanManageUsers } from "../types";
import { emptyStatus, updateApplyingView, updateView, type UpdateStatus } from "../views/update";
import { redirectWith, render, serverError } from "./helpers";

export const updateRoutes = new Hono<AppEnv>();

/** updatePath 是系统更新页地址。 */
const updatePath = "/admin/update";

/** 单次版本检查的超时时间（原版同样是 20 秒）。 */
const CHECK_TIMEOUT_MS = 20_000;

/** Release 说明的最大长度，避免超长文本拖垮页面。 */
const MAX_RELEASE_BODY_LEN = 8000;

/**
 * 触发部署后，页面开始探测新版本之前的等待秒数。
 *
 * ⚠️ 与 Go 版的 restartCountdown 是同一个道理，只是对象变了。
 * 原版要等的是「进程退出」，这里要等的是「新版本上线」；而在新版本上线之前，
 * **旧版本一直在正常服务** —— 此刻探测 /healthz 会立刻成功，页面「刷新成功」
 * 但看到的还是旧版本。倒计时就是用来躲开这段窗口的。
 *
 * 之所以不能像原版那样精确算出来：部署耗时取决于构建与全球传播，无法预估，
 * 45 秒是留足余量的经验值。真正的判据是带 expect 参数的 /healthz ——
 * 版本没换过来之前它一直返回 503，所以即使 45 秒不够，页面也只是继续等，
 * 不会误判成功。
 */
const DEPLOY_SETTLE_SECONDS = 45;

/** 「更新状态」在 settings 表中的键名。 */
const SETTING_UPDATE_STATUS = "update_status";

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

function requireAdmin(c: Context<AppEnv>): Response | null {
  const user = c.get("user");
  if (!user) return redirectWith(c, "/login", "", "");
  if (!roleCanManageUsers(user.role)) {
    return redirectWith(c, "/", "error", "只有管理员可以访问系统更新");
  }
  return null;
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

updateRoutes.get("/admin/update", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  return renderUpdate(c, 200, {});
});

/**
 * 渲染更新页面。
 *
 * 状态优先取缓存：Workers 的 isolate 随时可能被回收，原版那个内存里的
 * 「上次检查结果」在这里留不住，因此把它落到 settings 表 ——
 * 效果与原版一致（进页面就能看到上次的检查结论），而且多实例之间也共享。
 */
async function renderUpdate(
  c: Context<AppEnv>,
  status: 200 | 500,
  errors: Record<string, string>,
): Promise<Response> {
  const cfg = c.get("cfg");
  const status_ = await loadStatus(c);

  return render(
    c,
    status,
    "系统更新",
    "update",
    {
      status: status_,
      enabled: updateConfigured(cfg),
      repo: cfg.updateRepo,
      platform: "cloudflare-workers",
      currentBuild: cfg.version,
      deployHookConfigured: cfg.updateDeployHook !== "",
      errors,
    },
    updateView,
  );
}

/** 读取缓存的检查结果；不存在或已损坏时返回空状态。 */
async function loadStatus(c: Context<AppEnv>): Promise<UpdateStatus | null> {
  const cfg = c.get("cfg");
  const { value, found } = await c.get("store").getSetting(SETTING_UPDATE_STATUS);
  if (!found) return emptyStatus(cfg.version);

  try {
    const parsed = JSON.parse(value) as Partial<UpdateStatus>;
    return {
      ...emptyStatus(cfg.version),
      ...parsed,
      // 当前版本永远以运行时的配置为准：settings 表里存的是上一次检查时的值，
      // 部署过之后它就已经过期了，照搬会显示出错误的「当前版本」。
      current: cfg.version,
    };
  } catch {
    return emptyStatus(cfg.version);
  }
}

// ---------------------------------------------------------------------------
// 检查更新
// ---------------------------------------------------------------------------

updateRoutes.post("/admin/update/check", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const status = await checkUpdate(c);

  if (status.err !== "") {
    c.get("logger").warn("手动检查更新未成功", { 原因: status.err });
    return redirectWith(c, updatePath, "warning", status.err);
  }
  if (status.updateAvailable) {
    return redirectWith(c, updatePath, "info", `发现新版本 ${status.latest}，可查看下方说明后立即更新`);
  }
  return redirectWith(c, updatePath, "success", `当前已是最新版本（${status.current}）`);
});

/**
 * 执行一次版本检查，结果同时写入 settings 供页面读取。
 *
 * 对应 Go 版 updater.Service.Check。
 */
async function checkUpdate(c: Context<AppEnv>): Promise<UpdateStatus> {
  const cfg = c.get("cfg");
  const logger = c.get("logger");
  const base = emptyStatus(cfg.version);
  base.checkedAt = nowUtcIso();

  if (!updateConfigured(cfg)) {
    base.err = "在线更新未启用或未配置更新仓库";
    await saveStatus(c, base);
    return base;
  }

  let release: GitHubRelease;
  try {
    release = await fetchLatestRelease(cfg.updateRepo, cfg.updateToken);
  } catch (err) {
    base.err = err instanceof Error ? err.message : String(err);
    logger.warn("检查更新失败", { 仓库: cfg.updateRepo, 错误: base.err });
    await saveStatus(c, base);
    return base;
  }

  base.latest = release.tag_name;
  base.releaseUrl = release.html_url;
  base.notes = truncateNotes(release.body);
  if (release.published_at) {
    const ts = Date.parse(release.published_at);
    if (Number.isFinite(ts)) base.publishedAt = new Date(ts).toISOString();
  }

  const problems: string[] = [];
  if (parseVersion(cfg.version)) {
    base.comparable = true;
    base.updateAvailable = isNewer(cfg.version, release.tag_name);
  } else {
    base.comparable = false;
    problems.push("当前为开发构建，无法比较版本号");
  }

  base.err = problems.join("；");
  await saveStatus(c, base);
  return base;
}

/** GitHub Releases API 返回的字段（只保留用得到的）。 */
interface GitHubRelease {
  tag_name: string;
  name?: string;
  body?: string;
  html_url: string;
  published_at?: string;
}

/**
 * 拉取最新发布。
 *
 * 错误文案按状态码分类，而不是统一抛「请求失败」—— 运维看到 404 与 403
 * 该做的事完全不同（前者是仓库名写错，后者多半是配额用尽要配 Token）。
 */
async function fetchLatestRelease(repo: string, token: string): Promise<GitHubRelease> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    // GitHub 要求请求必须带 User-Agent，否则一律 403。
    "User-Agent": "inventory-workers",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token !== "") headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`访问 GitHub 超时（超过 ${CHECK_TIMEOUT_MS / 1000} 秒）`);
    }
    throw new Error("无法访问 GitHub：网络不通或被出口策略拦截");
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`仓库 ${repo} 不存在，或没有发布过 Release`);
    }
    if (res.status === 403 || res.status === 429) {
      throw new Error("GitHub API 访问受限（多为匿名配额用尽），可配置 INVENTORY_UPDATE_TOKEN 提高配额");
    }
    throw new Error(`GitHub API 返回 ${res.status}`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error("GitHub 返回的内容无法解析");
  }
  if (typeof data !== "object" || data === null || typeof (data as GitHubRelease).tag_name !== "string") {
    throw new Error("GitHub 返回的内容缺少版本号");
  }
  return data as GitHubRelease;
}

/** 截断发布说明。 */
function truncateNotes(body: string | undefined): string {
  const s = (body ?? "").trim();
  if (s.length <= MAX_RELEASE_BODY_LEN) return s;
  return `${s.slice(0, MAX_RELEASE_BODY_LEN)}\n……（说明过长已截断）`;
}

/** 把检查结果写入 settings。写失败只记日志，不影响本次响应。 */
async function saveStatus(c: Context<AppEnv>, status: UpdateStatus): Promise<void> {
  try {
    await c.get("store").setSetting(SETTING_UPDATE_STATUS, JSON.stringify(status));
  } catch (err) {
    c.get("logger").warn("保存更新检查结果失败", {
      错误: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// 应用更新
// ---------------------------------------------------------------------------

updateRoutes.post("/admin/update/apply", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const cfg = c.get("cfg");
  const logger = c.get("logger");

  const status = await loadStatus(c);
  if (!status || !status.updateAvailable) {
    return redirectWith(c, updatePath, "warning", "当前没有可用的更新，请先检查更新");
  }

  if (cfg.updateDeployHook === "") {
    // 与原版 Windows 分支的处理一致：给出手动操作指引，而不是假装更新成功。
    return redirectWith(
      c,
      updatePath,
      "warning",
      "未配置部署钩子（INVENTORY_UPDATE_DEPLOY_HOOK），无法一键更新。" +
        "请在本机执行 npx wrangler deploy 完成部署；" +
        "也可以配置部署钩子后由本页直接触发。",
    );
  }

  try {
    const res = await fetch(cfg.updateDeployHook, {
      method: "POST",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`部署钩子返回 ${res.status}`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("触发部署失败", { 从: status.current, 到: status.latest, 错误: detail });
    return renderUpdate(c, 500, { form: `触发部署失败：${detail}` });
  }

  logger.warn("已触发重新部署", { 从: status.current, 到: status.latest });

  // 把 expect 带上：新版本没上线之前 /healthz 一直返回 503，等待页因此
  // 不会被「旧版本还在正常服务」骗过去。
  return render(
    c,
    200,
    "正在部署",
    "update",
    {
      from: status.current,
      to: status.latest,
      countdown: DEPLOY_SETTLE_SECONDS,
      probe: `/healthz?expect=${encodeURIComponent(status.latest)}`,
      refresh: updatePath,
    },
    updateApplyingView,
  );
});
