// 每个测试文件开始前：把 migrations 全部打进测试 D1。
// isolatedStorage 默认开启 —— 之后每个用例都会重置回这个已迁移的快照，
// 因此用例之间天然隔离，不需要手工清库。
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { env } from "cloudflare:test";

const migrations = await readD1Migrations("migrations");

for (const m of migrations) {
  for (const query of m.queries) {
    await env.DB.prepare(query).run();
  }
}
