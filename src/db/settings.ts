// 系统设置 —— 对应原 Go 版 internal/services/settings.go。
//
// 这里存放「需要在运行期由管理员调整、且必须跨重启保留」的少量开关。
// 取值优先级：settings 表中的设置 > 环境变量默认值。
// 管理员一旦在页面上做过选择，那个选择就是唯一的取值来源，不会再被环境变量翻回去。

import { nowUtcIso } from "../lib/time";
import { Store } from "./store";

/** 「是否开放自助注册」在 settings 表中的键名。 */
export const SETTING_ALLOW_REGISTRATION = "allow_registration";

export interface RegistrationState {
  /** 最终生效的取值。 */
  enabled: boolean;
  /** true 表示取值来自管理员在页面上的设置。 */
  explicit: boolean;
}

declare module "./store" {
  interface Store {
    getSetting(key: string): Promise<{ value: string; found: boolean }>;
    setSetting(key: string, value: string): Promise<void>;
    registrationState(fallback: boolean): Promise<RegistrationState>;
    setRegistrationEnabled(enabled: boolean): Promise<void>;
  }
}

/**
 * 读取一项系统设置。键不存在时返回 { value: "", found: false } ——
 * 「没有设置过」与「设置为空字符串」是两回事，调用方需要能区分。
 */
Store.prototype.getSetting = async function (
  this: Store,
  key: string,
): Promise<{ value: string; found: boolean }> {
  const row = await this.db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
  if (!row) return { value: "", found: false };
  return { value: row.value, found: true };
};

/** 写入或覆盖一项系统设置。 */
Store.prototype.setSetting = async function (this: Store, key: string, value: string): Promise<void> {
  await this.db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, nowUtcIso())
    .run();
};

/** 读取自助注册开关；fallback 是环境变量给出的默认值。 */
Store.prototype.registrationState = async function (
  this: Store,
  fallback: boolean,
): Promise<RegistrationState> {
  const { value, found } = await this.getSetting(SETTING_ALLOW_REGISTRATION);
  if (!found) return { enabled: fallback, explicit: false };

  const raw = value.trim().toLowerCase();
  if (raw === "true" || raw === "1") return { enabled: true, explicit: true };
  if (raw === "false" || raw === "0") return { enabled: false, explicit: true };

  // 取值被手工改坏（例如直接 UPDATE settings）时不猜测意图：猜测的代价是
  // 「把坏值当成 false 静默关掉注册」或反过来静默打开，两者都不是管理员想要的。
  this.logger.warn("settings 表中的注册开关取值无法解析，已回落到配置默认值", {
    key: SETTING_ALLOW_REGISTRATION,
    value,
  });
  return { enabled: fallback, explicit: false };
};

/**
 * 持久化自助注册开关，之后不再受配置项默认值影响。
 * 开关只有「开」和「关」两种取值，没有第三种「交还给环境变量」的状态。
 */
Store.prototype.setRegistrationEnabled = async function (this: Store, enabled: boolean): Promise<void> {
  await this.setSetting(SETTING_ALLOW_REGISTRATION, enabled ? "true" : "false");
};
