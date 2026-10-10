// 数据库结构：运行时自愈 —— 对应原 Go 版 internal/database/database.go 里的
// `//go:embed schema.sql` + `Migrate()`。
//
// 为什么需要它
// ------------
// 原版是单二进制：启动时自动建表（main.go 调用 database.Migrate），所以**永远
// 不会出现「表不存在」**。Workers 版如果只依赖 `wrangler d1 migrations apply`，
// 一旦部署流程漏了这一步，线上就是一个「D1 绑定正常、但库里一张表都没有」的
// 状态 —— 页面直接 500，而笼统的提示语指不到真正的原因。
//
// 因此这里在首次请求时检查一次：users 表不存在就按 migrations/0001_init.sql
// 建好。对应地，原版那句「D1 是全新库」的假设由这段代码兜住。
//
// 安全性
// ------
// * 0001_init.sql 里全是 `CREATE TABLE/INDEX IF NOT EXISTS`，**完全幂等**，
//   重复执行不会报错、也不会改动已有结构。
// * 只在 users 表**不存在**时才执行，因此它**不可能**悄悄改动一个已经建好的库。
//   未来的结构变更仍然走显式的 `wrangler d1 migrations apply`（新增迁移文件），
//   不会因为这段代码而被自动应用。
// * D1 的 batch 在单个事务里执行，要么全成要么全不成。

import type { Logger } from "../lib/logger";
import schemaSql from "../../migrations/0001_init.sql";

/**
 * 把一份 SQL 脚本拆成单条语句。
 *
 * D1 的 `prepare()` 只接受一条语句（多语句要交给 `exec()`，但它不支持事务、
 * 也不返回结果），所以这里自己做拆分。不能简单地 `split(";")` —— 必须跳过
 * 字符串字面量里的分号与 `--` 行注释，否则将来有人在默认值里写个分号就会
 * 把语句切碎。
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      buf += ch;
      if (ch === "'") {
        // SQL 里 '' 表示一个字面量单引号，不算结束
        if (sql[i + 1] === "'") {
          buf += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (ch === "'") {
      inString = true;
      buf += ch;
      continue;
    }

    // -- 行注释：整行丢弃（保留换行，避免把两行粘成一行）
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      buf += "\n";
      continue;
    }

    if (ch === ";") {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = "";
      continue;
    }

    buf += ch;
  }

  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** 基础结构语句，来自 migrations/0001_init.sql（与 wrangler 用的是同一份）。 */
export const SCHEMA_STATEMENTS: readonly string[] = splitStatements(schemaSql);

/** 判断基础结构是否已存在（用 users 表作为探针）。 */
async function schemaPresent(db: D1Database): Promise<boolean> {
  try {
    await db.prepare("SELECT 1 FROM users LIMIT 1").first();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 表不存在 = 库是空的，需要建表；其余错误（连接失败、权限不足）原样抛出，
    // 不能当成「空库」去建表。
    if (/no such table/i.test(msg)) return false;
    throw err;
  }
}

/**
 * 确保基础结构存在。返回 true 表示这次真的建了表（即此前是空库）。
 *
 * 同一 isolate 内由 bootstrap 的 seedPromise 保证只执行一次；不同 isolate
 * 并发进入也无所谓 —— 语句都是 IF NOT EXISTS。
 */
export async function ensureSchema(db: D1Database, logger: Logger): Promise<boolean> {
  if (await schemaPresent(db)) return false;

  logger.warn("检测到空数据库，正在按 migrations/0001_init.sql 建表", {
    语句数: SCHEMA_STATEMENTS.length,
  });
  await db.batch(SCHEMA_STATEMENTS.map((stmt) => db.prepare(stmt)));
  logger.info("数据库结构已创建", { 语句数: SCHEMA_STATEMENTS.length });
  return true;
}
