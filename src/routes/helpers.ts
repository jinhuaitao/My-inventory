// 处理器公共辅助 —— 对应原 Go 版 internal/handlers/handler.go 里的
// render / redirectWith / redirectBack / businessError / serverError 等。

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../context";
import { businessError } from "../lib/errors";
import { formString, formTrimmed, readForm } from "../lib/form";
import { setFlash, type FlashType } from "../lib/flash";
import { renderError, renderPage, type View } from "../views/render";

/** 渲染页面（薄封装，保持与原版 handler.render 一致的调用形态）。 */
export function render<T>(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  title: string,
  active: string,
  data: T,
  view: View<T>,
): Promise<Response> {
  return renderPage(c, status, title, active, data, view);
}

/** 重定向并附带一条提示消息。 */
export function redirectWith(
  c: Context<AppEnv>,
  target: string,
  type: FlashType | "",
  message: string,
): Response {
  if (type !== "") setFlash(c, type, message);
  return c.redirect(target, 303);
}

/**
 * 重定向回来源页（优先使用 referer，否则回到 fallback）。
 *
 * 只接受同源 referer：否则一个精心构造的 Referer 就能把用户弹到站外，
 * 属于开放重定向。
 */
export function redirectBack(
  c: Context<AppEnv>,
  fallback: string,
  type: FlashType | "",
  message: string,
): Response {
  let target = fallback;
  const ref = c.req.header("Referer");
  if (ref) {
    try {
      const u = new URL(ref);
      const self = new URL(c.req.url);
      if (u.host === self.host) target = u.pathname + u.search;
    } catch {
      // 非法 Referer：忽略，用 fallback
    }
  }
  return redirectWith(c, target, type, message);
}

/**
 * 当前请求的查询参数（去掉 page），供分页链接复用。
 *
 * 列表页如果给模板传空串，用户搜索后翻到第 2 页时筛选条件会全部丢失，
 * 看起来就像「搜索没生效」。
 */
export function currentQueryWithoutPage(c: Context<AppEnv>): string {
  const u = new URL(c.req.url);
  u.searchParams.delete("page");
  return u.searchParams.toString();
}

/** 记录错误并渲染 500 页面。 */
export function serverError(c: Context<AppEnv>, err: unknown): Promise<Response> {
  c.get("logger").error("请求处理失败", {
    路径: c.req.path,
    方法: c.req.method,
    错误: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });
  return renderError(c, 500, "服务器错误");
}

/** 渲染 404 页面。 */
export function notFoundPage(c: Context<AppEnv>): Promise<Response> {
  return renderError(c, 404, "页面不存在");
}

/** 业务错误 → 用户可读提示。 */
export function businessErrorMessage(err: unknown): string {
  return businessError(err);
}

// ---------------------------------------------------------------------------
// 表单读取辅助
// ---------------------------------------------------------------------------

/** 读取表单文本字段（去首尾空白）。 */
export async function formValue(c: Context<AppEnv>, key: string): Promise<string> {
  return formTrimmed(await readForm(c), key);
}

/** 读取表单文本字段（保留原始空白，密码等字段用）。 */
export async function formRaw(c: Context<AppEnv>, key: string): Promise<string> {
  return formString(await readForm(c), key);
}

/** 读取整数字段，解析失败返回默认值。 */
export async function formInt(c: Context<AppEnv>, key: string, fallback: number): Promise<number> {
  const raw = await formValue(c, key);
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
}

/** 读取浮点字段，解析失败返回默认值。 */
export async function formFloat(c: Context<AppEnv>, key: string, fallback: number): Promise<number> {
  const raw = await formValue(c, key);
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 读取复选框状态。 */
export async function formBool(c: Context<AppEnv>, key: string): Promise<boolean> {
  const v = (await formValue(c, key)).toLowerCase();
  return v === "on" || v === "true" || v === "1" || v === "yes";
}

/** 读取可选的外键 ID，空值或非正数返回 null。 */
export async function formId(c: Context<AppEnv>, key: string): Promise<number | null> {
  const raw = await formValue(c, key);
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** 收集表单值为 map，用于校验失败时回填。 */
export async function formValues(
  c: Context<AppEnv>,
  keys: string[],
): Promise<Record<string, string>> {
  const form = await readForm(c);
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = formTrimmed(form, k);
  return out;
}
