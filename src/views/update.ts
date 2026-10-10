// 系统更新页面 —— 对应原 Go 版 web/templates/update/index.html 与 restarting.html。
//
// 与原版的差异：
//   Go 版「检查 → 下载对应平台安装包 → 校验 SHA-256 → 替换可执行文件 → 重启进程」，
//   Workers 上只能保留第一步 —— Worker 不能替换自己的代码，也没有可重启的进程。
//   取而代之：检查结果照常展示；「立即更新」改为触发一次**重新部署**
//   （INVENTORY_UPDATE_DEPLOY_HOOK），随后用一个等待页盯着版本号变化。
//   restarting.html 因此被保留下来（它是真的在等东西），只是判据从
//   「/readyz 能通」换成了「/healthz 报的版本已经是新版本」——
//   部署期间旧版本一直在正常服务，用「能通」判断会立刻刷新成功却看到旧版本，
//   这正是原版注释里警告过的那个坑。

import { formatDateTime } from "../lib/time";
import { html, type Html } from "./html";
import { alertError, alertInfo, alertWarning } from "./ui";
import type { View } from "./render";

/** 一次版本检查的结果快照。 */
export interface UpdateStatus {
  current: string;
  latest: string;
  updateAvailable: boolean;
  /** 当前版本是否可参与比较（开发构建为 false）。 */
  comparable: boolean;
  /** 本次检查时间（ISO-8601）；尚未检查时为空串。 */
  checkedAt: string;
  /** 最新版本发布时间；未知时为空串。 */
  publishedAt: string;
  releaseUrl: string;
  notes: string;
  /** 检查过程中的错误（面向用户展示）；无错误时为空串。 */
  err: string;
}

export interface UpdateData {
  status: UpdateStatus | null;
  enabled: boolean;
  repo: string;
  platform: string;
  currentBuild: string;
  /** 是否配置了部署钩子。未配置时「立即更新」只能给人工指引。 */
  deployHookConfigured: boolean;
  errors: Record<string, string>;
}

/** 空状态（从未检查过）。 */
export function emptyStatus(current: string): UpdateStatus {
  return {
    current,
    latest: "",
    updateAvailable: false,
    comparable: false,
    checkedAt: "",
    publishedAt: "",
    releaseUrl: "",
    notes: "",
    err: "",
  };
}

export const updateView: View<UpdateData> = {
  content(pd) {
    const { status, enabled, repo, platform, currentBuild, deployHookConfigured, errors } = pd.data;
    const s = status;

    return html`<div class="page">

  <div class="page-head">
    <div>
      <h2 class="page-title">系统更新</h2>
      <p class="page-desc">
        从 GitHub Releases 检查新版本。Workers 版的代码由部署流程下发，
        因此这里只负责「发现新版本」与「触发一次重新部署」，不会替换任何文件。
      </p>
    </div>
    <div class="page-actions">
      ${enabled
        ? html`<form method="post" action="/admin/update/check" class="inline-form">
        <input type="hidden" name="_csrf" value="${pd.csrf}">
        <button type="submit" class="btn btn-ghost">检查更新</button>
      </form>`
        : ""}
      ${s && s.updateAvailable
        ? html`<form method="post" action="/admin/update/apply" class="inline-form"
            data-confirm="将触发一次重新部署，把线上版本更新到 ${s.latest}。部署期间旧版本仍在服务，通常 1 分钟内完成。确认继续？">
        <input type="hidden" name="_csrf" value="${pd.csrf}">
        <button type="submit" class="btn btn-primary">
          ${deployHookConfigured ? `立即更新到 ${s.latest}` : "查看更新方式"}
        </button>
      </form>`
        : ""}
    </div>
  </div>

  ${alertError(errors.form)}

  ${enabled
    ? ""
    : alertWarning(
        "在线更新未启用或未配置更新仓库。请设置环境变量 INVENTORY_UPDATE_REPO=owner/repo 后重新部署。",
      )}

  <div class="stat-grid">
    <div class="stat-card">
      <span class="stat-label">当前版本</span>
      <span class="stat-value">${s ? s.current : currentBuild}</span>
      <span class="stat-foot">运行环境 ${platform}</span>
    </div>

    <div class="stat-card">
      <span class="stat-label">最新版本</span>
      <span class="stat-value">${s && s.latest ? s.latest : "—"}</span>
      <span class="stat-foot">
        ${s && s.publishedAt ? `发布于 ${formatDateTime(s.publishedAt)}` : "尚未获取"}
      </span>
    </div>

    <div class="stat-card">
      <span class="stat-label">更新状态</span>
      ${s && s.updateAvailable
        ? html`<span class="stat-value danger">有可用更新</span>`
        : s && s.err
          ? html`<span class="stat-value">待确认</span>`
          : html`<span class="stat-value ok">已是最新</span>`}
      <span class="stat-foot">
        ${s && s.checkedAt ? `检查于 ${formatDateTime(s.checkedAt)}` : "尚未检查"}
      </span>
    </div>
  </div>

  ${s && s.err ? alertInfo(s.err) : ""}

  <div class="card">
    <div class="card-head">
      <h3 class="card-title">更新详情</h3>
      ${repo
        ? html`<a href="https://github.com/${repo}/releases" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">
        查看全部发布
      </a>`
        : ""}
    </div>
    <div class="card-body">
      <dl class="detail-list">
        <div class="detail-row">
          <dt>更新仓库</dt>
          <dd>${repo ? html`<code>${repo}</code>` : html`<span class="muted">未配置</span>`}</dd>
        </div>
        <div class="detail-row">
          <dt>运行环境</dt>
          <dd><code>${platform}</code></dd>
        </div>
        <div class="detail-row">
          <dt>构建版本</dt>
          <dd><code>${currentBuild}</code></dd>
        </div>
        <div class="detail-row">
          <dt>生效方式</dt>
          <dd>
            ${deployHookConfigured
              ? html`点击「立即更新」会调用已配置的部署钩子触发重新部署，<b>无需</b>手工操作`
              : html`未配置部署钩子（<code>INVENTORY_UPDATE_DEPLOY_HOOK</code>），
                  需要在本机执行 <code>npm run deploy</code>`}
          </dd>
        </div>
        <div class="detail-row">
          <dt>回滚方式</dt>
          <dd>
            用 <code>npx wrangler versions list</code> 找到上一个版本，
            再执行 <code>npx wrangler rollback &lt;版本号&gt;</code>
          </dd>
        </div>
      </dl>
    </div>
  </div>

  ${s && s.notes ? releaseNotes(s) : ""}

  <div class="card">
    <div class="card-head"><h3 class="card-title">更新方式说明</h3></div>
    <div class="card-body">
      <ul class="hint-list">
        <li><b>Workers 不能自我替换。</b>原版会下载对应平台的安装包、校验 SHA-256 后替换可执行文件；
            在 Workers 上这段流程由部署系统完成，因此这里不做下载，也不会改动任何文件。</li>
        <li><b>检查是只读的。</b>只调用 GitHub 的 Releases API 读取版本号与发布说明，
            不写入任何数据；需要私有仓库时可用 <code>INVENTORY_UPDATE_TOKEN</code> 提供访问令牌。</li>
        <li><b>配置了部署钩子才能一键更新。</b>把 Cloudflare Workers Builds 的 Deploy Hook
            地址填进 <code>INVENTORY_UPDATE_DEPLOY_HOOK</code>，「立即更新」就会触发重新部署；
            未配置时按钮只给出命令指引。</li>
        <li><b>部署期间旧版本仍在服务。</b>新版本完全上线前访问到的仍是旧版本 ——
            等待页因此盯着 <code>/healthz</code> 里报的版本号，而不是「服务是否可达」。</li>
        <li><b>数据库不受影响。</b>更新只替换 Worker 代码，D1 里的业务数据不会被改动。
            需要回滚代码时用 <code>npx wrangler rollback</code>。</li>
      </ul>
    </div>
  </div>

</div>`;
  },
};

/** 发布说明卡片。 */
function releaseNotes(s: UpdateStatus): Html {
  return html`<div class="card">
    <div class="card-head">
      <h3 class="card-title">${s.latest} 更新说明</h3>
      ${s.releaseUrl
        ? html`<a href="${s.releaseUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">在 GitHub 上查看</a>`
        : ""}
    </div>
    <div class="card-body">
      ${/* 说明是纯文本：这里逐行渲染并交给 html`` 转义，
           不解析 Markdown —— 让远端内容决定页面结构是注入风险。 */ ""}
      <div class="release-notes">${s.notes.split("\n").map((line) => html`${line}<br>`)}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// 等待部署生效
// ---------------------------------------------------------------------------

export interface UpdateApplyingData {
  from: string;
  to: string;
  /** 倒计时秒数。 */
  countdown: number;
  /** 就绪探测地址（带 expect 参数，版本没换过来之前一直返回 503）。 */
  probe: string;
  /** 完成后跳转的地址。 */
  refresh: string;
}

/**
 * 等待页 —— 对应原版 web/templates/update/restarting.html。
 *
 * 倒计时与自动刷新由 /static/js/app.js 的 initRestartWatcher 驱动，
 * 这里不能写内联脚本：站点 CSP 为 script-src 'self'，内联脚本会被浏览器
 * 直接拒绝执行，页面就永远不会自动刷新。
 */
export const updateApplyingView: View<UpdateApplyingData> = {
  content(pd) {
    const { from, to, countdown, probe, refresh } = pd.data;
    return html`<div class="page page-narrow">

  <div class="update-restarting"
       data-restart-target="${refresh}"
       data-restart-probe="${probe}"
       data-restart-seconds="${countdown}">
    <div class="restart-spinner" aria-hidden="true">
      <svg viewBox="0 0 50 50" width="56" height="56">
        <circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-opacity="0.15" stroke-width="4"/>
        <circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="4"
                stroke-linecap="round" stroke-dasharray="90 200">
          <animateTransform attributeName="transform" type="rotate"
                            from="0 25 25" to="360 25 25" dur="1s" repeatCount="indefinite"/>
        </circle>
      </svg>
    </div>

    <h2 class="update-restarting-title">已触发部署，正在等待新版本上线</h2>
    <p class="update-restarting-desc">
      正在从 <code>${from}</code> 升级到 <code>${to}</code>。部署期间旧版本仍在正常服务，
      完成后本页会自动刷新。
    </p>

    <div class="alert alert-info">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/></svg>
      <span>
        判断依据是 <code>/healthz</code> 里报的版本号：新版本没上线之前它一直返回未就绪，
        因此不会出现「刷新成功但看到的还是旧版本」。
      </span>
    </div>

    <p class="update-restarting-hint" data-restart-hint>
      页面将在 <span data-restart-countdown>${countdown}</span> 秒后自动刷新……
    </p>

    <a href="${refresh}" class="btn btn-primary">立即刷新</a>

    <noscript>
      <p class="update-restarting-hint">
        当前浏览器未启用 JavaScript，页面不会自动刷新。请稍候片刻后点击上方按钮。
      </p>
    </noscript>
  </div>

</div>`;
  },
};
