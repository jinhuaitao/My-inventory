// 数字与字符串格式化 —— 对应原 Go 版 internal/utils/format.go。

function groupThousands(s: string): string {
  const n = s.length;
  if (n <= 3) return s;
  let out = "";
  const pre = n % 3;
  if (pre > 0) {
    out += s.slice(0, pre);
    if (n > pre) out += ",";
  }
  for (let i = pre; i < n; i += 3) {
    out += s.slice(i, i + 3);
    if (i + 3 < n) out += ",";
  }
  return out;
}

/** 带千分位的金额，例如 ¥12,345.60。 */
export function formatMoney(v: number): string {
  const neg = v < 0;
  const abs = Math.abs(v);
  const [intPart, decPart] = abs.toFixed(2).split(".");
  const out = `¥${groupThousands(intPart)}.${decPart}`;
  return neg ? `-${out}` : out;
}

/** 不带货币符号的千分位金额。 */
export function formatMoneyPlain(v: number): string {
  return formatMoney(v).replace(/^-?¥/, (m) => (m.startsWith("-") ? "-" : ""));
}

/** 带千分位的整数。 */
export function formatNumber(v: number): string {
  const neg = v < 0;
  const out = groupThousands(String(Math.abs(Math.trunc(v))));
  return neg ? `-${out}` : out;
}

/** 保留 n 位小数。 */
export function formatFloat(v: number, n: number): string {
  return v.toFixed(n);
}

/** 字节数格式化，例如 "14.2 MB"。 */
export function formatBytes(n: number): string {
  if (n < 0) return "-";
  const unit = 1024;
  if (n < unit) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let i = -1;
  while (value >= unit && i < units.length - 1) {
    value /= unit;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** 百分比（0-100）。 */
export function percent(part: number, total: number): number {
  if (total === 0) return 0;
  return (part / total) * 100;
}

/** part/total，限制在 [0,1]，用于进度条宽度。 */
export function ratio(part: number, total: number): number {
  if (total <= 0) return 0;
  const r = part / total;
  if (r < 0) return 0;
  if (r > 1) return 1;
  return r;
}

/** 把数值换算为柱状图高度百分比（0-100），极小值也保证可见。 */
export function barHeight(v: number, max: number): number {
  if (max <= 0 || v <= 0) return 0;
  const h = (v / max) * 100;
  return h < 2 ? 2 : h;
}

/** 首字符（支持中文），用于头像。 */
export function initial(s: string): string {
  const t = (s ?? "").trim();
  if (t === "") return "?";
  return Array.from(t)[0];
}

/**
 * 按字符（而非字节）截断字符串并追加省略号。
 * max <= 0 时返回空串：放任负数走到切片会抛异常，格式化函数不该把参数错误升级成崩溃。
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  const runes = Array.from(s);
  if (runes.length <= max) return s;
  if (max === 1) return runes[0];
  return runes.slice(0, max - 1).join("") + "…";
}

/** 空字符串时返回默认值。 */
export function defaultString(v: string | null | undefined, fallback: string): string {
  return v === null || v === undefined || String(v).trim() === "" ? fallback : v;
}

/** 整数取绝对值。 */
export function absInt(v: number): number {
  return v < 0 ? -v : v;
}

/** 数字加千分位（整数部分）。 */
export { groupThousands };
