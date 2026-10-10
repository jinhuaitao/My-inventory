// 密码学工具 —— 对应原 Go 版 internal/utils/security.go 与
// internal/services/user.go 中的密码工具。
//
// 关键差异：Cloudflare Workers 上无法使用 bcrypt（无 C 扩展、且纯 JS 版
// 的 CPU 开销过高），因此新密码一律用 Web Crypto 的 PBKDF2-SHA256 存储。
// 为了让「从原 Go 版迁移过来的 bcrypt 历史摘要」仍能登录，这里保留了
// bcrypt 校验分支，并在校验成功后由调用方透明升级为 PBKDF2。

import bcrypt from "bcryptjs";

const encoder = new TextEncoder();

/** PBKDF2 迭代次数。 */
export const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32; // 字节
const SALT_LEN = 16; // 字节

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 生成 n 字节的密码学安全随机令牌（十六进制字符串）。 */
export function randomToken(nBytes: number): string {
  const buf = new Uint8Array(nBytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export function toHex(buf: Uint8Array): string {
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 令牌的 SHA-256 摘要。数据库中只保存摘要，泄露也无法直接复用令牌。 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toHex(new Uint8Array(digest));
}

/** 以恒定时间比较两个字符串，避免时序侧信道。 */
export function secureCompare(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  // 长度不同时也走完整比较，只把结果置否，避免长度本身成为信号。
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PBKDF2
// ---------------------------------------------------------------------------

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** 密码摘要的存储格式：pbkdf2$sha256$<迭代次数>$<salt>$<dk>。 */
export function formatPbkdf2Hash(salt: Uint8Array, dk: Uint8Array, iterations = PBKDF2_ITERATIONS): string {
  return `pbkdf2$sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(dk)}`;
}

/** 生成密码摘要。 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = new Uint8Array(SALT_LEN);
  crypto.getRandomValues(salt);
  const dk = await pbkdf2(plain, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN);
  return formatPbkdf2Hash(salt, dk);
}

interface ParsedPbkdf2 {
  iterations: number;
  salt: Uint8Array;
  dk: Uint8Array;
}

function parsePbkdf2Hash(hash: string): ParsedPbkdf2 | null {
  const parts = hash.split("$");
  if (parts.length !== 5) return null;
  if (parts[0] !== "pbkdf2" || parts[1] !== "sha256") return null;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  const salt = fromBase64Url(parts[3]);
  const dk = fromBase64Url(parts[4]);
  if (!salt || !dk) return null;
  return { iterations, salt, dk };
}

/** 是否为 bcrypt 摘要（$2a$ / $2b$ / $2y$）。 */
export function isBcryptHash(hash: string): boolean {
  return /^\$2[aby]\$/.test(hash);
}

/** 校验明文密码与摘要是否匹配。支持 PBKDF2 与历史 bcrypt 摘要。 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  const parsed = parsePbkdf2Hash(hash);
  if (parsed) {
    const dk = await pbkdf2(plain, parsed.salt, parsed.iterations, parsed.dk.length);
    return secureCompare(toHex(dk), toHex(parsed.dk));
  }
  if (isBcryptHash(hash)) {
    try {
      return bcrypt.compareSync(plain, hash) === true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 摘要是否需要升级（重新哈希后写回）。
 *
 * bcrypt 历史摘要与迭代次数低于当前标准的 PBKDF2 摘要都应升级；
 * 调用方在登录成功后据此透明地重写为最新格式。
 */
export function needsRehash(hash: string): boolean {
  if (isBcryptHash(hash)) return true;
  const parsed = parsePbkdf2Hash(hash);
  if (!parsed) return true;
  return parsed.iterations < PBKDF2_ITERATIONS;
}

/**
 * 对固定摘要执行一次等量校验，结果一定为 false。
 *
 * 登录时如果账号不存在就跳过哈希计算，响应会比「密码错误」快几十毫秒，
 * 攻击者可以用计时差异枚举存在的用户名。调用本函数把两条路径的计算量拉平。
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("dummy-computation-only");
  return dummyHashPromise;
}

export async function burnPasswordCheck(plain: string): Promise<boolean> {
  const h = await dummyHash();
  await verifyPassword(h, plain);
  return false;
}
