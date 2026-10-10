// 页面渲染入口 —— 对应原 Go 版 internal/utils/render.go + handlers.render。

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../context";
import { getFlash, type Flash } from "../lib/flash";
import { localYear } from "../lib/time";
import type { User } from "../types";
import { assetVersion } from "./assets";
import { html, type Html } from "./html";
import { layout } from "./layout";

/**
 * 所有页面共享的根上下文 —— 对应 Go 版的 handlers.PageData。
 *
 * 页面自己的业务数据放在 data 里，其余都是骨架需要的公共字段。
 */
export interface PageData<T = unknown> {
  title: string;
  appName: string;
  /** 侧边栏高亮标识。 */
  active: string;
  user: User | undefined;
  flash: Flash | null;
  csrf: string;
  currentPath: string;
  query: URLSearchParams;
  env: string;
  allowRegistration: boolean;
  version: string;
  year: number;
  /** 静态资源内容指纹。 */
  assetVersion: string;
  data: T;
}

/** 一个页面 = 内容片段（+ 可选的页面级脚本）。 */
export interface View<T> {
  content(pd: PageData<T>): Html;
  scripts?(pd: PageData<T>): Html;
}

/**
 * 渲染页面并返回响应。
 *
 * 渲染先在内存中完成，只有成功后才写出，避免出错时返回半截页面。
 */
export async function renderPage<T>(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  title: string,
  active: string,
  data: T,
  view: View<T>,
): Promise<Response> {
  const pd = await buildPageData(c, title, active, data);

  const body = await layout(pd, view.content(pd), view.scripts ? view.scripts(pd) : null);

  // 页面内容与会话绑定（用户名、权限、业务数据），禁止浏览器与中间代理缓存，
  // 避免后退/重放把上一位用户的数据留在共享缓存里。
  c.header("Cache-Control", "no-store");
  return c.html(body, status);
}

async function buildPageData<T>(
  c: Context<AppEnv>,
  title: string,
  active: string,
  data: T,
): Promise<PageData<T>> {
  const cfg = c.get("cfg");
  const url = new URL(c.req.url);

  return {
    title,
    appName: cfg.appName,
    active,
    user: c.get("user"),
    flash: getFlash(c),
    csrf: c.get("csrfToken"),
    currentPath: url.pathname,
    query: url.searchParams,
    env: cfg.env,
    allowRegistration: await registrationEnabled(c),
    version: cfg.version,
    year: localYear(),
    assetVersion: await assetVersion(c.env, cfg.version),
    data,
  };
}

/**
 * 读取「是否开放自助注册」的最终生效值（请求内缓存）。
 *
 * 环境变量给的是默认值，管理员可在用户管理页改写；因此必须查库，
 * 不能直接用 cfg.allowRegistration —— 否则管理员关掉注册后，
 * 登录页仍然挂着注册入口。
 */
export async function registrationEnabled(c: Context<AppEnv>): Promise<boolean> {
  const cached = c.get("registration");
  if (cached !== undefined) return cached;

  const cfg = c.get("cfg");
  const state = await c.get("store").registrationState(cfg.allowRegistration);
  c.set("registration", state.enabled);
  return state.enabled;
}

/** 渲染错误页（404 / 500）。 */
export function renderError(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  title: string,
): Promise<Response> {
  return renderPage(c, status, title, "", null, {
    content: () =>
      html`<div class="empty-state">
  <div class="empty-icon">
    <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><circle cx="12" cy="16.4" r="0.9" fill="currentColor" stroke="none"/></svg>
  </div>
  <p class="empty-title">${title}</p>
  <p class="empty-hint">${status === 404 ? "链接可能已经失效，或者记录已被删除。" : "服务器开小差了，请稍后重试。"}</p>
  <a href="/" class="btn btn-primary">返回首页</a>
</div>`,
  });
}
