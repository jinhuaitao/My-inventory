// 仪表盘路由 —— 对应原 Go 版 internal/handlers/dashboard.go。

import { Hono } from "hono";
import type { AppEnv } from "../context";
import { trendMaxValue } from "../types";
import { dashboardView, type DashboardData } from "../views/dashboard";
import { render, serverError } from "./helpers";

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get("/", async (c) => {
  const store = c.get("store");

  try {
    const stats = await store.dashboardStats();
    const trend = await store.movementTrend(14);
    const categoryStats = await store.categoryStats(8);
    const topProducts = await store.topProductsByValue(8);
    const topMoving = await store.topMovingProducts(30, 8);
    const lowStock = await store.listLowStockProducts(8);
    const recent = await store.recentMovements(10);

    // 趋势图纵轴上限
    let maxTrend = 0;
    for (const p of trend) {
      const v = trendMaxValue(p);
      if (v > maxTrend) maxTrend = v;
    }

    // 分类占比图的分母
    let categoryTotal = 0;
    for (const cs of categoryStats) categoryTotal += cs.value;

    const data: DashboardData = {
      stats,
      trend,
      maxTrend,
      categoryStats,
      categoryTotal,
      topProducts,
      topMoving,
      lowStock,
      recent,
    };
    return render(c, 200, "仪表盘", "dashboard", data, dashboardView);
  } catch (err) {
    return serverError(c, err);
  }
});
