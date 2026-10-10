// 数据维护页面 —— 对应原 Go 版 web/templates/maintenance/index.html。
//
// 与原版的差异（都是 Workers 环境逼出来的，不是设计偏好）：
//   * 「备份目录」换成 R2 键前缀：R2 没有目录，用键前缀做隔离。
//   * 「恢复」是两步：上传/选择 → 暂存 → 管理员确认后**在站内生效**。
//     原版第二步靠「重启服务」，Workers 没有可重启的进程；
//     好在快照恢复本身能在请求里跑完，所以第二步变成了一个按钮 ——
//     比原来还少一次等待，且中途可以反悔。
//   * 「操作说明」里关于 VACUUM INTO、cp、systemd timer 的三条经验全部作废，
//     换成 R2 与 wrangler 的对应做法。

import type { BackupEntry } from "../lib/backup";
import { formatBytes, formatNumber } from "../lib/format";
import { formatDateTime } from "../lib/time";
import type { PurgeResult } from "../db/seed";
import { html, type Html } from "./html";
import { alertError, alertWarning } from "./ui";
import type { View } from "./render";

/** 待恢复快照的概况。 */
export interface PendingInfo {
  /** 来源描述：站内备份名，或上传的文件名。 */
  source: string;
  /** 快照文件大小（字节）。 */
  size: number;
  /** 各表行数。 */
  counts: Record<string, number>;
  /** 暂存时间。 */
  uploadedAt: Date;
  /** 快照生成时间（快照文件内部记录）。 */
  createdAt: string;
  /** 生成快照时的应用版本。 */
  appVersion: string;
}

export interface MaintenanceData {
  /** R2 是否已绑定。未绑定时备份相关操作全部不可用。 */
  backupEnabled: boolean;
  backups: BackupEntry[];
  backupPrefix: string;
  backupKeep: number;
  /** 待恢复快照；没有则为 null。 */
  pending: PendingInfo | null;
  /** 演示数据清理的预演结果。 */
  preview: PurgeResult;
  hasDemoData: boolean;
  errors: Record<string, string>;
}

/** 快照里我们关心的几张表的展示名。 */
const COUNT_LABELS: Array<[string, string]> = [
  ["products", "商品"],
  ["stock_movements", "库存流水"],
  ["categories", "分类"],
  ["suppliers", "供应商"],
  ["users", "用户"],
];

/** 把行数渲染成「商品 12 条、分类 4 个」这样的一行文字。 */
function countSummary(counts: Record<string, number>): Html {
  const parts = COUNT_LABELS.filter(([key]) => counts[key] !== undefined).map(
    ([key, label]) => `${label} ${formatNumber(counts[key])}`,
  );
  if (parts.length === 0) return html`—`;
  return html`${parts.join(" · ")}`;
}

export const maintenanceView: View<MaintenanceData> = {
  content(pd) {
    const { backupEnabled, backups, backupPrefix, backupKeep, pending, preview, hasDemoData, errors } =
      pd.data;

    return html`<div class="page">

  <div class="page-head">
    <div>
      <h2 class="page-title">数据维护</h2>
      <p class="page-desc">
        备份与恢复数据、清理内置演示数据。这里的操作只对管理员开放，
        其中「恢复」会用备份<b>整体替换</b>当前数据。
      </p>
    </div>
    <div class="page-actions">
      ${backupEnabled
        ? html`<form method="post" action="/admin/maintenance/backup" class="inline-form">
        <input type="hidden" name="_csrf" value="${pd.csrf}">
        <button type="submit" class="btn btn-primary">立即备份</button>
      </form>`
        : ""}
    </div>
  </div>

  ${alertError(errors.form)}

  ${backupEnabled
    ? ""
    : alertWarning(
        "未绑定 R2 备份桶（BACKUPS），备份与恢复功能不可用。" +
          "请在 wrangler.jsonc 里配置 r2_buckets 后重新部署；" +
          "也可以先在本地用 npx wrangler d1 export inventory --remote --output=backup.sql 导出。",
      )}

  ${pending ? pendingBanner(pd.csrf, pending) : ""}

  <div class="stat-grid">
    <div class="stat-card">
      <span class="stat-label">备份数量</span>
      <span class="stat-value">${formatNumber(backups.length)}</span>
      <span class="stat-foot">
        ${backupKeep > 0 ? `自动备份保留最近 ${backupKeep} 份` : "已关闭自动轮转"}
      </span>
    </div>

    <div class="stat-card">
      <span class="stat-label">最近一次备份</span>
      ${backups.length > 0
        ? html`<span class="stat-value">${formatBytes(backups[0].size)}</span>
        <span class="stat-foot">${formatDateTime(backups[0].createdAt.toISOString())}</span>`
        : html`<span class="stat-value">—</span>
        <span class="stat-foot">尚未产生备份</span>`}
    </div>

    <div class="stat-card">
      <span class="stat-label">演示数据</span>
      ${hasDemoData
        ? html`<span class="stat-value danger">存在</span>
        <span class="stat-foot">商品 ${formatNumber(preview.products)} 条待清理</span>`
        : html`<span class="stat-value ok">无</span>
        <span class="stat-foot">数据库中未发现内置演示数据</span>`}
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <h3 class="card-title">数据备份</h3>
      <span class="muted"><code>R2：${backupPrefix || "（桶根目录）"}</code></span>
    </div>
    <div class="card-body no-pad">
      ${backups.length > 0
        ? html`<div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>文件名</th>
              <th>大小</th>
              <th>创建时间</th>
              <th>类型</th>
              <th class="actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            ${backups.map((b) => backupRow(pd.csrf, b))}
          </tbody>
        </table>
      </div>`
        : html`<div class="empty-inline">
        ${backupEnabled ? "还没有备份。点右上角「立即备份」生成第一份。" : "未绑定 R2 备份桶，无法生成备份。"}
      </div>`}
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3 class="card-title">从备份恢复</h3></div>
    <div class="card-body">
      ${restoreWarning()}

      <div class="field-row">
        <label for="restore-name">选择站内备份</label>
        ${backups.length > 0
          ? html`<form method="post" action="/admin/maintenance/restore" class="restore-form"
              data-confirm="恢复会清空当前全部业务数据并写回所选备份（操作前会自动做一份安全备份）。确认继续？">
          <input type="hidden" name="_csrf" value="${pd.csrf}">
          <div class="restore-row">
            <select id="restore-name" name="name" class="select" required>
              ${backups.map(
                (b) => html`<option value="${b.name}">
                  ${b.name}（${formatBytes(b.size)} · ${formatDateTime(b.createdAt.toISOString())}）
                </option>`,
              )}
            </select>
            <button type="submit" class="btn btn-primary">立即恢复</button>
          </div>
        </form>`
          : html`<p class="field-hint">还没有可用的备份。</p>`}
        <p class="field-hint">
          恢复的是备份里的快照内容；同一份备份也会以 <code>.sql</code> 形式保存在 R2 里，
          下载后可用 <code>npx wrangler d1 execute</code> 导入到别的环境。
        </p>
      </div>

      <div class="field-row">
        <label for="backup">或上传备份文件（.json）</label>
        <form method="post" action="/admin/maintenance/restore/upload" enctype="multipart/form-data"
              data-confirm="上传后只会暂存，不会立即生效。确认上传？">
          <input type="hidden" name="_csrf" value="${pd.csrf}">
          <input type="file" id="backup" name="backup" class="input"
                 accept=".json,application/json" required>
          <p class="field-hint">
            上传后会校验格式与列定义并暂存，校验不通过会被直接拒绝，当前数据不受影响。
            暂存后还需在页面顶部确认才会真正生效。
          </p>
          <div class="form-actions">
            <button type="submit" class="btn btn-secondary">上传并暂存</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <h3 class="card-title">演示数据</h3>
      ${hasDemoData
        ? html`<form method="post" action="/admin/maintenance/purge-demo-data" class="inline-form"
            data-confirm="将删除 ${formatNumber(preview.products)} 个演示商品及其库存流水。清理前会自动做一份安全备份。确认继续？">
        <input type="hidden" name="_csrf" value="${pd.csrf}">
        <button type="submit" class="btn btn-danger-ghost">清理演示数据</button>
      </form>`
        : ""}
    </div>
    <div class="card-body">
      ${hasDemoData
        ? html`<p class="muted">
        首次启动时数据库为空，程序会写入一组内置演示数据方便试用。
        生产环境默认不再写入，但历史遗留的数据需要在这里清理一次。
      </p>
      <dl class="detail-list">
        <div class="detail-row">
          <dt>商品</dt>
          <dd>${formatNumber(preview.products)} 条</dd>
        </div>
        <div class="detail-row">
          <dt>库存流水</dt>
          <dd>${formatNumber(preview.movements)} 条</dd>
        </div>
        <div class="detail-row">
          <dt>分类</dt>
          <dd>${formatNumber(preview.categories)} 个</dd>
        </div>
        <div class="detail-row">
          <dt>供应商</dt>
          <dd>${formatNumber(preview.suppliers)} 个</dd>
        </div>
        ${preview.skippedCategories.length > 0
          ? html`<div class="detail-row">
          <dt>保留的分类</dt>
          <dd class="muted">${preview.skippedCategories.join("、")}（仍被商品引用）</dd>
        </div>`
          : ""}
        ${preview.skippedSuppliers.length > 0
          ? html`<div class="detail-row">
          <dt>保留的供应商</dt>
          <dd class="muted">${preview.skippedSuppliers.join("、")}（仍被商品引用）</dd>
        </div>`
          : ""}
        ${preview.legacySkuOnly.length > 0
          ? html`<div class="detail-row">
          <dt>未清理的同名 SKU</dt>
          <dd class="muted">
            ${preview.legacySkuOnly.join("、")}
            <p class="field-hint">
              这些商品的 SKU 与内置演示编号相同，但<b>没有</b>演示标记，因此不会被删除。
              它们既可能是旧版本遗留的演示数据，也可能是您自己创建的商品。
              确认属于前者时，请用
              <code>npx wrangler d1 execute inventory --remote --command="DELETE FROM products WHERE is_demo &lt;&gt; 1 AND sku IN (...)"</code>
              手工处理。
            </p>
          </dd>
        </div>`
          : ""}
      </dl>`
        : html`<div class="empty-inline">数据库中未发现内置演示数据，无需清理。</div>
      ${preview.legacySkuOnly.length > 0
        ? html`<p class="muted">
        另有 ${formatNumber(preview.legacySkuOnly.length)} 个商品的 SKU 与内置演示编号相同但无演示标记
        （${preview.legacySkuOnly.join("、")}），出于安全考虑未做删除。
      </p>`
        : ""}`}
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3 class="card-title">操作说明</h3></div>
    <div class="card-body">
      <ul class="hint-list">
        <li><b>备份存进 R2 桶</b>（键前缀 <code>${backupPrefix || "（根目录）"}</code>）。
            每份备份两个对象：<code>.json</code> 是站内恢复用的快照，
            <code>.sql</code> 是可直接导入的脚本。</li>
        <li><b>数据库是托管的 D1，Worker 拿不到文件。</b>原版「拷贝 .db 文件」的做法在这里
            行不通，所以备份导出的是<b>行数据</b>而不是数据库文件 ——
            好处是能直接读、能直接 diff，坏处是不含索引与触发器（本系统没用到触发器）。</li>
        <li><b>大库请用命令行导出。</b>站内备份上限 20000 行；更大的库请执行
            <code>npx wrangler d1 export inventory --remote --output=backup.sql</code>，
            它不受 Worker 的请求时长限制。</li>
        <li><b>自动备份由定时任务完成。</b>需要的话在 <code>wrangler.jsonc</code> 里加一条
            Cron Trigger，再调用 <code>/admin/maintenance/backup</code>；
            「保留份数」只影响自动命名的备份，手工命名的不会被轮转删除。</li>
        <li><b>换环境不用管会话。</b>会话记录就存在 <code>sessions</code> 表里，cookie 里只有
            随机令牌、不依赖任何本地密钥文件 —— 把库整体迁过去，登录状态会一并带过去。</li>
        <li><b>D1 自带时间点恢复。</b>误删数据时，
            <code>npx wrangler d1 time-travel restore inventory --timestamp=&lt;时间&gt;</code>
            往往比备份更快，可以作为最后一道防线。</li>
      </ul>
    </div>
  </div>

</div>`;
  },
};

/** 恢复卡片的告警条。 */
function restoreWarning(): Html {
  return html`<div class="alert alert-warning">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3.5l9.2 16H2.8l9.2-16z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none"/></svg>
        <span>
          恢复会先<b>清空</b>当前全部业务数据，再用备份写回，并自动先做一份安全备份作为回滚点。
          恢复过程通常只需要几秒，期间请不要重复提交。
        </span>
      </div>`;
}

/** 单条备份。 */
function backupRow(csrf: string, b: BackupEntry): Html {
  return html`<tr>
              <td><div class="cell-title mono">${b.name}</div></td>
              <td class="muted nowrap">${formatBytes(b.size)}</td>
              <td class="muted nowrap">${formatDateTime(b.createdAt.toISOString())}</td>
              <td>
                ${b.auto
                  ? html`<span class="badge badge-info">自动</span>`
                  : html`<span class="badge badge-muted">手工</span>`}
              </td>
              <td class="actions-col">
                <div class="row-actions">
                  ${b.hasSql
                    ? html`<a href="/admin/maintenance/backup/download?name=${encodeURIComponent(b.name)}"
                        class="btn btn-xs btn-outline">下载</a>`
                    : ""}
                  <form method="post" action="/admin/maintenance/backup/delete" class="inline-form"
                        data-confirm="确定删除备份 ${b.name} 吗？删除后无法找回。">
                    <input type="hidden" name="_csrf" value="${csrf}">
                    <input type="hidden" name="name" value="${b.name}">
                    <button type="submit" class="btn btn-xs btn-danger-ghost">删除</button>
                  </form>
                </div>
              </td>
            </tr>`;
}

/** 待恢复快照的提示条。 */
function pendingBanner(csrf: string, pending: PendingInfo): Html {
  return html`<div class="alert alert-warning">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3.5l9.2 16H2.8l9.2-16z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none"/></svg>
    <span>
      已暂存一份待恢复的快照（来源 <code>${pending.source}</code>，
      ${formatBytes(pending.size)}，${countSummary(pending.counts)}；
      快照生成于 ${formatDateTime(pending.createdAt)}）。
      确认无误后点「立即生效」；若不想要了，点「放弃恢复」即可，当前数据不受影响。
    </span>
    <form method="post" action="/admin/maintenance/restore/apply" class="inline-form"
          data-confirm="将清空当前全部业务数据并写回这份快照（操作前会自动做一份安全备份）。确认继续？">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit" class="btn btn-xs btn-primary">立即生效</button>
    </form>
    <form method="post" action="/admin/maintenance/restore/discard" class="inline-form">
      <input type="hidden" name="_csrf" value="${csrf}">
      <button type="submit" class="btn btn-xs btn-outline">放弃恢复</button>
    </form>
  </div>`;
}
