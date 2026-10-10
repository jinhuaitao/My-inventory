// 一次性提示消息（Flash）—— 对应原 Go 版 internal/utils/flash.go。
//
// 通过 cookie 在重定向之间传递，读取一次后立即失效。

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const FLASH_COOKIE = "inventory_flash";

export type FlashType = "success" | "error" | "warning" | "info";

export interface Flash {
  type: FlashType;
  message: string;
}

/** 把 flash 类型收敛到白名单：cookie 内容不可信，未知取值一律降级为 info。 */
function sanitizeFlashType(t: string): FlashType {
  return t === "success" || t === "error" || t === "warning" || t === "info" ? t : "info";
}

/** 写入一条提示消息（存活 60 秒，读取一次后立即失效）。 */
export function setFlash(c: Context, type: FlashType, message: string): void {
  setCookie(c, FLASH_COOKIE, `${type}|${message}`, {
    path: "/",
    maxAge: 60,
    httpOnly: true,
    sameSite: "Lax",
  });
}

export const setSuccess = (c: Context, msg: string) => setFlash(c, "success", msg);
export const setError = (c: Context, msg: string) => setFlash(c, "error", msg);
export const setWarning = (c: Context, msg: string) => setFlash(c, "warning", msg);
export const setInfo = (c: Context, msg: string) => setFlash(c, "info", msg);

/** 读取并清除提示消息。 */
export function getFlash(c: Context): Flash | null {
  const raw = getCookie(c, FLASH_COOKIE);
  if (!raw) return null;

  // 立即失效，保证只展示一次
  deleteCookie(c, FLASH_COOKIE, { path: "/", httpOnly: true, sameSite: "Lax" });

  const idx = raw.indexOf("|");
  if (idx < 0) return null;
  const type = sanitizeFlashType(raw.slice(0, idx));
  const message = raw.slice(idx + 1);
  if (message === "") return null;
  return { type, message };
}
