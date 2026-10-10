// 备份文件的存储层 —— 对应原 Go 版 internal/database/database.go 里的
// Backup / ListBackups / ResolveBackupPath / DeleteBackup / PruneBackups。
//
// ⚠️ 与原版最大的差异：Go 版把备份写成服务器磁盘上的 .db 文件，Workers 没有
// 可写文件系统，这里改为写进 **R2 桶**（wrangler.jsonc 的 r2_buckets 绑定）。
//
// 每份备份占两个对象（同名前缀，扩展名不同）：
//   <prefix><name>.json —— 结构化快照，站内「一键恢复」读它，也是备份的权威内容
//   <prefix><name>.sql  —— 等价的 SQL 脚本，供下载后在本机或别的环境
//                          用 `wrangler d1 execute --file=...` 导入
// 之所以不用单个 .db 文件：D1 的 dump() 已被官方标记废弃（只对 alpha v1 库有效），
// 而且 Workers 里既没有 SQLite 引擎、也没有文件系统，拿到 .db 也解析不了。
// 导出成「行数据 + 可执行 SQL」是本环境下唯一既能下载、又能被程序自己读回的格式。

import { invalidInput } from "./errors";
import { localStamp } from "./time";

/** 自动生成的备份文件名前缀，与原版 backupFilePrefix 一致。 */
export const BACKUP_NAME_PREFIX = "inventory-";

/** 快照对象扩展名。 */
export const SNAPSHOT_EXT = ".json";

/** 可下载 SQL 脚本的扩展名。 */
export const SQL_EXT = ".sql";

/** 自动备份名的时间戳格式：YYYYMMDD-HHMMSS。 */
const AUTO_NAME_RE = /^inventory-\d{8}-\d{6}$/;

/** 手工命名允许的字符集：中英文、数字、下划线、连字符、点。 */
const SAFE_NAME_RE = /^[\w.\u4e00-\u9fa5-]+$/;

/** 待恢复快照的对象名（位于同一前缀下，与备份并列）。 */
export const PENDING_NAME = "pending-restore";

// ---------------------------------------------------------------------------
// 名称校验
// ---------------------------------------------------------------------------

/** 是否为 Backup 自动生成的名称（inventory-YYYYMMDD-HHMMSS）。 */
export function isAutoBackupName(name: string): boolean {
  return AUTO_NAME_RE.test(name);
}

/**
 * 生成一份新的自动备份名。
 *
 * 用展示时区（UTC+8）的时间戳，而不是 UTC —— 备份列表是给人看的，
 * 名字里的时间和页面上「创建时间」列显示的必须是同一个时刻。
 */
export function newBackupName(now: Date = new Date()): string {
  return BACKUP_NAME_PREFIX + localStamp(now);
}

/**
 * 校验备份名是否合法。
 *
 * 名字来自 HTTP 查询串与表单，必须做越界防护：只接受纯文件名
 * （不含目录分隔符、不是 . 或 ..、不以点开头），
 * 这样 `../../etc/passwd`、`a/b` 这类输入会被直接拒绝。
 * R2 的 key 本身是扁平命名空间，越界不会读到别的数据，
 * 但仍要拦住 —— 否则一个 `/` 就能在桶里造出「目录」，让列表与轮转逻辑错乱。
 */
export function assertBackupName(raw: string): string {
  const name = raw.trim();
  if (name === "") throw invalidInput("未指定备份文件");
  if (name.length > 120) throw invalidInput("备份文件名过长");
  if (name === "." || name === "..") throw invalidInput("备份文件名不合法");
  if (name.startsWith(".")) throw invalidInput("备份文件名不合法");
  if (name.includes("/") || name.includes("\\")) throw invalidInput("备份文件名不合法");
  if (!SAFE_NAME_RE.test(name)) throw invalidInput("备份文件名只能包含中英文、数字、下划线、连字符和点");
  return name;
}

/** 备份名 → 快照对象 key。 */
export function snapshotKey(prefix: string, name: string): string {
  return `${prefix}${name}${SNAPSHOT_EXT}`;
}

/** 备份名 → SQL 脚本对象 key。 */
export function sqlKey(prefix: string, name: string): string {
  return `${prefix}${name}${SQL_EXT}`;
}

/** 待恢复快照的对象 key。 */
export function pendingKey(prefix: string): string {
  return `${prefix}${PENDING_NAME}${SNAPSHOT_EXT}`;
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

/** 备份列表里的一项。 */
export interface BackupEntry {
  name: string;
  /** 快照对象的大小（字节）。 */
  size: number;
  /** 上传时间。 */
  createdAt: Date;
  /** 是否为自动命名（自动命名的会被轮转清理，手工命名的不会）。 */
  auto: boolean;
  /** 是否同时存在可下载的 .sql 脚本。 */
  hasSql: boolean;
}

/**
 * 列出备份，按时间倒序（最新在前）。
 *
 * 以 .json 快照为准来枚举：只有 .sql 而没有快照的对象是残缺的备份
 * （可能上次写入时中途失败），列出来反而会误导管理员去恢复一个不可用的文件。
 */
export async function listBackups(bucket: R2Bucket, prefix: string): Promise<BackupEntry[]> {
  const objects = await listAll(bucket, prefix);

  const sqlNames = new Set<string>();
  for (const obj of objects) {
    const name = stripKey(prefix, obj.key, SQL_EXT);
    if (name !== null) sqlNames.add(name);
  }

  const out: BackupEntry[] = [];
  for (const obj of objects) {
    const name = stripKey(prefix, obj.key, SNAPSHOT_EXT);
    if (name === null) continue;
    out.push({
      name,
      size: obj.size,
      createdAt: obj.uploaded,
      auto: isAutoBackupName(name),
      hasSql: sqlNames.has(name),
    });
  }

  out.sort((a, b) => {
    const ta = a.createdAt.getTime();
    const tb = b.createdAt.getTime();
    if (ta === tb) {
      // 时间戳相同的极端情况下用文件名兜底，保证顺序稳定
      return a.name < b.name ? 1 : -1;
    }
    return tb - ta;
  });
  return out;
}

/** 列出前缀下的全部对象（自动翻页）。 */
async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  // 单次 list 最多返回 1000 个对象，这里循环取完；同时设一个上限，
  // 避免桶里被塞进大量无关对象时把请求拖死。
  for (let page = 0; page < 20; page += 1) {
    const res: R2Objects = await bucket.list({ prefix, cursor, limit: 1000 });
    out.push(...res.objects);
    if (!res.truncated) break;
    cursor = res.cursor;
    if (!cursor) break;
  }
  return out;
}

/** 从对象 key 还原备份名；扩展名不匹配返回 null。 */
function stripKey(prefix: string, key: string, ext: string): string | null {
  if (!key.startsWith(prefix) || !key.endsWith(ext)) return null;
  const name = key.slice(prefix.length, key.length - ext.length);
  if (name === "" || name === PENDING_NAME) return null;
  return name;
}

// ---------------------------------------------------------------------------
// 读写删
// ---------------------------------------------------------------------------

/** 写入一份备份（快照 + SQL 脚本）。 */
export async function putBackup(
  bucket: R2Bucket,
  prefix: string,
  name: string,
  snapshotJson: string,
  sql: string,
): Promise<void> {
  await bucket.put(snapshotKey(prefix, name), snapshotJson, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { kind: "snapshot", name },
  });
  await bucket.put(sqlKey(prefix, name), sql, {
    httpMetadata: { contentType: "application/sql; charset=utf-8" },
    customMetadata: { kind: "sql", name },
  });
}

/** 读取快照文本；不存在返回 null。 */
export async function getSnapshotText(
  bucket: R2Bucket,
  prefix: string,
  name: string,
): Promise<string | null> {
  const obj = await bucket.get(snapshotKey(prefix, name));
  if (!obj) return null;
  return obj.text();
}

/** 读取可下载的 SQL 脚本；不存在返回 null。 */
export async function getSqlObject(
  bucket: R2Bucket,
  prefix: string,
  name: string,
): Promise<R2ObjectBody | null> {
  return bucket.get(sqlKey(prefix, name));
}

/** 删除一份备份（快照 + SQL 脚本）。返回快照是否存在过。 */
export async function deleteBackup(bucket: R2Bucket, prefix: string, name: string): Promise<boolean> {
  const existed = (await bucket.head(snapshotKey(prefix, name))) !== null;
  await bucket.delete([snapshotKey(prefix, name), sqlKey(prefix, name)]);
  return existed;
}

/** 写入待恢复快照（覆盖式）。source 是来源描述，供页面展示。 */
export async function putPending(
  bucket: R2Bucket,
  prefix: string,
  snapshotJson: string,
  source: string,
): Promise<void> {
  await bucket.put(pendingKey(prefix), snapshotJson, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { kind: "pending", source },
  });
}

/** 读取待恢复快照文本；不存在返回 null。 */
export async function getPendingText(bucket: R2Bucket, prefix: string): Promise<string | null> {
  const obj = await bucket.get(pendingKey(prefix));
  if (!obj) return null;
  return obj.text();
}

/** 待恢复快照的元信息。 */
export interface PendingMeta {
  /** 字节数（用对象自身的 size，而不是字符串长度 —— 中文的字符数与字节数不同）。 */
  size: number;
  uploaded: Date;
  /** 暂存时记下的来源描述。 */
  source: string;
}

/** 读取待恢复快照的元信息；不存在返回 null。 */
export async function pendingMeta(bucket: R2Bucket, prefix: string): Promise<PendingMeta | null> {
  const head = await bucket.head(pendingKey(prefix));
  if (!head) return null;
  return {
    size: head.size,
    uploaded: head.uploaded,
    source: head.customMetadata?.source ?? "上传的备份文件",
  };
}

/** 丢弃待恢复快照。 */
export async function deletePending(bucket: R2Bucket, prefix: string): Promise<void> {
  await bucket.delete(pendingKey(prefix));
}

// ---------------------------------------------------------------------------
// 轮转
// ---------------------------------------------------------------------------

/**
 * 只保留最新的 keep 份**自动命名**的备份，其余删除，返回被删列表。
 *
 * 手工命名的备份一律不动 —— 与原版一致：手工命名的往往是有意长期留存的
 * 还原点，按数量轮转掉它们是意料之外的数据丢失。
 * keep <= 0 时不做任何清理。
 */
export async function pruneBackups(
  bucket: R2Bucket,
  prefix: string,
  keep: number,
): Promise<string[]> {
  if (keep <= 0) return [];

  const entries = await listBackups(bucket, prefix);
  const auto = entries.filter((e) => e.auto);
  // 名字里是零填充的时间戳，按字符串降序即时间降序
  auto.sort((a, b) => (a.name < b.name ? 1 : -1));
  if (auto.length <= keep) return [];

  const removed: string[] = [];
  for (const entry of auto.slice(keep)) {
    await deleteBackup(bucket, prefix, entry.name);
    removed.push(entry.name);
  }
  return removed;
}
