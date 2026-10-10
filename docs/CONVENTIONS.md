# 移植约定（Go → Cloudflare Workers）

本文件是**移植工作的内部规范**，描述本仓库中 TypeScript 代码的组织方式与约定。
新加页面时请严格照此办理，否则会出现风格撕裂或难以排查的运行期错误。

## 目录结构

```
src/
  index.ts          Worker 入口：中间件链 + 路由挂载 + scheduled
  context.ts        AppEnv（Hono 的 Bindings / Variables 类型）
  env.ts            环境变量读取与校验（对应 internal/config）
  bootstrap.ts      首次请求时的惰性初始化（对应 main.go 里的 database.Seed）
  types.ts          领域模型（对应 internal/models/models.go）
  lib/              纯函数工具（对应 internal/utils）
  db/               D1 数据访问层（对应 internal/services）
  auth/             会话与 CSRF（对应 internal/auth）
  middleware/       HTTP 中间件（对应 internal/middleware）
  views/            服务端渲染（对应 web/templates）
  routes/           路由处理器（对应 internal/handlers）
```

## 视图层

### 基本写法

所有 HTML 用 `hono/html` 的 `html` 标签模板拼装，**默认自动转义**：
插值的普通字符串会被转义，只有 `html\`\`` 或 `raw()` 的产物原样输出。

```ts
import { html } from "./html";

export const fooView: View<FooData> = {
  content(pd) {
    return html`<div class="card">${pd.data.title}</div>`;
  },
  // 可选：页面级脚本
  scripts(pd) {
    return html`<script src="/static/js/foo.js?v=${pd.assetVersion}" defer></script>`;
  },
};
```

规则：

- 条件渲染用三元 + 空片段：`${cond ? html`…` : html``}`，或 `${cond ? html`…` : ""}`。
- 列表渲染直接插数组：`${items.map((it) => html`…`)}`。
- 需要原样输出 HTML 时用 `raw(x)` —— **只有**在内容已经由可信来源生成时才可用。
- 不要手写 `&amp;` / `&lt;`：模板会自动处理。反之也不要依赖手写转义。
- 视图只做展示，不做数据访问、不发请求。

### 页面骨架

`renderPage(c, status, title, active, data, view)` 会把 `view.content(pd)` 嵌进
`layout(pd, content, scripts)`。`pd` 里有：

| 字段 | 含义 |
| --- | --- |
| `title` / `active` | 页面标题 / 侧边栏高亮标识 |
| `user` | 当前登录用户（未登录为 `undefined`） |
| `csrf` | 当前请求应使用的 CSRF 令牌 |
| `query` | `URLSearchParams`（当前查询参数） |
| `allowRegistration` | 自助注册开关的最终生效值 |
| `updateEnabled` | 在线更新是否已配置 |
| `version` / `year` / `env` / `appName` | 页脚与徽标用 |
| `assetVersion` | 静态资源内容指纹，**所有 /static/ 的 URL 都要带 `?v=`** |
| `data` | 页面自己的业务数据 |

侧边栏高亮标识取值：`dashboard` `products` `categories` `suppliers`
`stock-in` `stock-out` `stock-adjust` `movements` `low-stock` `reports`
`users` `update` `maintenance`。

### 公共片段

`src/views/ui.ts` 提供 `alertError` / `alertInfo` / `alertWarning` /
`alertSuccess` / `fieldError` / `passwordInput` / `textInput` / `strengthMeter`；
`src/views/partials.ts` 提供 `pagination(pg, query)` / `empty({...})` / `flash()`。

分页链接必须带上「不含 page 的当前查询串」，否则用户搜索后翻页会丢筛选条件：

```ts
pagination(pg, currentQueryWithoutPage(c))
```

## 路由层

### 模块形态

每个领域一个文件，导出一个 `Hono<AppEnv>` 子应用：

```ts
import { Hono } from "hono";
import type { AppEnv } from "../context";

export const productRoutes = new Hono<AppEnv>();

productRoutes.get("/products", async (c) => { ... });
```

`src/index.ts` 负责 `app.route("/", xxxRoutes)` 挂载。**不要**在领域文件里
修改 `src/index.ts`。

### 依赖获取

```ts
const cfg = c.get("cfg");       // 配置
const store = c.get("store");   // 数据访问层
const logger = c.get("logger"); // 日志
const user = c.get("user");     // 当前用户（可能 undefined）
```

### 辅助函数（`src/routes/helpers.ts`）

`render` / `redirectWith` / `redirectBack` / `currentQueryWithoutPage` /
`serverError` / `notFoundPage` / `businessErrorMessage` /
`formValue` / `formRaw` / `formInt` / `formFloat` / `formBool` / `formId` / `formValues`。

**表单一律通过 `formValue` 等辅助函数读取**（它们内部走 `readForm`，会复用
CSRF 中间件已经解析好的表单）。**不要**直接调用 `c.req.formData()` /
`c.req.parseBody()` —— 请求体只能消费一次，第二次会拿到空表单。

### 错误处理

业务错误统一用 `src/lib/errors.ts` 的 `AppError`：

```ts
import { isErrorCode, isAppError, stripCodePrefix } from "../lib/errors";

try {
  await store.doThing(...);
} catch (err) {
  if (isErrorCode(err, "notFound")) return notFoundPage(c);
  if (isAppError(err)) {
    setError(c, businessErrorMessage(err));
    return redirectBack(c, "/fallback", "", "");
  }
  return serverError(c, err);
}
```

### 权限

- 全局已挂 `requireAuth`（`src/index.ts` 里的 `appRoutes`），登录后路由无需重复。
- 需要写权限的路由在**处理器内部**判断（要给出中文提示），用
  `roleCanWrite(user.role)`；仅管理员用 `roleCanManageUsers(user.role)`。
  参考原版 `handler.canWrite` / `handler.canManageUsers` 的写法。
- 只有管理员可访问的路由组，可以在 `src/index.ts` 挂载时加 `requireRole("admin")`。

### CSV 导出

用 `src/lib/csv.ts` 的 `csvResponse(filename, header, rows)`。**必须**在数据被
截断时把事实写进文件（参考原版 `ListProductsForExport` 的 `truncated`）。

## 数据访问层

`store` 的方法见 `src/db/*.ts` 的 `declare module "./store"` 块。
**新增 db 领域文件后必须在 `src/db/index.ts` 里 import 一次**，否则原型方法
不会被挂载，且类型检查发现不了。

D1 没有可交互事务，检查 + 写入要合并成一条带守卫的 SQL，或用 `db.batch([...])`。

## 时间与格式化

- 数据库统一存 UTC ISO 字符串；展示按 UTC+8。
- `src/lib/time.ts`：`formatDateTime` / `formatDate` / `relativeTime` /
  `parseLocalDate` / `startOfDayUtc` / `localDateString` …
- `src/lib/format.ts`：`formatMoney`（¥ + 千分位）/ `formatNumber` / `percent` /
  `ratio` / `barHeight` / `truncate` …

## 交付要求

1. 每个文件顶部写清「对应原 Go 版哪个文件」。
2. 保留原版注释中解释**为什么**的部分（那些是踩过坑的记录），不要只留
   「做了什么」。译文用中文，保持原有语气。
3. 新增/修改后必须跑通 `npx tsc --noEmit`。
4. 不要改动 `src/index.ts`、`src/views/render.ts`、`src/views/layout.ts`、
   `src/middleware/index.ts`、`src/routes/helpers.ts` 的既有导出签名。
