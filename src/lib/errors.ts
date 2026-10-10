// 业务错误 —— 对应原 Go 版 internal/services/errors.go。
//
// 处理器据此决定提示文案与 HTTP 状态码。

export type ErrorCode =
  | "notFound"
  | "conflict"
  | "invalidInput"
  | "insufficientStock"
  | "accountDisabled"
  | "invalidCredentials"
  | "tokenInvalid"
  | "lastAdmin"
  | "securityQuestionsNotSet"
  | "tooManyAttempts";

const LABELS: Record<ErrorCode, string> = {
  notFound: "记录不存在",
  conflict: "记录已存在",
  invalidInput: "参数不合法",
  insufficientStock: "库存不足",
  accountDisabled: "账号已被禁用，请联系管理员",
  invalidCredentials: "用户名或密码错误",
  tokenInvalid: "链接无效或已过期",
  lastAdmin: "系统必须保留至少一个启用的管理员账号",
  securityQuestionsNotSet: "该账号尚未设置安全问题",
  tooManyAttempts: "尝试次数过多，请稍后再试",
};

/** 带错误码的业务异常。 */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, detail?: string) {
    super(detail ? `${LABELS[code]}：${detail}` : LABELS[code]);
    this.name = "AppError";
    this.code = code;
  }
}

/** 类型守卫。 */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function isErrorCode(err: unknown, code: ErrorCode): boolean {
  return isAppError(err) && err.code === code;
}

/** 便捷构造：参数不合法。 */
export function invalidInput(detail: string): AppError {
  return new AppError("invalidInput", detail);
}

export function notFound(detail?: string): AppError {
  return new AppError("notFound", detail);
}

export function conflict(detail: string): AppError {
  return new AppError("conflict", detail);
}

/**
 * 把业务错误转换为用户可读的提示 —— 对应 Go 版 handlers.businessError。
 */
export function businessError(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (!isAppError(err)) return "操作失败，请稍后重试";
  switch (err.code) {
    case "notFound":
      return "记录不存在或已被删除";
    case "tokenInvalid":
      return "链接无效或已过期，请重新申请";
    default:
      return err.message;
  }
}

/** 去掉「参数不合法：」这类前缀，便于逐字段标红时展示。 */
export function stripCodePrefix(message: string): string {
  const idx = message.indexOf("：");
  return idx >= 0 ? message.slice(idx + 1) : message;
}
