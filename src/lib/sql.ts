// SQL 辅助 —— 对应原 Go 版 services/store.go 里的 likePattern 等。

/**
 * 把搜索关键词包装成 %kw%，并转义 LIKE 的通配符（\ % _）。
 *
 * 必须配合 SQL 中的 ESCAPE '\' 使用：否则搜 "100%" 会错误命中所有以
 * "100" 开头的记录，搜 "a_b" 会把 _ 当单字符通配 —— 结果看着像 bug。
 */
export function likePattern(kw: string): string {
  const escaped = kw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return `%${escaped}%`;
}

/** SQL 中 LIKE 的转义子句（写作 ESCAPE '\'）。 */
export const LIKE_ESCAPE = "ESCAPE '\\'";

/** 把可空 ID 转成绑定参数（0 或 null → null），避免外键约束报错。 */
export function nullableId(id: number | null | undefined): number | null {
  if (id === null || id === undefined || id <= 0) return null;
  return id;
}

/** 生成 n 个以逗号分隔的 SQL 占位符。 */
export function placeholders(n: number): string {
  if (n <= 0) return "";
  return new Array(n).fill("?").join(",");
}

/** 布尔 → 0/1。 */
export function boolInt(v: boolean): number {
  return v ? 1 : 0;
}

/** 判断 D1 错误是否为唯一约束冲突。 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err) return false;
  const msg = String((err as Error).message ?? err).toLowerCase();
  return msg.includes("unique constraint") || (msg.includes("constraint failed") && msg.includes("unique"));
}

/**
 * 从唯一约束错误信息中提取冲突字段，例如 users.username。
 * 返回形如 "users.username" 的片段，供上层翻译成友好提示。
 */
export function uniqueField(err: unknown): string {
  if (!err) return "";
  const msg = String((err as Error).message ?? err);
  const marker = "UNIQUE constraint failed:";
  const i = msg.indexOf(marker);
  if (i < 0) return "";
  const rest = msg.slice(i + marker.length).trim();
  const j = rest.indexOf(" ");
  return (j > 0 ? rest.slice(0, j) : rest).trim();
}

/**
 * 把唯一约束冲突翻译成对用户友好的提示。
 */
export function conflictMessage(field: string): string {
  if (field.includes("username")) return "该用户名已被注册";
  if (field.includes("email")) return "该邮箱已被注册";
  if (field.includes("sku")) return "该 SKU 已存在";
  if (field.includes("name")) return "该名称已存在";
  return "记录已存在";
}

/** D1 的 batch 结果里取受影响行数。 */
export function changedRows(result: D1Result<unknown> | undefined): number {
  if (!result) return 0;
  const meta = result.meta as { changes?: number } | undefined;
  return meta?.changes ?? 0;
}
