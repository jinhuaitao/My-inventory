// 表单读取 —— 对应原 Go 版 auth.ProvidedCSRFToken 里对
// multipart / urlencoded 两种编码的分流处理。
//
// 关键点：**请求体只能读一次**。原版 Go 的 ParseForm / ParseMultipartForm
// 会把结果缓存在 http.Request 上，重复调用是幂等的；Web 平台没有这层缓存，
// 谁先读了 body，后面的人就只能拿到空表单。
//
// 因此全站统一走 readForm()：解析结果缓存在请求上下文里，
// CSRF 中间件与业务处理器拿到的必然是同一份数据。

import type { Context } from "hono";
import type { AppEnv } from "../context";

const FORM_CONTENT_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data"];

/** 判断请求是否携带表单体。 */
export function isFormRequest(contentType: string | null | undefined): boolean {
  const ct = (contentType ?? "").toLowerCase();
  return FORM_CONTENT_TYPES.some((t) => ct.includes(t));
}

/** 判断请求是否为 multipart/form-data。 */
export function isMultipartForm(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("multipart/form-data");
}

/**
 * 读取并缓存表单。非表单请求返回空 FormData（而不是抛异常）。
 */
export async function readForm(c: Context<AppEnv>): Promise<FormData> {
  const cached = c.get("form");
  if (cached) return cached;

  if (!isFormRequest(c.req.header("Content-Type"))) {
    const empty = new FormData();
    c.set("form", empty);
    return empty;
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    // 体积超限、编码损坏等情况：当成空表单，由调用方走「缺少必填项」分支，
    // 而不是让整个请求 500。
    form = new FormData();
  }
  c.set("form", form);
  return form;
}

/** 取表单里的文本字段（文件字段返回空串）。 */
export function formString(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

/** 取表单里的文本字段并去掉首尾空白。 */
export function formTrimmed(form: FormData, key: string): string {
  return formString(form, key).trim();
}

/** 取表单里的文件字段。 */
export function formFile(form: FormData, key: string): File | null {
  const v = form.get(key);
  return v instanceof File && v.size > 0 ? v : null;
}
