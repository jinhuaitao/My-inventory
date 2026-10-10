// 主布局 —— 对应原 Go 版 web/templates/layout.html。
//
// 原版是「布局 + 页面」两块模板拼装（Go 的 {{define "layout"}} / {{block "content"}}），
// 这里换成函数组合：layout(pd, content, scripts) 把页面片段嵌进骨架。

import { html, type Html } from "./html";
import { flash, sidebar } from "./partials";
import { roleCanManageUsers, roleLabel, userDisplayName, userInitials } from "../types";
import type { PageData } from "./render";

export function layout(pd: PageData, content: Html, scripts: Html | null): Html {
  const body = pd.user ? appShell(pd, content) : authShell(pd, content);

  return html`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${pd.title} · ${pd.appName}</title>
  ${/* ?v=<内容指纹> 是静态资源的内容指纹：内容一变 URL 就变，浏览器必然重新拉取。
       不要去掉它，否则升级后浏览器会继续用缓存里的旧 JS / CSS
       （静态资源是按长期缓存下发的）。 */ ""}
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg?v=${pd.assetVersion}">
  <link rel="stylesheet" href="/static/css/app.css?v=${pd.assetVersion}">
</head>
<body class="${pd.user ? "layout-app" : "layout-auth"}">

${body}

<script src="/static/js/app.js?v=${pd.assetVersion}" defer></script>
${scripts ?? ""}
</body>
</html>`;
}

function appShell(pd: PageData, content: Html): Html {
  const user = pd.user!;
  return html`<div class="app-shell">
    ${sidebar(pd.active, user, pd.appName, pd.env)}

    <div class="app-main">
      <header class="topbar">
        <div class="topbar-left">
          <button type="button" class="icon-btn sidebar-toggle" id="sidebarToggle" aria-label="切换菜单">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
          </button>
          <h1 class="topbar-title">${pd.title}</h1>
        </div>

        <div class="topbar-right">
          <a href="/stock/low" class="icon-btn" title="库存预警">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>
          </a>

          <details class="user-menu">
            <summary class="user-trigger">
              <span class="avatar">${userInitials(user)}</span>
              <span class="user-meta">
                <span class="user-name">${userDisplayName(user)}</span>
                <span class="user-role">${roleLabel(user.role)}</span>
              </span>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>
            </summary>
            <div class="user-dropdown">
              <div class="dropdown-header">
                <div class="dropdown-name">${userDisplayName(user)}</div>
                <div class="dropdown-email">${user.email}</div>
              </div>
              <a href="/profile" class="dropdown-item">个人资料</a>
              <a href="/profile/password" class="dropdown-item">修改密码</a>
              <a href="/profile/security" class="dropdown-item">安全问题</a>
              <a href="/profile/sessions" class="dropdown-item">登录设备</a>
              ${roleCanManageUsers(user.role) ? html`<a href="/admin/update" class="dropdown-item">系统更新</a>` : ""}
              <form method="post" action="/logout" class="dropdown-form">
                <input type="hidden" name="_csrf" value="${pd.csrf}">
                <button type="submit" class="dropdown-item danger">退出登录</button>
              </form>
            </div>
          </details>
        </div>
      </header>

      <main class="app-content">
        ${flash(pd.flash)}
        ${content}
      </main>

      <footer class="app-footer">
        <span>${pd.appName}</span>
        <span class="dot">·</span>
        <span>v${pd.version}</span>
        <span class="dot">·</span>
        <span>© ${pd.year}</span>
      </footer>
    </div>
  </div>`;
}

function authShell(pd: PageData, content: Html): Html {
  return html`<div class="auth-shell">
    <div class="auth-panel">
      <a href="/" class="auth-brand">
        <span class="brand-mark">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v9"/></svg>
        </span>
        <span>${pd.appName}</span>
      </a>
      ${flash(pd.flash)}
      ${content}
      <p class="auth-foot">© ${pd.year} ${pd.appName} · v${pd.version}</p>
    </div>
  </div>`;
}
