// 让 TypeScript 接受 `import sql from "./x.sql"`。
//
// 实际转换由 wrangler 的模块规则完成 —— 见 wrangler.jsonc 里的
// `rules: [{ type: "Text", globs: ["**/*.sql"] }]`：.sql 会被当成
// 纯文本字符串打进 bundle。

declare module "*.sql" {
  const content: string;
  export default content;
}
