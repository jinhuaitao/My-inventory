// Hono 的上下文类型与全局变量声明。
//
// 原 Go 版把配置、Store、日志器通过构造函数注入到各个 Handler 结构体；
// Hono 的做法是塞进请求上下文，由中间件统一准备。

import type { Store } from "./db/store";
import type { Config, Env } from "./env";
import type { Logger } from "./lib/logger";
import type { Session, User } from "./types";

/** 所有中间件 / 处理器共用的环境类型。 */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    /** 运行期配置（由 provide 中间件注入）。 */
    cfg: Config;
    /** 数据访问层（由 provide 中间件注入，每请求一个薄封装）。 */
    store: Store;
    /** 结构化日志器（由 provide 中间件注入）。 */
    logger: Logger;
    /** 当前登录用户；未登录为 undefined。 */
    user: User | undefined;
    /** 当前会话；未登录为 undefined。 */
    session: Session | undefined;
    /** 本次请求应使用的 CSRF 令牌（已登录时为会话令牌，否则为双提交 cookie 值）。 */
    csrfToken: string;
    /**
     * 已解析的表单。
     *
     * 请求体只能读一次，而 CSRF 校验与业务处理都要用表单 ——
     * 统一走 readForm() 并缓存在这里，避免第二次解析拿到空表单。
     */
    form: FormData | undefined;
    /**
     * 「是否开放自助注册」的最终生效值。
     *
     * 对应 Go 版 Handler.registration：环境变量 INVENTORY_ALLOW_REGISTRATION
     * 只是**默认值**，管理员可在「用户管理」页随时改写（存在 settings 表里）。
     * 这里做请求内缓存，避免同一次渲染里重复查库。
     */
    registration: boolean | undefined;
  };
}
