// Store —— 数据访问层的入口。
//
// 设计说明：原 Go 版用一个 Store 结构体承载全部数据访问方法。这里保持同样的
// 调用形态（store.getUserById(...)），但把实现按领域拆到多个文件，通过
// TypeScript 的「类 / 接口声明合并 + 原型挂载」组合起来，避免出现一个
// 两千行的巨型文件。
//
// ⚠️ 新增领域文件后，务必在 src/db/index.ts 里 import 一次，
//    否则原型方法不会被挂载（运行时才会暴露，类型检查发现不了）。

import type { Logger } from "../lib/logger";

/** 单个商品的库存 / 单据数量上限。 */
export const MAX_QUANTITY = 100_000_000;

/** 单次导出允许返回的最大行数。 */
export const MAX_EXPORT_ROWS = 50_000;

export class Store {
  constructor(
    public readonly db: D1Database,
    public readonly logger: Logger,
  ) {}
}
