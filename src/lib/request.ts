// 请求工具 —— 对应原 Go 版 internal/utils/request.go。
//
// ⚠️ 与原版最大的差异：Workers 上的请求**必然**经过 Cloudflare 边缘节点，
// 而边缘节点会**覆盖**（而不是追加）CF-Connecting-IP。因此这个头是可信的，
// 不需要像原版那样先判断 RemoteAddr 是否落在可信代理网段内。
// 反过来，X-Forwarded-For / X-Real-IP 在 Workers 上依然是客户端可伪造的，
// 只作为最后兜底，且只取最右侧一项（代理是追加，最右才是真实客户端）。

/** 尽力还原真实客户端 IP。 */
export function clientIp(req: Request): string {
  const cf = req.headers.get("CF-Connecting-IP");
  if (cf && cf.trim() !== "") return cf.trim();

  const xri = req.headers.get("X-Real-IP");
  if (xri && xri.trim() !== "") return xri.trim();

  const xff = req.headers.get("X-Forwarded-For");
  if (xff) {
    const parts = xff.split(",");
    for (let i = parts.length - 1; i >= 0; i--) {
      const v = parts[i].trim();
      if (v !== "") return v;
    }
  }
  return "";
}

/** 截断后的 User-Agent，避免超长字符串写库。 */
export function userAgent(req: Request, max = 255): string {
  const ua = req.headers.get("User-Agent") ?? "";
  if (ua.length <= max) return ua;
  return ua.slice(0, max);
}

/** 客户端是否期望 JSON 响应。 */
export function wantsJson(req: Request): boolean {
  const accept = req.headers.get("Accept") ?? "";
  if (accept.includes("application/json")) return true;
  const xrw = req.headers.get("X-Requested-With") ?? "";
  return xrw.toLowerCase() === "xmlhttprequest";
}

/** 当前请求的 path + query（用于登录后回跳）。 */
export function requestUri(req: Request): string {
  const u = new URL(req.url);
  return u.pathname + u.search;
}
