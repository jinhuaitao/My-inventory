// @cloudflare/vitest-plugin：在 workerd（真实 Workers 运行时）里跑测试，
// D1/R2/环境变量全部由 wrangler.jsonc 自动发现生成，SQL 方言零 mock。
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
