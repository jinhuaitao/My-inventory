# 库存管理系统 · Cloudflare Workers 版

原项目是一套 Go + SQLite 的单二进制库存管理系统。本目录是它的 **Cloudflare Workers 移植版**：
把 Go 的 `net/http` + `html/template` + SQLite 换成 **Hono + Workers Assets + D1**，
界面、路由、业务规则、安全语义与中文文案全部保留。

- 技术栈：TypeScript 5.7（strict）· Hono 4 · Cloudflare Workers · D1 · R2 · Workers Assets · Cron Triggers
- 页面：21 个服务端渲染页面（仪表盘 / 商品 / 分类 / 供应商 / 出入库 / 盘点 / 流水 / 预警 / 报表 / 用户 / 个人中心 / 系统更新 / 数据维护）
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

```bash
# 1) 登录
npx wrangler login

# 2) 创建 D1 数据库，把输出的 database_id 填进 wrangler.jsonc
npx wrangler d1 create inventory

# 3) 创建 R2 备份桶（「数据维护」页要用；不需要备份功能可跳过并注释掉
#    wrangler.jsonc 里的 r2_buckets 段）
npx wrangler r2 bucket create inventory-backups

# 4) 执行线上迁移
npm run db:migrate:remote

# 5) 写入必须的密钥
npx wrangler secret put INVENTORY_SESSION_SECRET   # openssl rand -hex 32
npx wrangler secret put INVENTORY_ADMIN_PASSWORD   # 强密码

# 6) 检查 wrangler.jsonc 里的 INVENTORY_BASE_URL 已改成你的实际地址

# 7) 部署
npm run deploy
```

部署后访问 `/healthz` 应返回 `{"status":"ok","version":"..."}`。

> **登录后第一件事：改掉默认管理员密码。** 默认账号 `admin` / `Admin@12345`。

---

## 3. 配置项

全部通过环境变量注入，前缀 `INVENTORY_`。非敏感项写在 `wrangler.jsonc` 的 `vars`，
敏感项用 `wrangler secret put` 写入。

### 基础

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `INVENTORY_APP_NAME` | `库存管理系统` | 站点名称 |
| `INVENTORY_VERSION` | `1.0.0` | 当前版本号，系统更新页用它和 Release tag 比较 |
| `INVENTORY_ENV` | `development` | `production` 时启用 JSON 日志、要求显式会话密钥、默认不写演示数据 |
| `INVENTORY_BASE_URL` | `http://localhost:8080` | 对外访问地址。**必须改成 https 地址**，否则 Secure cookie 与 HSTS 不生效 |
| `INVENTORY_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### 会话与登录安全

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `INVENTORY_SESSION_SECRET` | 开发环境自动生成 | **生产环境必填**，至少 16 字符 |
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
| `INVENTORY_ADMIN_PASSWORD` | `Admin@12345` | 初始化管理员密码 |
| `INVENTORY_SEED_DEMO_DATA` | 随环境（production 为 `false`） | 数据库为空时是否写入内置演示数据 |

### 备份与更新

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `INVENTORY_BACKUP_KEEP` | `14` | 自动命名备份的保留份数，`0` 表示不自动清理 |
| `INVENTORY_BACKUP_PREFIX` | `backups/` | R2 对象键前缀（替代原版的 `INVENTORY_BACKUP_DIR`） |
| `INVENTORY_UPDATE_ENABLED` | `true` | 是否启用在线更新 |
| `INVENTORY_UPDATE_REPO` | 空 | 更新仓库 `owner/repo`；留空则整个功能关闭 |
| `INVENTORY_UPDATE_INTERVAL` | `6h` | 自动检查间隔 |
| `INVENTORY_UPDATE_TOKEN` | 空 | 可选，访问私有仓库或规避 GitHub API 限流 |
| `INVENTORY_UPDATE_DEPLOY_HOOK` | 空 | **Workers 版新增**。填上 Deploy Hook 地址后「立即更新」才能一键触发部署 |

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

### 4.4 系统更新

原版会下载安装包、校验 SHA-256、原子替换可执行文件、重启进程。
Worker 不能替换自己的代码，因此：

- **检查更新照旧**：调 GitHub Releases API，语义化版本比较、发布说明截断、错误分类文案都保留；
  检查结果落在 `settings` 表里（原版存在内存中，而 Worker 的 isolate 随时会被回收）。
- **「立即更新」改为触发一次重新部署**：配置 `INVENTORY_UPDATE_DEPLOY_HOOK`
  （Cloudflare Workers Builds 的 Deploy Hook）后，按钮会 POST 该地址；
  未配置时只给出 `npx wrangler deploy` 的命令指引。
- **等待页的判据变了**：原版盯着 `/readyz` 能否连通，这里盯着 `/healthz` **报的版本号**。
  因为部署期间旧版本一直在正常服务，「能连通」会立刻成功、刷新后看到的还是旧版本 ——
  这正是原版注释里警告过的那个坑。`/healthz?expect=<版本>` 在版本没换过来之前一直返回 503。
- **回滚**：`npx wrangler versions list` + `npx wrangler rollback <版本号>`。

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
                      / semver（版本比较）/ backup（R2 对象层）
  db/                 数据访问层，对应 internal/services + internal/database
                      store.ts 是基类，其余文件用「声明合并 + 原型挂载」扩展它
                      ⚠️ 新增领域文件后必须在 db/index.ts 里 import 一次
  auth/session.ts     会话与 CSRF（对应 internal/auth）
  middleware/         中间件链（对应 internal/middleware）
  views/              服务端渲染视图（对应 web/templates）
  routes/             路由与处理器（对应 internal/handlers）
migrations/           D1 表结构（对应 internal/database/schema.sql）
public/               静态资源（对应 web/static），_headers 写缓存策略
docs/CONVENTIONS.md   移植规范（视图层规则、命名约定、交付要求）
```

---

## 7. 常用命令

```bash
npm run dev              # 本地开发（wrangler dev）
npm run deploy           # 部署到 Cloudflare
npm run typecheck        # tsc --noEmit
npm run db:migrate:local # 本地执行迁移
npm run db:migrate:remote# 线上执行迁移
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
