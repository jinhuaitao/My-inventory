// 语义化版本比较 —— 对应原 Go 版 internal/updater/semver.go。
//
// 逐行移植，行为必须一致：开发构建（版本号不是 x.y.z）一律判定为「不可比较」，
// 否则一个 0.0.0-dev 的版本号会把所有发布都当成「有更新」。

/** 解析后的语义化版本。 */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识，例如 beta.1。 */
  pre: string;
  /** 原始字符串。 */
  raw: string;
}

/**
 * 解析版本号，支持 v1.2.3、1.2.3、v1.2、v1.2.3-beta.1、v1.2.3+build 等形式。
 *
 * 解析失败返回 null，调用方应据此放弃版本比较。
 */
export function parseVersion(s: string): Version | null {
  const raw = s.trim();
  if (raw === "") return null;

  let t = raw;
  if (t[0] === "v" || t[0] === "V") t = t.slice(1);

  // 剥离预发布标识与构建元数据
  let pre = "";
  const i = t.search(/[-+]/);
  if (i >= 0) {
    pre = t.slice(i + 1);
    t = t.slice(0, i);
  }

  const parts = t.split(".");
  if (parts.length === 0 || parts.length > 3) return null;

  const nums = [0, 0, 0];
  for (let k = 0; k < parts.length; k += 1) {
    const p = parts[k].trim();
    if (p === "" || !/^\d+$/.test(p)) return null;
    nums[k] = Number(p);
  }

  return { major: nums[0], minor: nums[1], patch: nums[2], pre, raw };
}

/**
 * 比较两个版本：a > b 返回正数，a < b 返回负数，相等返回 0。
 *
 * 遵循语义化版本规则：主次修订号逐位比较；数字相同时，
 * 无预发布标识的版本视为更新（1.0.0 > 1.0.0-beta）。
 */
export function compareVersion(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  if (a.pre === "" && b.pre === "") return 0;
  if (a.pre === "") return 1;
  if (b.pre === "") return -1;
  return comparePreRelease(a.pre, b.pre);
}

/**
 * 判断 latest 是否比 current 更新。
 * 任一版本无法解析时返回 false，避免把开发版本误判为可更新。
 */
export function isNewer(current: string, latest: string): boolean {
  const cur = parseVersion(current);
  const lat = parseVersion(latest);
  if (!cur || !lat) return false;
  return compareVersion(lat, cur) > 0;
}

/**
 * 比较预发布标识，按 . 分段后逐段比较。
 * 纯数字段按数值比较，否则按字典序比较；段数少的视为更小。
 */
function comparePreRelease(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const n = Math.min(as.length, bs.length);

  for (let i = 0; i < n; i += 1) {
    const x = as[i];
    const y = bs[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);

    if (xNum && yNum) {
      const xn = Number(x);
      const yn = Number(y);
      if (xn !== yn) return xn > yn ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }

  if (as.length === bs.length) return 0;
  return as.length > bs.length ? 1 : -1;
}
