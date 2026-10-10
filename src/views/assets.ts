// 静态资源内容指纹 —— 对应原 Go 版 web/embed.go 的 StaticVersion。
//
// 为什么需要它：静态资源是按长期缓存（Cache-Control: immutable, max-age=1 年）
// 下发的，浏览器在一年内不会重新验证。如果不给 URL 加内容指纹，二进制更新后
// 浏览器会继续用缓存里的旧 JS / CSS —— 页面文案是新的、功能是旧的，
// 而且用户清缓存之前一直如此。
//
// Go 版在编译期把资源内容哈希成常量。Workers 上没有编译期资源访问，
// 因此改为运行期首次使用时计算，并缓存在模块作用域（同一个 isolate 只算一次）。

import { toHex } from "../lib/crypto";
import type { Env } from "../env";

const FINGERPRINT_FILES = ["/static/css/app.css", "/static/js/app.js"];

let cached: string | null = null;
let pending: Promise<string> | null = null;

/** 计算（并缓存）静态资源指纹。 */
export function assetVersion(env: Env, fallback: string): Promise<string> {
  if (cached !== null) return Promise.resolve(cached);
  if (!pending) {
    pending = compute(env, fallback)
      .then((v) => {
        cached = v;
        pending = null;
        return v;
      })
      .catch(() => {
        pending = null;
        return fallback;
      });
  }
  return pending;
}

async function compute(env: Env, fallback: string): Promise<string> {
  if (!env.ASSETS) return fallback;

  const parts: string[] = [];
  for (const path of FINGERPRINT_FILES) {
    const res = await env.ASSETS.fetch(new Request(`https://assets.invalid${path}`));
    if (!res.ok) continue;
    const buf = await res.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    parts.push(toHex(new Uint8Array(digest)).slice(0, 8));
  }
  return parts.length > 0 ? parts.join("-") : fallback;
}
