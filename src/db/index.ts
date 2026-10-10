// 数据访问层的统一出口。
//
// ⚠️ 每个领域文件都必须在下面 import 一次 —— 它们的 Store 方法是通过
//    「原型挂载」实现的，不 import 就等于没挂上，且**类型检查发现不了**，
//    只在运行时暴露成 `store.xxx is not a function`。
//
// 目录结构对应原 Go 版 internal/services：
//   store.ts      ← services/store.go      （Store 基类 + 常量）
//   users.ts      ← services/user.go
//   sessions.ts   ← services/session.go
//   security.ts   ← services/security.go
//   settings.ts   ← services/settings.go
//   catalog.ts    ← services/category.go + supplier.go
//   products.ts   ← services/product.go
//   movements.ts  ← services/movement.go
//   stats.ts      ← services/stats.go
//   seed.ts       ← database/database.go  （Seed / seedDemoData / PurgeDemoData）
//   backup.ts     ← database/database.go  （备份与迁移一节）

export * from "./store";

export * from "./users";
export * from "./sessions";
export * from "./security";
export * from "./settings";
export * from "./catalog";
export * from "./products";
export * from "./movements";
export * from "./stats";
export * from "./seed";
export * from "./backup";
