// 时间处理 —— 对应原 Go 版 internal/utils/format.go 与 services/time.go。
//
// 约定：数据库统一以 UTC 的 ISO-8601 字符串存储，界面按 UTC+8 展示。

/** 界面展示时区偏移（毫秒）。 */
export const TZ_OFFSET_MS = 8 * 3600_000;

/** 当前时间的 UTC ISO 字符串（所有写入的统一时间源）。 */
export function nowUtcIso(): string {
  return new Date().toISOString();
}

/** 把 UTC 时间转换为展示时区的 Date（其 getUTC* 即为本地时间）。 */
function toLocal(d: Date): Date {
  return new Date(d.getTime() + TZ_OFFSET_MS);
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 输出 YYYY-MM-DD HH:mm:ss（UTC+8）。 */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "-";
  const t = toLocal(d);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  );
}

/** 输出 YYYY-MM-DD HH:mm（UTC+8）。 */
export function formatTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "-";
  const t = toLocal(d);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`
  );
}

/** 输出 YYYY-MM-DD（UTC+8）。 */
export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "-";
  const t = toLocal(d);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 可空时间：从未登录时给出友好文案。 */
export function formatDateTimePtr(iso: string | null | undefined): string {
  if (!iso) return "从未登录";
  return formatDateTime(iso);
}

/** 相对时间描述，例如「3 分钟前」。 */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return "-";
  const diff = now.getTime() - d.getTime();
  if (diff < 0) return formatDateTime(iso);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDate(iso);
}

/** 展示时区的今天零点，返回 UTC 时间。 */
export function startOfDayUtc(now: Date = new Date()): Date {
  const local = toLocal(now);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 0, 0, 0, 0) - TZ_OFFSET_MS);
}

/** 展示时区当月的第一天零点，返回 UTC 时间。 */
export function startOfMonthUtc(now: Date = new Date()): Date {
  const local = toLocal(now);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1, 0, 0, 0, 0) - TZ_OFFSET_MS);
}

/** 把 YYYY-MM-DD 解析为展示时区的零点（返回 UTC Date）；非法输入返回 null。 */
export function parseLocalDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0) - TZ_OFFSET_MS);
  // 回读校验，挡住 2026-02-31 这类不存在的日期
  const back = toLocal(dt);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return dt;
}

/** 在展示时区上加减天数，返回 UTC ISO 字符串。 */
export function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** 展示时区下的 YYYY-MM-DD。 */
export function localDateString(d: Date): string {
  const t = toLocal(d);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 展示时区下的 MM-DD。 */
export function localShortDate(d: Date): string {
  const t = toLocal(d);
  return `${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 展示时区下的 YYYYMMDD-HHmmss（备份文件名用）。 */
export function localStamp(d: Date = new Date()): string {
  const t = toLocal(d);
  return (
    `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}-` +
    `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}`
  );
}

/** 展示时区下的 YYYYMMDD_HHmm（导出文件名用）。 */
export function localExportStamp(d: Date = new Date()): string {
  const t = toLocal(d);
  return (
    `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}_` +
    `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}`
  );
}

/** 展示时区的年份。 */
export function localYear(d: Date = new Date()): number {
  return toLocal(d).getUTCFullYear();
}
