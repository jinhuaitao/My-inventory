// 数据快照的导出与恢复 —— 对应原 Go 版 internal/database/database.go 里
// 「备份与迁移」一节（Backup / InspectBackup / StageRestore / ApplyPendingRestore）。
//
// 为什么不是「拷贝数据库文件」：
//   Go 版用 VACUUM INTO 产出一个单文件 .db，再靠「暂存 + 重启时 rename 换入」
//   完成恢复。Workers 里这两步都做不到 —— 没有文件系统，D1 又是托管服务，
//   Worker 拿不到数据库文件、也无法把它换回去。
//
// 这里改成**逻辑快照**：把每张表读成行数据，恢复时先清空再写回。
// 语义上等价于「用备份整体替换当前数据库」，而且顺带得到一个能在本机
// 用 `wrangler d1 execute` 导入的 .sql 脚本。
//
// ⚠️ 已知限制（务必在 README 里向运维说清）：
//   1. 快照行数上限 MAX_SNAPSHOT_ROWS。D1 单条语句的绑定参数有上限，
//      插入必须按列数切块，行数一大请求就会超时。超出上限时**直接报错**
//      而不是悄悄截断 —— 一份残缺的备份比没有备份更危险。
//   2. 恢复是「先删后写」，中途失败会留下不完整的库。因此调用方
//      （routes/maintenance.ts）必须像原版清理演示数据那样，先做一份安全备份。

import { invalidInput } from "../lib/errors";
import { nowUtcIso } from "../lib/time";
import { Store } from "./store";

// ---------------------------------------------------------------------------
// 快照格式
// ---------------------------------------------------------------------------

/** 快照文件的格式标识，用于拒绝结构不符的上传文件。 */
export const SNAPSHOT_FORMAT = "inventory-snapshot";

/** 快照格式版本。读取时只接受 <= 本值的文件。 */
export const SNAPSHOT_VERSION = 1;

/**
 * 单次快照允许包含的最大行数。
 *
 * 20 000 行是实测能在一个 Workers 请求里稳定完成「导出 + 写 R2」的量级。
 * 更大的库请用 `npx wrangler d1 export inventory --remote --output=backup.sql`
 * 在本地导出 —— 那条路径不受 Worker 的 CPU 与请求时长限制。
 */
export const MAX_SNAPSHOT_ROWS = 20_000;

/** 单条 INSERT 允许绑定的最大参数个数（D1 的上限）。 */
const MAX_BOUND_PARAMS = 100;

/** 一个 db.batch 里最多放多少条语句。 */
const STATEMENTS_PER_BATCH = 50;

/**
 * 参与快照的表，**顺序即插入顺序**（必须满足外键依赖）。
 *
 * 删除时按反序执行：stock_movements 的两个外键是 ON DELETE RESTRICT，
 * 必须先删流水再删商品 / 供应商 / 用户，否则整批删除都会被外键挡下。
 */
export const BACKUP_TABLES = [
  "users",
  "categories",
  "suppliers",
  "products",
  "stock_movements",
  "settings",
  "security_questions",
  "sessions",
  "login_attempts",
  "recovery_attempts",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

/**
 * 每张表的列清单，必须与 migrations/0001_init.sql 保持一致。
 *
 * 这是导出、校验、生成 SQL 三处的**唯一列来源**：
 *   - 上传的快照文件里带 columns 字段，若直接拿去拼 SQL 就是注入口子，
 *     因此恢复前必须逐列对照本表做白名单校验；
 *   - 反过来，导出的列顺序也由它固定，快照文件因此可以自描述。
 * 新增迁移加列时，这里要同步加 —— 否则新列不会进备份。
 */
export const KNOWN_COLUMNS: Record<BackupTable, readonly string[]> = {
  users: [
    "id",
    "username",
    "email",
    "password_hash",
    "full_name",
    "role",
    "status",
    "last_login_at",
    "created_at",
    "updated_at",
  ],
  categories: ["id", "name", "description", "is_demo", "created_at", "updated_at"],
  suppliers: [
    "id",
    "name",
    "contact_person",
    "phone",
    "email",
    "address",
    "note",
    "is_demo",
    "created_at",
    "updated_at",
  ],
  products: [
    "id",
    "sku",
    "name",
    "barcode",
    "category_id",
    "supplier_id",
    "unit",
    "cost_price",
    "sale_price",
    "quantity",
    "safety_stock",
    "location",
    "description",
    "status",
    "is_demo",
    "created_at",
    "updated_at",
  ],
  stock_movements: [
    "id",
    "product_id",
    "type",
    "quantity",
    "delta",
    "unit_price",
    "before_qty",
    "after_qty",
    "ref_no",
    "supplier_id",
    "operator_id",
    "note",
    "created_at",
  ],
  settings: ["key", "value", "updated_at"],
  security_questions: [
    "id",
    "user_id",
    "position",
    "question",
    "answer_hash",
    "created_at",
    "updated_at",
  ],
  sessions: ["id", "user_id", "token_hash", "csrf_token", "expires_at", "created_at", "user_agent", "ip"],
  login_attempts: ["id", "identifier", "ip", "success", "blocked", "created_at"],
  recovery_attempts: ["id", "user_id", "identifier", "ip", "success", "blocked", "created_at"],
};

/** 快照里的一张表：列名 + 行数据（行用数组存，省掉重复的列名，体积小很多）。 */
export interface SnapshotTable {
  name: string;
  columns: string[];
  rows: SnapshotValue[][];
}

/** 快照里允许出现的值类型。 */
export type SnapshotValue = string | number | null | BlobValue;

/** BLOB 列的 JSON 载体（本项目 schema 里没有 BLOB，纯属防御性处理）。 */
export interface BlobValue {
  $blob: string;
}

/** 一份完整的数据快照。 */
export interface Snapshot {
  format: string;
  version: number;
  /** 生成时间（UTC ISO-8601）。 */
  createdAt: string;
  /** 生成时的应用版本，便于排查「用新版本备份恢复到旧版本」。 */
  appVersion: string;
  /** 各表行数，页面直接展示，不必再遍历 rows。 */
  counts: Record<string, number>;
  tables: SnapshotTable[];
}

/** 备份名 → 快照内容之外的展示信息。 */
export interface SnapshotSummary {
  size: number;
  counts: Record<string, number>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 值编解码
// ---------------------------------------------------------------------------

/** 数据库返回值 → 可 JSON 序列化的快照值。 */
function encodeValue(v: unknown): SnapshotValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return { $blob: bytesToBase64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) {
    const view = v as ArrayBufferView;
    return { $blob: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)) };
  }
  // 兜底：D1 不该返回其它类型，真出现了就转成字符串而不是丢掉这一列的值。
  return String(v);
}

/** 快照值 → 可直接绑定给 D1 的值。 */
function decodeValue(v: SnapshotValue): string | number | null | Uint8Array {
  if (v === null || typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "object" && typeof v.$blob === "string") return base64ToBytes(v.$blob);
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// 标识符与字面量
// ---------------------------------------------------------------------------

/** 标识符加双引号（内部双引号翻倍），表名与列名都走它。 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 快照值 → SQL 字面量。 */
function sqlLiteral(v: SnapshotValue): string {
  if (v === null) return "NULL";
  if (typeof v === "number") {
    // SQLite 没有 NaN / Infinity，写成 0 而不是让整条语句报错。
    return Number.isFinite(v) ? String(v) : "0";
  }
  if (typeof v === "object") {
    const bytes = base64ToBytes(v.$blob);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return `X'${hex}'`;
  }
  return `'${v.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

declare module "./store" {
  interface Store {
    /** 把整库读成一份逻辑快照。 */
    exportSnapshot(appVersion: string): Promise<Snapshot>;
    /** 用快照整体替换当前数据库。返回各表写入的行数。 */
    applySnapshot(snapshot: Snapshot): Promise<Record<string, number>>;
  }
}

Store.prototype.exportSnapshot = async function (
  this: Store,
  appVersion: string,
): Promise<Snapshot> {
  const tables: SnapshotTable[] = [];
  const counts: Record<string, number> = {};
  let total = 0;

  for (const name of BACKUP_TABLES) {
    const columns = [...KNOWN_COLUMNS[name]];
    const colSql = columns.map(quoteIdent).join(", ");
    const res = await this.db
      .prepare(`SELECT ${colSql} FROM ${quoteIdent(name)}`)
      .all<Record<string, unknown>>();

    const rows = (res.results ?? []).map((row) => columns.map((c) => encodeValue(row[c])));

    total += rows.length;
    if (total > MAX_SNAPSHOT_ROWS) {
      // 报错而不是截断：截断出来的备份看起来是好的，恢复时才炸。
      throw invalidInput(
        `数据量超过 ${MAX_SNAPSHOT_ROWS} 行，超出站内备份能力；` +
          `请改用 npx wrangler d1 export inventory --remote --output=backup.sql 在本地导出`,
      );
    }

    tables.push({ name, columns, rows });
    counts[name] = rows.length;
  }

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: nowUtcIso(),
    appVersion,
    counts,
    tables,
  };
};

/** 快照总行数。 */
export function snapshotRowTotal(s: Snapshot): number {
  return s.tables.reduce((sum, t) => sum + t.rows.length, 0);
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 校验并规范化一份外部快照（来自 R2 或管理员上传）。
 *
 * 这里的严格程度是按「输入完全不可信」来定的：
 *   - 表名必须命中 BACKUP_TABLES，列名必须命中 KNOWN_COLUMNS —— 这两处都会
 *     被拼进 SQL，白名单校验是必须的，否则一个上传文件就能改写任意表结构；
 *   - 行必须是数组，长度必须等于列数，否则绑定时参数个数对不上；
 *   - 总行数受 MAX_SNAPSHOT_ROWS 约束，防止一个超大文件把 Worker 拖垮。
 */
export function parseSnapshot(raw: string): Snapshot {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw invalidInput("文件不是有效的 JSON，可能已损坏");
  }
  return validateSnapshot(data);
}

/** 见 parseSnapshot 的说明。 */
export function validateSnapshot(data: unknown): Snapshot {
  if (typeof data !== "object" || data === null) throw invalidInput("快照内容格式不正确");
  const obj = data as Record<string, unknown>;

  if (obj.format !== SNAPSHOT_FORMAT) {
    throw invalidInput("这不是本系统导出的数据快照文件");
  }
  const version = typeof obj.version === "number" ? obj.version : 0;
  if (version < 1 || version > SNAPSHOT_VERSION) {
    throw invalidInput(`快照格式版本 ${version} 不受支持（当前支持到 ${SNAPSHOT_VERSION}）`);
  }
  if (!Array.isArray(obj.tables)) throw invalidInput("快照缺少表数据");

  const tables: SnapshotTable[] = [];
  const counts: Record<string, number> = {};
  let total = 0;

  for (const item of obj.tables as unknown[]) {
    if (typeof item !== "object" || item === null) throw invalidInput("快照中的表定义格式不正确");
    const t = item as Record<string, unknown>;
    const name = String(t.name ?? "");

    if (!(BACKUP_TABLES as readonly string[]).includes(name)) {
      throw invalidInput(`快照包含未知的数据表「${name}」`);
    }
    const allowed = KNOWN_COLUMNS[name as BackupTable];
    if (!Array.isArray(t.columns)) throw invalidInput(`表「${name}」缺少列定义`);

    const columns = (t.columns as unknown[]).map((c) => String(c));
    for (const c of columns) {
      if (!allowed.includes(c)) throw invalidInput(`表「${name}」包含未知的列「${c}」`);
    }
    if (columns.length === 0) throw invalidInput(`表「${name}」的列定义为空`);

    if (!Array.isArray(t.rows)) throw invalidInput(`表「${name}」缺少行数据`);
    const rows: SnapshotValue[][] = [];
    for (const row of t.rows as unknown[]) {
      if (!Array.isArray(row) || row.length !== columns.length) {
        throw invalidInput(`表「${name}」的行数据与列定义不匹配`);
      }
      rows.push((row as unknown[]).map(normalizeSnapshotValue));
    }

    total += rows.length;
    if (total > MAX_SNAPSHOT_ROWS) {
      throw invalidInput(`快照超过 ${MAX_SNAPSHOT_ROWS} 行，拒绝导入`);
    }

    tables.push({ name, columns, rows });
    counts[name] = rows.length;
  }

  return {
    format: SNAPSHOT_FORMAT,
    version,
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : "",
    appVersion: typeof obj.appVersion === "string" ? obj.appVersion : "",
    counts,
    tables,
  };
}

/** 把 JSON 里读出来的值收敛到 SnapshotValue。 */
function normalizeSnapshotValue(v: unknown): SnapshotValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") {
    const blob = (v as Record<string, unknown>).$blob;
    if (typeof blob === "string") return { $blob: blob };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 生成可下载的 SQL 脚本
// ---------------------------------------------------------------------------

/**
 * 把快照渲染成 SQL 脚本。
 *
 * 这个脚本的用途是「拿到别的环境里导入」：
 *   npx wrangler d1 execute inventory --remote --file=inventory-xxx.sql
 * 因此它自带清表语句，是一条能独立跑完的完整脚本。
 *
 * 刻意不写 BEGIN/COMMIT：D1 的 execute 不接受显式事务控制语句，
 * 加了反而会让整个导入失败。语句顺序已经按外键依赖排好，不需要事务兜底。
 */
export function snapshotToSql(s: Snapshot): string {
  const lines: string[] = [
    "-- 库存管理系统 · 数据快照",
    `-- 生成时间（UTC）：${s.createdAt}`,
    `-- 生成版本：${s.appVersion || "未知"}`,
    `-- 行数：${snapshotRowTotal(s)}`,
    "--",
    "-- 导入方式：",
    "--   npx wrangler d1 execute inventory --remote --file=<本文件>",
    "--",
    "-- ⚠️ 脚本会先清空下列各表再写入，请勿在已有数据的库上误执行。",
    "",
  ];

  for (const name of [...BACKUP_TABLES].reverse()) {
    lines.push(`DELETE FROM ${quoteIdent(name)};`);
  }
  lines.push("");

  for (const table of s.tables) {
    if (table.rows.length === 0) continue;
    const colSql = table.columns.map(quoteIdent).join(", ");
    lines.push(`-- ${table.name}：${table.rows.length} 行`);
    for (const row of table.rows) {
      lines.push(
        `INSERT INTO ${quoteIdent(table.name)} (${colSql}) VALUES (${row.map(sqlLiteral).join(", ")});`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

/**
 * 用快照整体替换当前数据库。
 *
 * 分两批执行：先按反序清空全部表，再按正序写入。
 * 之所以不能合成一个 batch —— D1 的 batch 虽然原子，但有语句数量与体积上限，
 * 大快照必然要拆成多次提交；既然无论如何都会出现中间态，
 * 就由调用方在动手之前先做安全备份来兜底（与原版清理演示数据同一思路）。
 *
 * 清空与写入分开还有一个好处：清空只有 10 条语句，能一次提交完，
 * 不会出现「删了一半」的库。
 */
Store.prototype.applySnapshot = async function (
  this: Store,
  snapshot: Snapshot,
): Promise<Record<string, number>> {
  // ---------- 1. 清空（反序，先删子表） ----------
  const wipe = [...BACKUP_TABLES]
    .reverse()
    .map((name) => this.db.prepare(`DELETE FROM ${quoteIdent(name)}`));
  await this.db.batch(wipe);

  // ---------- 2. 写入（正序，按参数上限切块） ----------
  const written: Record<string, number> = {};
  let pending: D1PreparedStatement[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const chunk = pending;
    pending = [];
    await this.db.batch(chunk);
  };

  for (const table of snapshot.tables) {
    written[table.name] = 0;
    if (table.rows.length === 0) continue;

    const colSql = table.columns.map(quoteIdent).join(", ");
    const perStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMS / table.columns.length));
    const valueGroup = `(${table.columns.map(() => "?").join(", ")})`;

    for (let i = 0; i < table.rows.length; i += perStatement) {
      const slice = table.rows.slice(i, i + perStatement);
      const stmt = this.db.prepare(
        `INSERT INTO ${quoteIdent(table.name)} (${colSql}) VALUES ${slice
          .map(() => valueGroup)
          .join(", ")}`,
      );
      pending.push(stmt.bind(...slice.flatMap((row) => row.map(decodeValue))));
      written[table.name] += slice.length;

      if (pending.length >= STATEMENTS_PER_BATCH) await flush();
    }
  }
  await flush();

  this.logger.warn("已用快照覆盖数据库", {
    行数: written,
    来源: snapshot.appVersion || "未知版本",
    生成时间: snapshot.createdAt,
  });
  return written;
};
