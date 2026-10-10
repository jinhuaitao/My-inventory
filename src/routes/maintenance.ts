// 数据维护路由 —— 对应原 Go 版 internal/handlers/maintenance.go。
//
// 三个流程都逐条对照原版移植，包括那些看起来「多余」的步骤：
//   * 备份完成后**立刻回读校验**，确认拿到的不是「看起来像备份」的空壳；
//   * 清理演示数据前先**预演一次**，没有可清理的数据就不产生备份文件；
//   * 清理 / 恢复之前先做**安全备份** —— 这两个操作都不可回滚。
//
// 与 Go 版的对应关系：
//   database.Backup              → store.exportSnapshot + putBackup
//   database.InspectBackup       → 回读快照并重新解析（校验可读且行数一致）
//   database.ListBackups         → listBackups（R2）
//   database.PruneBackups        → pruneBackups（R2）
//   database.StageRestore        → putPending（暂存）
//   database.ApplyPendingRestore → applySnapshot（站内直接生效，不需要重启）

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import {
  assertBackupName,
  deleteBackup,
  deletePending,
  getPendingText,
  getSnapshotText,
  getSqlObject,
  listBackups,
  newBackupName,
  pendingMeta,
  pruneBackups,
  putBackup,
  putPending,
  snapshotKey,
  type BackupEntry,
} from "../lib/backup";
import { contentDisposition } from "../lib/csv";
import { businessError, invalidInput } from "../lib/errors";
import { formFile, formTrimmed, readForm } from "../lib/form";
import { formatBytes } from "../lib/format";
import {
  parseSnapshot,
  purgeResultEmpty,
  snapshotRowTotal,
  snapshotToSql,
  type PurgeResult,
  type Snapshot,
} from "../db";
import { hasLegacyCandidates } from "../db/seed";
import { roleCanManageUsers } from "../types";
import { maintenanceView, type MaintenanceData, type PendingInfo } from "../views/maintenance";
import { redirectWith, render, serverError } from "./helpers";

export const maintenanceRoutes = new Hono<AppEnv>();

/** maintenancePath 是数据维护页地址，所有操作完成后回到这里。 */
const maintenancePath = "/admin/maintenance";

/**
 * 上传快照的体积上限。
 *
 * 原版直接沿用中间件里 multipart 的全局上限（512 MB），因为那边备份的是
 * 整个数据库文件。这里备份的是 JSON 快照，且 MAX_SNAPSHOT_ROWS 已经把
 * 行数卡在 2 万行，32 MB 足够容纳 —— 再放宽只会让一个畸形上传把 Worker 拖垮。
 */
const MAX_RESTORE_UPLOAD = 32 << 20;

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

/**
 * 检查用户管理权限（对应 Go 版 handler.canManageUsers）。
 *
 * 无权限时已写出响应并返回该响应，调用方直接返回即可；有权限返回 null。
 */
function requireAdmin(c: Context<AppEnv>): Response | null {
  const user = c.get("user");
  if (!user) return redirectWith(c, "/login", "", "");
  if (!roleCanManageUsers(user.role)) {
    return redirectWith(c, "/", "error", "只有管理员可以访问数据维护");
  }
  return null;
}

/** 取 R2 备份桶；未绑定时返回 null。 */
function backupBucket(c: Context<AppEnv>): R2Bucket | null {
  return c.env.BACKUPS ?? null;
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

maintenanceRoutes.get("/admin/maintenance", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  return renderMaintenance(c, 200, {});
});

/**
 * 渲染数据维护页，并汇总页面所需的全部状态。
 *
 * 三块数据各自独立容错：任何一块读失败都只让那一块降级（列表为空、
 * 提示条不显示、预演结果为零值），而不是整页 500 —— 否则「备份列表读不出来」
 * 会连带把「清理演示数据」也锁死，而后者本来正是能救场的操作。
 */
async function renderMaintenance(
  c: Context<AppEnv>,
  status: 200 | 422,
  errors: Record<string, string>,
): Promise<Response> {
  const cfg = c.get("cfg");
  const store = c.get("store");
  const logger = c.get("logger");
  const bucket = backupBucket(c);

  // 备份列表
  let backups: BackupEntry[] = [];
  if (bucket) {
    try {
      backups = await listBackups(bucket, cfg.backupPrefix);
    } catch (err) {
      logger.error("读取备份列表失败", {
        前缀: cfg.backupPrefix,
        错误: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 待恢复快照
  let pending: PendingInfo | null = null;
  if (bucket) {
    try {
      pending = await loadPending(bucket, cfg.backupPrefix);
    } catch (err) {
      logger.error("读取待恢复快照失败", {
        错误: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 预演一次演示数据清理，让页面直接显示当前库里有多少演示数据。
  // dryRun 只做统计，不产生任何改动。
  let preview: PurgeResult;
  try {
    preview = await store.purgeDemoData({ dryRun: true, legacySkuMatch: false });
  } catch (err) {
    logger.error("统计演示数据失败", { 错误: err instanceof Error ? err.message : String(err) });
    // 用零值而不是抛出去：模板里要读它的字段，少一个字段就会渲染失败。
    preview = emptyPurgeResult();
  }

  const data: MaintenanceData = {
    backupEnabled: bucket !== null,
    backups,
    backupPrefix: cfg.backupPrefix,
    backupKeep: cfg.backupKeep,
    pending,
    preview,
    hasDemoData: !purgeResultEmpty(preview),
    errors,
  };
  return render(c, status, "数据维护", "maintenance", data, maintenanceView);
}

/** 零值的清理结果。 */
function emptyPurgeResult(): PurgeResult {
  return {
    products: 0,
    movements: 0,
    categories: 0,
    suppliers: 0,
    skippedCategories: [],
    skippedSuppliers: [],
    legacySkuOnly: [],
  };
}

/**
 * 读取并解析待恢复快照；不存在返回 null。
 *
 * 快照在暂存时已经校验过一遍，这里再解析一次是有意为之：
 * R2 里的对象可能被别处（或运维手工）改过，而这是「即将覆盖全库」的输入，
 * 每次读取都重新校验比信任一个可能已经变了的对象便宜得多。
 */
async function loadPending(bucket: R2Bucket, prefix: string): Promise<PendingInfo | null> {
  const text = await getPendingText(bucket, prefix);
  if (text === null) return null;

  const meta = await pendingMeta(bucket, prefix);
  const snapshot = parseSnapshot(text);

  return {
    source: meta?.source ?? "上传的备份文件",
    size: meta?.size ?? text.length,
    counts: snapshot.counts,
    uploadedAt: meta?.uploaded ?? new Date(),
    createdAt: snapshot.createdAt,
    appVersion: snapshot.appVersion,
  };
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

maintenanceRoutes.post("/admin/maintenance/backup", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const cfg = c.get("cfg");
  const store = c.get("store");
  const logger = c.get("logger");
  const bucket = backupBucket(c);
  if (!bucket) {
    return redirectWith(c, maintenancePath, "error", "未绑定 R2 备份桶（BACKUPS），无法创建备份");
  }

  // 生成快照（行数超限会在这里直接报错，而不是产出一份残缺的备份）
  let snapshot: Snapshot;
  try {
    snapshot = await store.exportSnapshot(cfg.version);
  } catch (err) {
    logger.error("导出快照失败", { 错误: err instanceof Error ? err.message : String(err) });
    return redirectWith(c, maintenancePath, "error", "创建备份失败：" + businessError(err));
  }

  const json = JSON.stringify(snapshot);
  const sql = snapshotToSql(snapshot);

  let name: string;
  try {
    name = await uniqueBackupName(bucket, cfg.backupPrefix);
    await putBackup(bucket, cfg.backupPrefix, name, json, sql);
  } catch (err) {
    logger.error("写入备份失败", { 错误: err instanceof Error ? err.message : String(err) });
    return redirectWith(c, maintenancePath, "error", "创建备份失败：" + businessError(err));
  }

  // 立刻回读校验，确认拿到的不是「看起来像备份」的空壳对象。
  // 对应原版 database.InspectBackup + IntegrityOK 检查。
  let verified: Snapshot;
  try {
    const back = await getSnapshotText(bucket, cfg.backupPrefix, name);
    if (back === null) throw invalidInput("备份对象写入后无法读回");
    verified = parseSnapshot(back);
  } catch (err) {
    logger.error("备份校验失败", {
      备份: name,
      错误: err instanceof Error ? err.message : String(err),
    });
    return redirectWith(
      c,
      maintenancePath,
      "error",
      `备份已生成但校验失败，请勿使用：${businessError(err)}`,
    );
  }

  if (snapshotRowTotal(verified) !== snapshotRowTotal(snapshot)) {
    logger.error("备份校验失败：回读的行数不一致", {
      备份: name,
      期望: snapshotRowTotal(snapshot),
      实际: snapshotRowTotal(verified),
    });
    return redirectWith(c, maintenancePath, "error", `备份 ${name} 未通过完整性检查，请勿使用`);
  }

  let msg = `备份完成：${name}（${formatBytes(json.length)}），完整性检查通过`;

  try {
    const removed = await pruneBackups(bucket, cfg.backupPrefix, cfg.backupKeep);
    if (removed.length > 0) msg += `，已轮转清理 ${removed.length} 份旧备份`;
  } catch (err) {
    logger.warn("清理旧备份失败", { 错误: err instanceof Error ? err.message : String(err) });
  }

  logger.info("已创建备份", { 备份: name, 行数: snapshotRowTotal(snapshot) });
  return redirectWith(c, maintenancePath, "success", msg);
});

/**
 * 生成一个当前不存在的备份名。
 *
 * 名字精度到秒，同一秒内重复备份（连点两下）会撞名。原版撞名时直接报错，
 * 但那是因为它写的是磁盘文件、覆盖会丢历史数据；R2 的 put 同样是覆盖语义，
 * 所以照样不能覆盖 —— 加一个序号后缀，既不丢数据也不让用户白跑一趟。
 */
async function uniqueBackupName(bucket: R2Bucket, prefix: string): Promise<string> {
  const base = newBackupName();
  for (let i = 1; i <= 20; i += 1) {
    const name = i === 1 ? base : `${base}-${i}`;
    const head = await bucket.head(snapshotKey(prefix, name));
    if (head === null) return name;
  }
  throw invalidInput("同一秒内备份次数过多，请稍后重试");
}

maintenanceRoutes.get("/admin/maintenance/backup/download", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const cfg = c.get("cfg");
  const logger = c.get("logger");
  const bucket = backupBucket(c);
  if (!bucket) {
    return redirectWith(c, maintenancePath, "error", "未绑定 R2 备份桶（BACKUPS），无法下载备份");
  }

  const raw = c.req.query("name") ?? "";
  let name: string;
  try {
    name = assertBackupName(raw);
  } catch (err) {
    // 名字来自 URL，可能是手工拼的或已被篡改，这里只回提示不回显输入。
    // 提示文案直接用 businessError：它已经说清「备份文件名不合法」，
    // 外面再套一层前缀只会得到「备份文件名不合法：参数不合法：备份文件名不合法」。
    logger.warn("拒绝非法的备份下载请求", { 名称: raw, 错误: businessError(err) });
    return redirectWith(c, maintenancePath, "error", businessError(err));
  }

  const obj = await getSqlObject(bucket, cfg.backupPrefix, name);
  if (!obj) {
    return redirectWith(c, maintenancePath, "error", "备份文件不存在或无法读取");
  }

  // 直接转发 R2 的流，不先读进内存 —— 备份可能很大，缓冲一遍纯属浪费。
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      // 用 RFC 5987 的 filename* 形式，中文备份名也能正确落盘。
      "Content-Disposition": contentDisposition(`${name}.sql`),
      "Content-Length": String(obj.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});

maintenanceRoutes.post("/admin/maintenance/backup/delete", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const cfg = c.get("cfg");
  const logger = c.get("logger");
  const bucket = backupBucket(c);
  if (!bucket) {
    return redirectWith(c, maintenancePath, "error", "未绑定 R2 备份桶（BACKUPS），无法删除备份");
  }

  const form = await readForm(c);
  let name: string;
  try {
    name = assertBackupName(formTrimmed(form, "name"));
  } catch (err) {
    return redirectWith(c, maintenancePath, "error", businessError(err));
  }

  try {
    const existed = await deleteBackup(bucket, cfg.backupPrefix, name);
    if (!existed) {
      return redirectWith(c, maintenancePath, "error", `备份文件不存在：${name}`);
    }
  } catch (err) {
    logger.warn("删除备份失败", {
      名称: name,
      错误: err instanceof Error ? err.message : String(err),
    });
    return redirectWith(c, maintenancePath, "error", businessError(err));
  }

  logger.info("已删除备份", { 名称: name });
  return redirectWith(c, maintenancePath, "success", "已删除备份 " + name);
});

// ---------------------------------------------------------------------------
// 恢复
//
// 分两步：先暂存，再由管理员确认生效。
//
// 原版第二步靠「重启服务时换入文件」，Workers 没有可重启的进程，
// 但快照恢复本身能在请求里跑完，于是第二步变成一个按钮 ——
// 比原来少一次等待，而且中途随时可以放弃。
// ---------------------------------------------------------------------------

maintenanceRoutes.post("/admin/maintenance/restore", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const cfg = c.get("cfg");
  const logger = c.get("logger");
  const bucket = backupBucket(c);
  if (!bucket) {
    return redirectWith(c, maintenancePath, "error", "未绑定 R2 备份桶（BACKUPS），无法恢复");
  }

  const form = await readForm(c);
  let name: string;
  try {
    name = assertBackupName(formTrimmed(form, "name"));
  } catch (err) {
    return redirectWith(c, maintenancePath, "error", businessError(err));
  }

  let text: string | null;
  let snapshot: Snapshot;
  try {
    text = await getSnapshotText(bucket, cfg.backupPrefix, name);
    if (text === null) {
      return redirectWith(c, maintenancePath, "error", `备份文件不存在：${name}`);
    }
    snapshot = parseSnapshot(text);
  } catch (err) {
    logger.warn("拒绝恢复不可用的备份", { 名称: name, 错误: businessError(err) });
    return redirectWith(c, maintenancePath, "error", `已拒绝恢复 ${name}：${businessError(err)}`);
  }

  try {
    await putPending(bucket, cfg.backupPrefix, text, `站内备份 ${name}`);
  } catch (err) {
    logger.error("暂存待恢复快照失败", { 错误: err instanceof Error ? err.message : String(err) });
    return serverError(c, err);
  }

  logger.warn("已暂存待恢复的快照，等待管理员确认", {
    来源: name,
    行数: snapshotRowTotal(snapshot),
  });
  return redirectWith(
    c,
    maintenancePath,
    "info",
    `已暂存备份 ${name}（${snapshotRowTotal(snapshot)} 行），确认无误后点「立即生效」`,
  );
});

maintenanceRoutes.post("/admin/maintenance/restore/upload", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const cfg = c.get("cfg");
  const logger = c.get("logger");
  const bucket = backupBucket(c);
  if (!bucket) {
    return redirectWith(c, maintenancePath, "error", "未绑定 R2 备份桶（BACKUPS），无法恢复");
  }

  const form = await readForm(c);
  const file = formFile(form, "backup");
  if (!file) {
    return redirectWith(c, maintenancePath, "error", "请选择要恢复的备份文件");
  }

  // 中间件已经用 Content-Length 拦过一次，这里再用文件自身的声明复核一遍，
  // 给出更明确的提示（原版同样是「两处都查」）。
  if (file.size > MAX_RESTORE_UPLOAD) {
    return redirectWith(
      c,
      maintenancePath,
      "error",
      `备份文件过大（${formatBytes(file.size)}），上限为 ${formatBytes(MAX_RESTORE_UPLOAD)}`,
    );
  }

  let text: string;
  let snapshot: Snapshot;
  try {
    text = await file.text();
    snapshot = parseSnapshot(text);
  } catch (err) {
    logger.warn("拒绝恢复上传的备份", {
      来源: file.name,
      错误: err instanceof Error ? err.message : String(err),
    });
    return redirectWith(c, maintenancePath, "error", `已拒绝恢复 ${file.name}：${businessError(err)}`);
  }

  try {
    await putPending(bucket, cfg.backupPrefix, text, `上传文件 ${file.name}`);
  } catch (err) {
    logger.error("暂存待恢复快照失败", { 错误: err instanceof Error ? err.message : String(err) });
    return serverError(c, err);
  }

  logger.warn("已暂存上传的快照，等待管理员确认", {
    来源: file.name,
    大小: file.size,
    行数: snapshotRowTotal(snapshot),
    商品数: snapshot.counts.products ?? 0,
    用户数: snapshot.counts.users ?? 0,
  });
  return redirectWith(
    c,
    maintenancePath,
    "info",
    `已校验并暂存 ${file.name}（${snapshotRowTotal(snapshot)} 行），确认无误后点「立即生效」`,
  );
});

maintenanceRoutes.post("/admin/maintenance/restore/apply", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const cfg = c.get("cfg");
  const store = c.get("store");
  const logger = c.get("logger");
  const bucket = backupBucket(c);
  if (!bucket) {
    return redirectWith(c, maintenancePath, "error", "未绑定 R2 备份桶（BACKUPS），无法恢复");
  }

  let text: string | null;
  let snapshot: Snapshot;
  try {
    text = await getPendingText(bucket, cfg.backupPrefix);
    if (text === null) {
      return redirectWith(c, maintenancePath, "error", "没有待恢复的快照，请先选择或上传备份");
    }
    snapshot = parseSnapshot(text);
  } catch (err) {
    logger.error("读取待恢复快照失败", { 错误: businessError(err) });
    return redirectWith(c, maintenancePath, "error", `待恢复的快照不可用：${businessError(err)}`);
  }

  // 安全备份：恢复不可回滚，先留一个还原点。
  try {
    const name = await uniqueBackupName(bucket, cfg.backupPrefix);
    const current = await store.exportSnapshot(cfg.version);
    await putBackup(bucket, cfg.backupPrefix, name, JSON.stringify(current), snapshotToSql(current));
    logger.info("恢复前的安全备份已完成", { 备份: name });
  } catch (err) {
    logger.error("恢复前的安全备份失败，已中止恢复", {
      错误: err instanceof Error ? err.message : String(err),
    });
    return redirectWith(
      c,
      maintenancePath,
      "error",
      "恢复前的安全备份失败，为安全起见已中止恢复：" + businessError(err),
    );
  }

  let written: Record<string, number>;
  try {
    written = await store.applySnapshot(snapshot);
  } catch (err) {
    logger.error("恢复快照失败", { 错误: err instanceof Error ? err.message : String(err) });
    return redirectWith(
      c,
      maintenancePath,
      "error",
      "恢复失败，数据可能处于不完整状态，请用安全备份再恢复一次：" + businessError(err),
    );
  }

  // 生效后清掉暂存，避免下次误点「立即生效」又恢复一遍同一份旧数据。
  try {
    await deletePending(bucket, cfg.backupPrefix);
  } catch (err) {
    logger.warn("清理待恢复快照失败", { 错误: err instanceof Error ? err.message : String(err) });
  }

  try {
    const removed = await pruneBackups(bucket, cfg.backupPrefix, cfg.backupKeep);
    if (removed.length > 0) logger.info("已轮转清理旧备份", { 数量: removed.length });
  } catch (err) {
    logger.warn("清理旧备份失败", { 错误: err instanceof Error ? err.message : String(err) });
  }

  logger.warn("已用备份覆盖数据库", { 行数: written, 来源: snapshot.appVersion || "未知版本" });
  return redirectWith(c, maintenancePath, "success", `已恢复备份数据：${countText(written)}`);
});

maintenanceRoutes.post("/admin/maintenance/restore/discard", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const cfg = c.get("cfg");
  const logger = c.get("logger");
  const bucket = backupBucket(c);
  if (!bucket) {
    return redirectWith(c, maintenancePath, "error", "未绑定 R2 备份桶（BACKUPS）");
  }

  try {
    await deletePending(bucket, cfg.backupPrefix);
  } catch (err) {
    logger.error("丢弃待恢复快照失败", { 错误: err instanceof Error ? err.message : String(err) });
    return redirectWith(c, maintenancePath, "error", businessError(err));
  }

  logger.info("已丢弃待恢复的快照");
  return redirectWith(c, maintenancePath, "success", "已放弃待恢复的备份，当前数据未受影响");
});

/** 把各表写入行数写成「商品 12、库存流水 30」。 */
function countText(written: Record<string, number>): string {
  const labels: Record<string, string> = {
    products: "商品",
    stock_movements: "库存流水",
    categories: "分类",
    suppliers: "供应商",
    users: "用户",
  };
  const parts: string[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const n = written[key];
    if (n !== undefined) parts.push(`${label} ${n}`);
  }
  return parts.length > 0 ? parts.join("、") : "无数据";
}

// ---------------------------------------------------------------------------
// 演示数据清理
// ---------------------------------------------------------------------------

/**
 * 删除内置演示数据。
 *
 * 清理不可回滚，因此在真正删除之前会先自动做一份安全备份，
 * 让用户随时能把数据找回来。
 */
maintenanceRoutes.post("/admin/maintenance/purge-demo-data", async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const cfg = c.get("cfg");
  const store = c.get("store");
  const logger = c.get("logger");
  const bucket = backupBucket(c);
  if (!bucket) {
    return redirectWith(c, maintenancePath, "error", "未绑定 R2 备份桶（BACKUPS），无法清理演示数据");
  }

  // 先预演一次：没有任何演示数据时直接返回，避免无谓地产生备份文件。
  let preview: PurgeResult;
  try {
    preview = await store.purgeDemoData({ dryRun: true, legacySkuMatch: false });
  } catch (err) {
    logger.error("统计演示数据失败", { 错误: err instanceof Error ? err.message : String(err) });
    return redirectWith(c, maintenancePath, "error", "统计演示数据失败：" + businessError(err));
  }

  if (purgeResultEmpty(preview)) {
    if (hasLegacyCandidates(preview)) {
      return redirectWith(
        c,
        maintenancePath,
        "info",
        `未发现带演示标记的数据；另有 ${preview.legacySkuOnly.length} 个商品的 SKU 与内置演示编号相同但无标记，` +
          `出于安全考虑未做删除（见页面上的说明）`,
      );
    }
    return redirectWith(c, maintenancePath, "info", "未发现内置演示数据，无需清理");
  }

  // 安全备份：清理不可回滚，先留一个还原点。
  let safetyName: string;
  try {
    safetyName = await uniqueBackupName(bucket, cfg.backupPrefix);
    const current = await store.exportSnapshot(cfg.version);
    await putBackup(
      bucket,
      cfg.backupPrefix,
      safetyName,
      JSON.stringify(current),
      snapshotToSql(current),
    );
  } catch (err) {
    logger.error("清理前的安全备份失败，已中止清理", {
      错误: err instanceof Error ? err.message : String(err),
    });
    return redirectWith(
      c,
      maintenancePath,
      "error",
      "清理前的安全备份失败，为安全起见已中止清理：" + businessError(err),
    );
  }

  let res: PurgeResult;
  try {
    res = await store.purgeDemoData({ dryRun: false, legacySkuMatch: false });
  } catch (err) {
    logger.error("清理演示数据失败", { 错误: err instanceof Error ? err.message : String(err) });
    return redirectWith(c, maintenancePath, "error", "清理演示数据失败：" + businessError(err));
  }

  let msg =
    `已清理演示数据：商品 ${res.products}、库存流水 ${res.movements}、` +
    `分类 ${res.categories}、供应商 ${res.suppliers}；安全备份 ${safetyName}`;

  const kept = [...res.skippedCategories, ...res.skippedSuppliers].join("、");
  if (kept !== "") msg += "；仍被商品引用的 " + kept + " 已保留";

  try {
    const removed = await pruneBackups(bucket, cfg.backupPrefix, cfg.backupKeep);
    if (removed.length > 0) msg += `；已轮转清理 ${removed.length} 份旧备份`;
  } catch (err) {
    logger.warn("清理旧备份失败", { 错误: err instanceof Error ? err.message : String(err) });
  }

  return redirectWith(c, maintenancePath, "success", msg);
});
