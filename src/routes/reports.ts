// 库存报表路由 —— 对应原 Go 版 internal/handlers/report.go。
//
// 查询参数名与原版一致：start / end（YYYY-MM-DD，本地时区，含当天）。

import { Hono } from "hono";
import type { AppEnv } from "../context";
import { addDaysUtc, localDateString } from "../lib/time";
import { trendMaxValue } from "../types";
import { reportsView, type ReportsData } from "../views/reports";
import { render, serverError } from "./helpers";

export const reportRoutes = new Hono<AppEnv>();

reportRoutes.get("/reports", async (c) => {
  const store = c.get("store");
  const now = new Date();

  // 默认区间为最近 30 天（含今天）：end 缺省取今天，start 缺省取 29 天前。
  let end = c.req.query("end") ?? "";
  let start = c.req.query("start") ?? "";
  if (end === "") end = localDateString(now);
  if (start === "") start = localDateString(addDaysUtc(now, -29));

  try {
    const summary = await store.summary(start, end);
    const trend = await store.movementTrend(30);
    const categoryStats = await store.categoryStats(10);
    const topProducts = await store.topProductsByValue(10);
    const topMoving = await store.topMovingProducts(30, 10);
    const stats = await store.dashboardStats();

    let maxTrend = 0;
    for (const p of trend) {
      const v = trendMaxValue(p);
      if (v > maxTrend) maxTrend = v;
    }

    let categoryTotal = 0;
    for (const cs of categoryStats) categoryTotal += cs.value;

    const data: ReportsData = {
      summary,
      trend,
      maxTrend,
      categoryStats,
      categoryTotal,
      topProducts,
      topMoving,
      stats,
      start,
      end,
    };
    return render(c, 200, "库存报表", "reports", data, reportsView);
  } catch (err) {
    return serverError(c, err);
  }
});
