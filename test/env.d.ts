// 把项目手写的 Env 接口合并进 vitest-plugin 期望的全局 Cloudflare.Env，
// 让 `import { env } from "cloudflare:test"` 直接带上 DB/BACKUPS/vars 类型。
// （未来若运行 `wrangler types` 生成 worker-configuration.d.ts，此文件可删。）
import type { Env as AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}

export {};
