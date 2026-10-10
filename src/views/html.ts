// 视图层的 HTML 基元。
//
// 统一从这里取 html / raw，好处有两点：
//   1. Html 类型只在一个地方定义，各页面文件不必各自推导；
//   2. 后续若要换掉模板引擎（或加一层编译期检查），只需改这一个文件。
//
// 转义语义（来自 Hono）：`html` 标签模板会把**插值的字符串自动转义**，
// 只有 HtmlEscapedString（html`` 或 raw() 的产物）才原样输出。
// 也就是说「忘记转义」在默认情况下不会发生 —— 要输出原始 HTML 必须显式写 raw()。

import { html, raw } from "hono/html";

export { html, raw };

/**
 * 已转义、可安全嵌入的 HTML 片段（可能是 Promise 形式）。
 *
 * 直接复用 html 标签的返回类型，避免深链到 hono 的内部路径。
 */
export type Html = ReturnType<typeof html>;

/** 同步可用的 HTML 片段（await 之后的结果）。 */
export type HtmlString = Awaited<Html>;
