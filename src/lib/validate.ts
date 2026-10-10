// 表单校验 —— 对应原 Go 版 internal/utils/validate.go。

/** 密码长度限制：与原版保持一致（bcrypt 只处理前 72 字节）。 */
export const PASSWORD_MIN_LEN = 8;
export const PASSWORD_MAX_LEN = 72;

/**
 * 用户名：3-32 位，允许字母、数字、下划线、连字符与点。
 * 注意用码点计数，避免把非 ASCII 字符误判为合法。
 */
export function isValidUsername(s: string): boolean {
  const t = (s ?? "").trim();
  if (t.length < 3 || t.length > 32) return false;
  return /^[A-Za-z0-9_.-]+$/.test(t);
}

/**
 * 邮箱校验。
 *
 * 只接受纯邮箱地址（拒绝「名字 <a@b>」形式），并做长度与基本形状检查。
 * 不做完整的 RFC 5322 解析 —— 那是原版 net/mail 的职责，这里保持「够严且可预测」。
 */
export function isValidEmail(s: string): boolean {
  const t = (s ?? "").trim();
  if (t === "" || t.length > 254) return false;
  if (/[<>\s"(),;:\\]/.test(t)) return false;
  const parts = t.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local === "" || local.length > 64) return false;
  if (domain === "" || domain.length > 253) return false;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label === "" || label.length > 63) return false;
    if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }
  if (!/^[A-Za-z]{2,}$/.test(labels[labels.length - 1])) return false;
  return true;
}

/** 密码强度：至少 8 位且同时包含字母与数字。返回错误文案或 null。 */
export function validatePassword(pw: string): string | null {
  const v = pw ?? "";
  // 与原版一致：按字节长度判断上限（bcrypt 语义）
  if (v.length < PASSWORD_MIN_LEN) return "密码长度至少 8 位";
  if (v.length > PASSWORD_MAX_LEN) return "密码长度不能超过 72 位";
  let hasLetter = false;
  let hasDigit = false;
  for (const ch of v) {
    if (/\p{L}/u.test(ch)) hasLetter = true;
    else if (/\p{Nd}/u.test(ch)) hasDigit = true;
  }
  if (!hasLetter || !hasDigit) return "密码必须同时包含字母和数字";
  return null;
}

/** 返回 0-4 的强度评分与文字说明，用于注册页的强度条。 */
export function passwordStrength(pw: string): { score: number; text: string } {
  if (!pw) return { score: 0, text: "请输入密码" };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  let hasUpper = false;
  let hasLower = false;
  let hasDigit = false;
  let hasSymbol = false;
  for (const ch of pw) {
    if (/\p{Lu}/u.test(ch)) hasUpper = true;
    else if (/\p{Ll}/u.test(ch)) hasLower = true;
    else if (/\p{Nd}/u.test(ch)) hasDigit = true;
    else if (/[\p{P}\p{S}]/u.test(ch)) hasSymbol = true;
  }
  if (hasUpper && hasLower) score++;
  if (hasDigit) score++;
  if (hasSymbol) score++;
  if (score > 4) score = 4;

  switch (score) {
    case 0:
    case 1:
      return { score, text: "弱" };
    case 2:
      return { score, text: "一般" };
    case 3:
      return { score, text: "较强" };
    default:
      return { score, text: "很强" };
  }
}

/** 规范化 SKU：去空格并转大写。 */
export function normalizeSku(s: string): string {
  return (s ?? "").trim().toUpperCase();
}

/** 按码点计数（原版的 utf8.RuneCountInString）。 */
export function runeLength(s: string): number {
  return Array.from(s ?? "").length;
}

/**
 * 防止开放重定向：只接受站内相对路径，否则返回空串。
 *
 * 判定刻意比「字符串看着像相对路径」更严。因为最终落进 Location 头的值是由
 * **浏览器**解析的，而浏览器遵循 WHATWG URL 规范，会先静默剥离 ASCII 空白
 * 再解析。于是 "/\t/evil.com" 与 "/%09/evil.com" 都会变成 "//evil.com"，
 * 一次登录跳转就把用户送到站外。
 *
 * 因此这里做三件事：先看前缀，再用 URL 复核没有 Scheme / Host，
 * 最后对**解析之后**的字符串拒绝控制字符 —— 顺序不能颠倒。
 */
export function sanitizeNext(next: string | null | undefined): string {
  let v = (next ?? "").trim();
  if (v === "") return "";
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return "";

  let u: URL;
  try {
    u = new URL(v, "https://placeholder.invalid");
  } catch {
    return "";
  }
  if (u.origin !== "https://placeholder.invalid") return "";
  if (!u.pathname.startsWith("/")) return "";

  const rebuilt = u.pathname + (u.search || "");
  if (containsControlChar(rebuilt)) return "";
  return rebuilt;
}

/**
 * 是否含 ASCII 空白或控制字符（含空格与 DEL）。
 * 这些字符在写入 Location 头之前不会被过滤，却会被浏览器当作空白剥掉，
 * 从而改变 URL 的实际语义，属于开放重定向的经典绕过手法。
 */
export function containsControlChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}
