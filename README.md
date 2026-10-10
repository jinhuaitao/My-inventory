# 库存管理系统 · Cloudflare Workers 版

原项目是一套 Go + SQLite 的单二进制库存管理系统。本目录是它的 **Cloudflare Workers 移植版**：
把 Go 的 `net/http` + `html/template` + SQLite 换成 **Hono + Workers Assets + D1**，
界面、路由、业务规则、安全语义与中文文案全部保留。

- 技术栈：TypeScript 5.7（strict）· Hono 4 · Cloudflare Workers · D1 · R2 · Workers Assets · Cron Triggers
- **要求 wrangler 4**（`devDependencies` 里是 `^4`）。wrangler 3.x 的配置校验强制要求 D1 绑定带
  `database_id`，用不了下面的自动供给；wrangler 4 起该字段可选，部署时按名字自动创建并绑定。
- 页面：20 个服务端渲染页面（仪表盘 / 商品 / 分类 / 供应商 / 出入库 / 盘点 / 流水 / 预警 / 报表 / 用户 / 个人中心 / 数据维护）
- 无需构建步骤：`wrangler` 直接打包 `src/index.ts`（esbuild），静态资源由 Workers Assets 下发

---

## 1. 快速开始（本地）

```bash
npm install

# 建本地库结构（写入 .wrangler/state，不碰线上）
npm run db:migrate:local

# 起本地服务（默认 http://localhost:8787）
npm run dev
```

`.dev.vars` 里已经放好本地开发所需的变量（含默认管理员密码 `Admin@12345`）。
默认管理员只在**用户表为空**时创建，演示数据只在**商品表为空**时写入。

---

## 2. 部署到 Cloudflare

### 2.1 先搞清 D1 的两种绑定写法

`wrangler.jsonc` 里的 D1 绑定有两种合法写法，**但绝对不能写占位字符串**：

| 写法 | 配置 | 行为 |
| --- | --- | --- |
| **自动供给**（默认，推荐） | 只写 `binding` + `database_name`，**不写 `database_id`** | 部署时先按名字查找，找不到就自动创建并绑定 |
| 手动指定 | 额外写 `"database_id": "<UUID>"` | 直接用这个 ID，不做任何创建 |

> ⚠️ **不要写 `"database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"` 这类占位符。**
> wrangler 只看「字段有没有值」，有值就认为「已完全指定」，于是把占位符当真实 ID 发给 API，
> 报 `binding DB of type d1 must have a valid database_id specified [code: 10021]`。
> 要么留空（走自动供给），要么填真实 UUID。

R2 同理：`bucket_name` 指向的桶不存在时会自动创建；想手动建就先跑
`npx wrangler r2 bucket create inventory-backups`。

**首次使用 R2 的账号要先在 Dashboard 的 R2 页面点一次开通条款**，否则自动创建会失败 ——
这是最常见的部署失败原因之一。

**表结构会在首次请求时自动创建。** 与原版一致（Go 版把 `schema.sql` 用 `//go:embed`
嵌进二进制，启动时执行 `database.Migrate`），Worker 发现库是空的就会按
`migrations/0001_init.sql` 建好全部 10 张表。所以**即使忘了跑迁移，站点也不会 500**。

> 注意这只覆盖**空库**。以后新增的结构变更仍然要显式执行 `wrangler d1 migrations apply`
> —— 自动建表只在 `users` 表不存在时触发，**不可能**悄悄改动一个已有数据的库。

### 2.2 方式一：Git 连接 Workers Builds（推荐）

把仓库推到 GitHub 后，在 Cloudflare Dashboard 建一个 Worker 并连接该仓库，构建设置填：

| 配置项 | 值 |
| --- | --- |
| Build command | `npm install` |
| Deploy command | `npm run deploy:ci` |

`deploy:ci` 的内容是「部署 + 跑线上迁移」：

```jsonc
"deploy:ci": "wrangler deploy && wrangler d1 migrations apply inventory --remote"
```

**顺序不能颠倒**：首次部署时 D1 是 `wrangler deploy` 阶段才被创建出来的，
迁移必须排在它后面，否则会报「找不到数据库」。

> ⚠️ **`name` 必须与 Workers Builds 的项目名完全一致。**
> wrangler 只认配置里写的名字，Cloudflare 不会用项目名覆盖它。
> 两者不一致时会**再建一个 Worker** —— 你打开的是新 Worker 的空库，数据却还在原来那个里，
> 症状是「部署成功了，但数据全没了」。
>
> 另外注意：通过 Dashboard 部署时，自动创建出来的 D1 / R2 **ID 不会写回仓库**。
> 之后若想改用本地 `wrangler deploy`，要先去 Dashboard 把 ID 复制进配置，
> 否则 wrangler 会当成「没有 ID」再创建一套新资源。

### 2.3 方式二：本地命令行部署

```bash
# 1) 登录
npx wrangler login

# 2) 建 D1（想走自动供给可跳过这步）
npx wrangler d1 create inventory

# 3) 建 R2 备份桶（不需要备份功能可跳过，并把 wrangler.jsonc 的 r2_buckets 段注释掉）
npx wrangler r2 bucket create inventory-backups

# 4) 部署（会顺带创建 D1 / R2）
npm run deploy

# 5) 执行线上迁移 —— 必须在部署之后，否则数据库还不存在
npm run db:migrate:remote

# 6) 写入管理员密码（强烈建议；不写则用内置的 Admin@12345）
npx wrangler secret put INVENTORY_ADMIN_PASSWORD   # 强密码

# 7) 检查 wrangler.jsonc 里的 INVENTORY_BASE_URL 已改成你的实际地址
```

部署后访问 `/healthz` 应返回 `{"status":"ok","version":"..."}`。

> **登录后第一件事：改掉默认管理员密码。** 默认账号 `admin` / `Admin@12345`。

### 2.4 唯一需要设置的密钥：`INVENTORY_ADMIN_PASSWORD`

| 密钥 | 生产环境要求 | 漏掉的后果 |
| --- | --- | --- |
| `INVENTORY_ADMIN_PASSWORD` | 强烈建议设置 | 能正常启动，但管理员密码是内置的 `Admin@12345`；生产环境会打 warn 日志 |

```bash
# 写入（需要先 npx wrangler login）
npx wrangler secret put INVENTORY_ADMIN_PASSWORD
```

用 Workers Builds 部署、本机没登录 wrangler 的，可以直接在
**Dashboard → 该 Worker → Settings → Variables and Secrets → Add**，
类型选 **Secret**（不是 Text）。**设置后立即生效，不需要重新部署。**

三个容易踩的点：

1. **不要写进 `wrangler.jsonc` 的 `vars`。** `vars` 会提交进仓库、在 Dashboard 里也是明文；
   只有 Secret 是加密存储的。
2. **密钥按 Worker 隔离。** 必须设在 `name` 对应的那个 Worker 上 —— 如果名字不一致，
   你会给一个 Worker 配好密钥、却在访问另一个。
3. **改密码要趁早。** 默认账号 `admin` / `Admin@12345` 是公开的；首次登录后立刻改掉，
   或直接通过上面的 Secret 指定强密码。

> **关于 `INVENTORY_SESSION_SECRET`（已移除）**
> 旧版本要求生产环境必须显式设置这个会话密钥，否则拒绝启动。核对原 Go 实现后确认：
> 它是一份**从未被读取的死配置** —— 原版 `internal/auth` 里没有任何 HMAC/签名逻辑，
> 移植版的 `SessionManager` 也只读 `sessionLifetimeMs` / `rememberLifetimeMs`，
> `src/lib/crypto.ts` 不导出任何签名原语。会话令牌本身是 256 位随机串（存哈希、比对用
> 定时安全比较），安全性不依赖这个密钥。因此该变量及其生产守卫已整体删除，
> **不会再出现「每次部署都要重新设置」的问题**。若你的 Dashboard 里还留着这条 Secret，
> 删掉即可，不影响任何功能。

### 2.5 部署排错

| 报错 | 原因与处理 |
| --- | --- |
| `服务配置错误，无法启动：INVENTORY_SESSION_SECRET…` | **旧版本**的报错。该变量已移除，请更新到最新代码后重新部署；同时可删掉 Dashboard 里的同名 Secret |
| 日志出现「生产环境仍在使用内置的默认管理员密码」 | 没设 `INVENTORY_ADMIN_PASSWORD`，管理员是 `Admin@12345`。立刻设置并重新部署 |
| `binding DB of type d1 must have a valid database_id specified [code: 10021]` | 配置里 `database_id` 是占位字符串。删掉该字段（走自动供给）或填真实 UUID |
| `DB bindings must have a "database_id" field` | 只在 `--dry-run` 下出现，属**正常现象**：dry-run 不联网、无法创建资源，所以回填不了 ID。真实部署（`wrangler deploy`）不受影响 |
| `d1_databases[0] bindings must have a "database_id" field but got {...}` | wrangler 3.x 的配置校验要求该字段存在。升级到 `wrangler@4`，或在 deploy 命令后加 `--experimental-provision` |
| `数据库初始化失败，请检查 D1 绑定与迁移是否已执行` | 空库会自动建表，所以出现这句说明**建表本身失败了**（D1 不可用、权限不足等）。去 `wrangler tail` 看同一条日志里的「错误」字段 |
| `数据库尚未初始化：D1 里没有任何表…` | 建表没跑成（多见于旧版本）。执行 `npm run db:migrate:remote` |
| 部署成功但页面报 500 / 「表不存在」 | 同第一条。另外把 Deploy command 改成 `npm run deploy:ci`，让每次部署都带上迁移 |
| `服务配置错误，无法启动：没有绑定 D1 数据库（环境变量 DB）` | `wrangler.jsonc` 的 `d1_databases` 段缺失或被注释掉了 |
| 部署成功但数据「消失」了 | `name` 与 Dashboard 项目名不一致，实际部署到了另一个 Worker |
| 迁移或供给报权限错误 | 构建用的 API Token 缺 D1 权限。Dashboard → 该 Worker → Settings → Build → API token，给它加上 D1 的编辑权限；或改为在本地手动执行迁移 |
| R2 自动创建失败 | 账号还没开通 R2。先去 Dashboard 的 R2 页面点一次开通 |

---

## 3. 配置项

全部通过环境变量注入，前缀 `INVENTORY_`。非敏感项写在 `wrangler.jsonc` 的 `vars`，
敏感项用 `wrangler secret put` 写入。

### 基础

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `INVENTORY_APP_NAME` | `库存管理系统` | 站点名称 |
| `INVENTORY_VERSION` | `1.0.0` | 版本号。用于 `/healthz` 的返回值，以及静态资源 URL 的内容指纹 |
| `INVENTORY_ENV` | `development` | `production` 时启用 JSON 日志、默认不写演示数据 |
| `INVENTORY_BASE_URL` | `http://localhost:8080` | 对外访问地址。**必须改成 https 地址**，否则 Secure cookie 与 HSTS 不生效 |
| `INVENTORY_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### 会话与登录安全

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `INVENTORY_SESSION_LIFETIME` | `12h` | 会话有效期 |
| `INVENTORY_REMEMBER_LIFETIME` | `720h` | 「记住我」有效期，不得短于会话有效期 |
| `INVENTORY_MAX_LOGIN_ATTEMPTS` | `5` | 同一「账号 + 来源 IP」的失败上限；同一账号跨来源的兜底上限是它的 10 倍 |
| `INVENTORY_LOCKOUT_WINDOW` | `15m` | 失败计数的统计窗口 |

时长写法兼容 Go 的格式（`30s` / `15m` / `12h`），额外支持 `d`（如 `30d`）。

### 账号与注册

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `INVENTORY_ALLOW_REGISTRATION` | `true` | 自助注册的**初始**状态；页面上一旦设置过就以页面为准 |
| `INVENTORY_DEFAULT_ROLE` | `viewer` | 自助注册者的默认角色（`viewer` / `manager`）。**填 `admin` 会让服务拒绝启动** |
| `INVENTORY_ADMIN_USERNAME` | `admin` | 初始化管理员用户名 |
| `INVENTORY_ADMIN_EMAIL` | `admin@example.com` | 初始化管理员邮箱 |
| `INVENTORY_ADMIN_PASSWORD` | `Admin@12345` | 初始化管理员密码。生产环境仍用默认值时会在启动日志里打 warn 告警 |
| `INVENTORY_SEED_DEMO_DATA` | 随环境（production 为 `false`） | 数据库为空时是否写入内置演示数据 |

### 备份

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `INVENTORY_BACKUP_KEEP` | `14` | 自动命名备份的保留份数，`0` 表示不自动清理 |
| `INVENTORY_BACKUP_PREFIX` | `backups/` | R2 对象键前缀（替代原版的 `INVENTORY_BACKUP_DIR`） |

---

## 4. 与原 Go 版的差异

移植的原则是「语义不变，实现随平台」。下面每一处差异都是 Workers 环境逼出来的，
不是设计偏好 —— 逐条列清楚，免得运维按原版的经验操作时踩坑。

### 4.1 数据存储

| 原版 | Workers 版 |
| --- | --- |
| SQLite 文件（`data/inventory.db`，WAL 模式） | D1（托管 SQLite） |
| 事务 `BEGIN` / `COMMIT`，`_txlock=immediate` 串行化冷启动 | **没有可交互事务**，改用「把判断写进 SQL 的 WHERE 子句」+ 幂等写入 |
| 时间存 `DATETIME` | 时间存 ISO-8601 UTC 文本（字典序即时间序），界面按 UTC+8 展示 |
| `//go:embed schema.sql` + 启动时 `database.Migrate()` | **同样是首次请求自动建表**（见 2.1）。`.sql` 由 wrangler 的 Text 规则打进 bundle，与 `wrangler d1 migrations apply` 读的是同一份文件 |

原版靠 `_txlock=immediate` 把「判空 + 写入」锁在一个事务里；D1 没有这个能力，
因此所有 check-then-act 都被改写成单条带守卫的语句：

- 初始化管理员：`INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM users)`
- 演示数据：`INSERT OR IGNORE` + 流水上的 `NOT EXISTS` 守卫
- 商品删除：`DELETE ... WHERE id = ? AND NOT EXISTS (SELECT 1 FROM stock_movements WHERE product_id = ?)`
- **出入库 / 盘点：乐观锁 + 重试**（最多 3 次）。流水 INSERT 用
  `WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND quantity = ?)` 守卫，
  紧接着 `UPDATE products SET quantity = ? WHERE id = ? AND quantity = ?`；
  两者观察的是同一个修改前库存，任何一次并发写入都会让其中一条语句影响 0 行，从而触发重试。

### 4.2 密码

| 原版 | Workers 版 |
| --- | --- |
| bcrypt | 新密码用 **PBKDF2-SHA256**（Web Crypto，10 万次迭代，16 字节盐，32 字节密钥） |
| — | **旧 bcrypt 摘要仍可校验**：用 `bcryptjs` 验证，登录成功后自动重新哈希为 PBKDF2 |

Workers 里跑不了 bcrypt（没有原生模块），所以新密码换算法；但**已有账号不会失效** ——
登录时识别 `$2a$` / `$2b$` / `$2y$` 前缀走 bcrypt 校验，成功即透明升级。
因此从 Go 版迁过来的库可以直接用，用户无感。

### 4.3 备份与恢复

原版是「`VACUUM INTO` 产出一个 `.db` 文件 → 重启时 `rename` 换入」。
Workers 没有文件系统，D1 又是托管服务，这两步都做不到，改成**逻辑快照**：

| 环节 | 原版 | Workers 版 |
| --- | --- | --- |
| 备份产物 | 单个 `.db` 文件 | R2 里两个对象：`<名>.json`（结构化快照）+ `<名>.sql`（可导入脚本） |
| 完整性校验 | 打开备份文件跑 `PRAGMA integrity_check` + 统计各表行数 | 写完后**回读并重新解析**，核对行数一致 |
| 恢复 | 上传 `.db` → 暂存 → 重启时换入 | 选站内备份或上传 `.json` → 暂存 → 点「立即生效」直接恢复 |
| 回滚点 | `<db>.before-restore-<时间戳>` | 恢复前自动生成一份安全备份 |

**已知限制：站内备份上限 20000 行。** D1 单条语句的绑定参数有上限，插入必须按列数切块，
行数一大请求就会超时。超出上限时程序**直接报错**而不是悄悄截断 —— 一份残缺的备份比没有备份更危险。
更大的库请用命令行导出：

```bash
npx wrangler d1 export inventory --remote --output=backup.sql
```

恢复是「先清空再写回」，中途失败会留下不完整的库，因此程序在动手前**强制**先做一份安全备份；
安全备份失败则中止恢复。

### 4.4 系统更新（已移除）

原版会下载安装包、校验 SHA-256、原子替换可执行文件、重启进程 —— 这些在 Worker 上**本质上做不到**：
不能替换自己的代码，也没有可写的文件系统。移植时曾用「GitHub Releases API 检查版本 +
Deploy Hook 触发重新部署」来近似，但实测下来价值不足而维护成本明显：

- 版本检查只对**源码自建**的部署有意义；从 Dashboard 连 Git 的 Workers Builds 本身就会在
  推送时自动重新部署，再叠一层「检查更新」是重复的。
- 「立即更新」依赖一个额外的 `INVENTORY_UPDATE_DEPLOY_HOOK` Secret，等于为了一个按钮
  多养一份凭据。
- 版本比较逻辑（`src/lib/semver.ts`）与原版并非逐行等价，属于要长期维护的独立代码面。

因此**整个功能已删除**：`src/routes/update.ts`、`src/views/update.ts`、`src/lib/semver.ts`
以及全部 `INVENTORY_UPDATE_*` 变量与导航入口都不再存在，`/admin/update` 返回 404。

升级方式改为标准做法：

```bash
# 本地部署的：重新部署即可（Workers 会做灰度、可回滚）
npm run deploy:ci

# 连了 Git 的：推送到默认分支，Workers Builds 自动构建部署

# 回滚到上一个版本
npx wrangler versions list
npx wrangler rollback <版本号>
```

`INVENTORY_VERSION` 仍保留，但它现在只做两件事：`/healthz` 的返回值，以及静态资源
URL 的内容指纹（见 4.5）。

### 4.5 静态资源与缓存

原版把 `web/static` 嵌进二进制，用 `embed.FS` 的编译期指纹做缓存失效。
这里用 Workers Assets，指纹改为**运行时计算**：启动后取一次 `app.css` / `app.js` 的内容
SHA-256（前 8 位十六进制），拼成 `?v=<指纹>` 加到每个 `/static/` URL 上。
内容一变 URL 就变，因此 `public/_headers` 里可以放心用一年期长缓存 + `immutable`。

### 4.6 定时任务

原版的 `runCleanupLoop` 是一个常驻 goroutine；这里用 **Cron Triggers**
（`wrangler.jsonc` 的 `triggers.crons`，默认每小时）触发 `scheduled` 处理器，
清理过期会话、登录记录与找回密码记录。不需要一个进程 24 小时守着。

### 4.7 没有移植的东西

| 原版能力 | 处理方式 |
| --- | --- |
| `INVENTORY_ADDR` / `INVENTORY_DATA_DIR` / `INVENTORY_DB_PATH` | 由 Workers 与 D1 取代，不再存在 |
| `INVENTORY_BACKUP_DIR` | 换成 `INVENTORY_BACKUP_PREFIX`（R2 键前缀） |
| `INVENTORY_UPDATE_*` 与「系统更新」页面 | **整体删除**（含版本检查、Deploy Hook 触发更新、等待生效页）。Worker 无法替换自身代码，且 Workers Builds 推送即部署，这层已无必要。详见 4.4 |
| `INVENTORY_TRUSTED_PROXIES` | 不再需要。来源 IP 直接读 `CF-Connecting-IP`（Cloudflare 写入，客户端伪造无效） |
| `--purge-demo-data --purge-legacy-demo` 命令行 | 未提供。站内清理只认 `is_demo` 标记；「SKU 命中但无标记」的旧数据会在页面上列出来，确认后手工执行 SQL 处理 |
| 每日定时备份的 systemd timer / `/etc/periodic/daily` | 未提供。需要的话在 `wrangler.jsonc` 里加一条 Cron Trigger 调用备份接口 |
| 部署脚本（`deploy/`、`inventory.sh`） | 由 `wrangler deploy` 与 Workers Builds 取代 |

---

## 5. 从 Go 版迁移数据

数据库结构是一致的（表名、列名、约束语义都保留），因此有两条路：

**路线 A：整库导出为 SQL，导入 D1（推荐）**

```bash
# 在原服务器上（Go 版目录）
sqlite3 data/inventory.db .dump > inventory-go.sql

# 只保留数据部分也行：D1 侧已经用 migrations 建好表结构了
npx wrangler d1 execute inventory --remote --file=inventory-go.sql
```

注意两点：

1. 原版的 `password_hash` 是 bcrypt 摘要，**可以直接导入** —— 登录时会被透明升级为 PBKDF2。
2. 时间列在 Go 版是 `DATETIME` 文本，格式与这里期望的 ISO-8601 接近；
   若格式不一致，界面上的时间展示可能错位，导入后抽查几条即可。

**路线 B：用站内备份**

在 Go 版页面「数据维护」里下载一份备份，把它的行数据转成本站快照格式
（`format` / `version` / `tables` 三段，见 `src/db/backup.ts`），
再通过「数据维护 → 上传备份文件」导入。适合数据量小的场景。

迁移完成后记得：**改管理员密码**、把 `INVENTORY_SEED_DEMO_DATA` 设为 `false`、
清一次演示数据。

---

## 6. 目录结构

```
src/
  index.ts            Worker 入口：中间件链、路由表、探针、Cron 处理器
  env.ts              配置读取与校验（对应 Go 的 internal/config）
  types.ts            领域模型（对应 internal/models）
  context.ts          Hono 的 Env / Variables 类型
  bootstrap.ts        惰性初始化（首次请求时建管理员 / 写演示数据）
  lib/                工具库：crypto / time / format / validate / csv / flash
                      / pagination / sql / request / form / errors / logger
                      / backup（R2 对象层）
  db/                 数据访问层，对应 internal/services + internal/database
                      store.ts 是基类，其余文件用「声明合并 + 原型挂载」扩展它
                      schema.ts 空库自动建表（对应 //go:embed schema.sql + Migrate）
                      ⚠️ 新增领域文件后必须在 db/index.ts 里 import 一次
  auth/session.ts     会话与 CSRF（对应 internal/auth）
  middleware/         中间件链（对应 internal/middleware）
  views/              服务端渲染视图（对应 web/templates）
  routes/             路由与处理器（对应 internal/handlers）
  sql.d.ts            让 TS 接受 `import sql from "./x.sql"`（由 wrangler 的 Text 规则实现）
migrations/           D1 表结构（对应 internal/database/schema.sql）
                      0001_init.sql 同时被「wrangler 迁移」与「运行时自愈」使用
public/               静态资源（对应 web/static），_headers 写缓存策略
docs/CONVENTIONS.md   移植规范（视图层规则、命名约定、交付要求）
```

---

## 7. 常用命令

```bash
npm run dev              # 本地开发（wrangler dev）
npm run deploy           # 部署到 Cloudflare（自动创建缺失的 D1 / R2）
npm run deploy:ci        # 部署 + 跑线上迁移（Workers Builds 的 Deploy command 用这个）
npm run typecheck        # tsc --noEmit
npm run db:migrate:local # 本地执行迁移
npm run db:migrate:remote# 线上执行迁移（必须在 deploy 之后）
npm run tail             # 实时查看线上日志
```

---

## 8. 安全设计

以下机制与原版逐条对应，没有因为换平台而削弱：

- **会话**：令牌只存在 httpOnly cookie 里，库里存的是 SHA-256 摘要；改密码 / 禁用账号会立即失效相关会话。
- **CSRF**：已登录用「会话内令牌」比对，未登录用 double-submit cookie；比较用定长比较，避免时序侧信道。
- **登录限流**：两个维度 —— 同一「账号 + IP」达到 `INVENTORY_MAX_LOGIN_ATTEMPTS` 即锁定；
  同一账号跨 IP 的兜底上限是它的 10 倍。被限流期间的尝试只记录（`blocked=1`）不计入失败，
  否则攻击者持续发请求就能不断刷新计数窗口，让锁定永远不过期。
- **账号枚举**：登录失败统一提示「用户名或密码错误」；账号不存在时也走一次等价耗时的密码校验
  （`burnPasswordCheck`），不通过响应时间泄露账号是否存在。
- **开放重定向**：登录后的回跳地址只接受站内路径。
- **CSV 注入**：导出时对以 `=` `+` `-` `@` 开头的单元格加前缀，防止 Excel 把数据当公式执行。
- **响应头**：CSP（`script-src 'self'`，因此页面里没有任何内联脚本）、`X-Frame-Options: DENY`、
  `X-Content-Type-Options: nosniff`、生产环境 + HTTPS 时启用 HSTS。
- **上传**：multipart 请求在 CSRF 中间件里就先按 `Content-Length` 卡体积、并要求已登录，
  与令牌从哪里来无关（早期版本把这段塞进「令牌来自表单」的分支里，等于给了绕过口子）。
- **备份文件名**：来自 URL 与表单的名字做严格白名单校验（不含路径分隔符、不以点开头），
  防止越界访问。

---

## 9. 许可

与原项目一致，见 `LICENSE`。
