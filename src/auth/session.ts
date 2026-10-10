// 会话管理与 CSRF 防护 —— 对应原 Go 版 internal/auth/session.go。

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../context";
import { hashToken, randomToken, secureCompare } from "../lib/crypto";
import { isFormRequest, readForm } from "../lib/form";
import { clientIp, userAgent } from "../lib/request";
import { nowUtcIso } from "../lib/time";
import { isActiveUser } from "../db/sessions";
import type { Store } from "../db/store";
import { isHttps, isProduction, type Config } from "../env";
import type { Session, User } from "../types";

// ---------------------------------------------------------------------------
// Cookie / 表单字段名
// ---------------------------------------------------------------------------

/** 会话 cookie（HttpOnly，JS 读不到）。 */
export const SESSION_COOKIE_NAME = "inventory_session";
/** 与 JS 共享的 CSRF cookie（双提交校验，JS 需要读取）。 */
export const CSRF_COOKIE_NAME = "inventory_csrf";
/** 表单中 CSRF 隐藏字段名。 */
export const CSRF_FORM_FIELD = "_csrf";
/** CSRF 请求头名（供 AJAX 使用）。 */
export const CSRF_HEADER_NAME = "X-CSRF-Token";

/**
 * 全站 multipart 请求的体积上限。
 *
 * ⚠️ Workers 平台本身在边缘就把请求体限制在 100MB（Free/Pro）以内，
 * 这个值只是应用层的二次兜底 —— 与其让超限请求打到解析阶段，
 * 不如在 CSRF 校验时就按 Content-Length 直接拒绝。
 */
export const MAX_UPLOAD_BYTES = 512 << 20;

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
  ) {}

  /** 为用户建立新会话，并写入 cookie。 */
  async create(c: Context<AppEnv>, user: User, remember: boolean): Promise<Session> {
    const token = randomToken(32);
    const csrf = randomToken(32);

    const lifetimeMs = remember ? this.cfg.rememberLifetimeMs : this.cfg.sessionLifetimeMs;
    const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
    const createdAt = nowUtcIso();
    const ua = userAgent(c.req.raw);
    const ip = clientIp(c.req.raw);

    const id = await this.store.createSession({
      userId: user.id,
      tokenHash: await hashToken(token),
      csrfToken: csrf,
      expiresAt,
      userAgent: ua,
      ip,
    });

    const maxAge = Math.floor(lifetimeMs / 1000);
    this.setCookie(c, SESSION_COOKIE_NAME, token, maxAge);
    this.setCookie(c, CSRF_COOKIE_NAME, csrf, maxAge);

    return {
      id,
      userId: user.id,
      tokenHash: await hashToken(token),
      csrfToken: csrf,
      expiresAt,
      createdAt,
      userAgent: ua,
      ip,
    };
  }

  /**
   * 依据请求 cookie 加载会话与用户。
   * 返回 null 表示「未登录」，属于正常情况。
   */
  async load(c: Context<AppEnv>): Promise<{ session: Session; user: User } | null> {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (!token) return null;

    const found = await this.store.getSessionUser(await hashToken(token));
    if (!found) return null;

    // 过期会话视为未登录，并顺手清掉，避免过期行越积越多
    if (!(new Date(found.session.expiresAt).getTime() > Date.now())) {
      await this.store.deleteSession(found.session.tokenHash);
      return null;
    }

    // 被禁用的账号立即失效
    if (!isActiveUser(found.user)) {
      await this.store.deleteSession(found.session.tokenHash);
      return null;
    }

    return found;
  }

  /** 销毁当前会话并清除 cookie。 */
  async destroy(c: Context<AppEnv>): Promise<void> {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (token) {
      await this.store.deleteSession(await hashToken(token));
    }
    this.clearCookie(c, SESSION_COOKIE_NAME);
    this.clearCookie(c, CSRF_COOKIE_NAME);
  }

  /** 统一设置 cookie 安全属性。 */
  private setCookie(c: Context<AppEnv>, name: string, value: string, maxAge: number): void {
    setCookie(c, name, value, {
      path: "/",
      maxAge,
      // CSRF cookie 需要被页面 JS 读取（AJAX 请求头），会话 cookie 则必须挡住 JS
      httpOnly: name === SESSION_COOKIE_NAME,
      secure: this.secure(),
      sameSite: "Lax",
    });
  }

  private clearCookie(c: Context<AppEnv>, name: string): void {
    deleteCookie(c, name, {
      path: "/",
      httpOnly: name === SESSION_COOKIE_NAME,
      secure: this.secure(),
      sameSite: "Lax",
    });
  }

  private secure(): boolean {
    return isProduction(this.cfg) && isHttps(this.cfg);
  }
}

/** 保持 CSRF cookie 与会话中的令牌同步（未登录时用双提交 cookie）。 */
export function writeCsrfCookie(c: Context<AppEnv>, token: string, cfg: Config): void {
  setCookie(c, CSRF_COOKIE_NAME, token, {
    path: "/",
    maxAge: Math.floor(cfg.rememberLifetimeMs / 1000),
    httpOnly: false, // 需允许页面 JS 读取，用于 AJAX 请求头
    secure: isProduction(cfg) && isHttps(cfg),
    sameSite: "Lax",
  });
}

// ---------------------------------------------------------------------------
// CSRF 令牌提取与校验
// ---------------------------------------------------------------------------

/**
 * 取出客户端提交的 CSRF 令牌：先看请求头，再看表单字段。
 *
 * 表单读取统一走 readForm()，它会缓存解析结果 —— 否则业务处理器
 * 之后再读 body 只会拿到空表单（请求体只能消费一次）。
 */
export async function providedCsrfToken(c: Context<AppEnv>): Promise<string> {
  const header = c.req.header(CSRF_HEADER_NAME);
  if (header) return header;

  if (!isFormRequest(c.req.header("Content-Type"))) return "";
  const form = await readForm(c);
  return String(form.get(CSRF_FORM_FIELD) ?? "");
}

/**
 * 校验请求携带的 CSRF 令牌是否与会话中的一致。
 * @returns 空串表示通过，否则为提示文案。
 */
export async function checkCsrf(c: Context<AppEnv>, session: Session | undefined): Promise<string> {
  if (!session) return "会话不存在";

  const provided = await providedCsrfToken(c);
  if (provided === "") return "缺少 CSRF 令牌";
  if (!secureCompare(provided, session.csrfToken)) return "CSRF 令牌校验失败";
  return "";
}
