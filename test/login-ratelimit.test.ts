// 登录限流 —— P0 核心用例。
//
// 安全承诺（routes/auth.ts + db/security.ts）：
//   1. 同一 (identifier, ip) 连续失败满 maxLoginAttempts 次（默认 5）→ 锁定；
//   2. 锁定期内的尝试**不计入失败次数**（否则攻击者可把窗口无限顺延，
//      把别人的账号永久锁死）；
//   3. 锁定命中返回 429。
// 走完整 fetch 链路（authenticate → csrf → 路由），中间件改坏也会红。
import { describe, expect, it } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/index";

const ctx = createExecutionContext();

/** 走一次 GET /login 拿 double-submit cookie。 */
async function freshCsrfCookie(): Promise<string> {
  const res = await worker.fetch(
    new Request("https://test.example.com/login"),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/inventory_csrf=([^;]+)/);
  expect(m, "GET /login 应下发 csrf cookie").toBeTruthy();
  return `${m![0]}`;
}

async function tryLogin(cookie: string): Promise<Response> {
  return worker.fetch(
    new Request("https://test.example.com/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookie,
        "X-CSRF-Token": /inventory_csrf=([^;]+)/.exec(cookie)![1],
      },
      body: "identifier=nobody&password=wrong-password",
    }),
    env,
    ctx,
  );
}

describe("登录限流", () => {
  it("连续失败达到阈值后锁定并返回 429", async () => {
    const cookie = await freshCsrfCookie();

    // 前 5 次（默认 INVENTORY_MAX_LOGIN_ATTEMPTS=5）：密码错误 → 422/401，
    // 且每次失败都被计数（浏览器场景下失败响应也可能下发新 csrf cookie，
    // 这里保持首枚 cookie 即可 —— double-submit 只比对值）。
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const res = await tryLogin(cookie);
      lastStatus = res.status;
      expect([200, 401, 422, 429]).toContain(res.status);
      expect(res.status).not.toBe(500);
    }
    expect(lastStatus).not.toBe(429); // 第 5 次还没锁

    // 第 6 次：锁定 → 429，且文案带等待分钟数
    const locked = await tryLogin(cookie);
    expect(locked.status).toBe(429);
    const page = await locked.text();
    expect(page).toContain("登录尝试过于频繁");
  });

  it("锁定窗口内的尝试不计入失败次数（防无限顺延）", async () => {
    const cookie = await freshCsrfCookie();
    for (let i = 0; i < 5; i++) await tryLogin(cookie);
    const locked = await tryLogin(cookie);
    expect(locked.status).toBe(429);

    // 直接读安全表：锁定期内的这 1 次尝试不应出现在失败计数里
    // （recordBlockedLoginAttempt 只留痕、不进 failed_attempts 计数表）。
    const n = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE success = 0 AND blocked = 0`)
      .first<{ n: number }>();
    expect(n?.n).toBe(5); // 恰好 5 条：前 5 次失败，锁定期的尝试不计
  });
});
