// 用户管理路由 —— 对应原 Go 版 internal/handlers/user.go 与 registration.go。

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { UserFilter } from "../db/users";
import { isErrorCode } from "../lib/errors";
import { parsePage, parsePerPage } from "../lib/pagination";
import { isValidEmail, isValidUsername, validatePassword } from "../lib/validate";
import {
  ALL_ROLES,
  roleCanManageUsers,
  roleLabel,
  roleValid,
  USER_STATUS_ACTIVE,
  type Role,
  type User,
} from "../types";
import { registrationEnabled } from "../views/render";
import { userFormView, userListView } from "../views/users";
import {
  businessErrorMessage,
  currentQueryWithoutPage,
  formRaw,
  formValue,
  notFoundPage,
  redirectWith,
  render,
  serverError,
} from "./helpers";

export const userRoutes = new Hono<AppEnv>();

// usersPath 是用户管理页地址，开关操作完成后回到这里。
const usersPath = "/users";

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

/**
 * 检查用户管理权限（对应 Go 版 handler.canManageUsers）。
 *
 * 无权限时已写出响应并返回该响应，调用方直接返回即可；有权限返回 null。
 */
function requireManageUsers(c: Context<AppEnv>): Response | null {
  const user = c.get("user");
  if (!user) return redirectWith(c, "/login", "", "");
  if (!roleCanManageUsers(user.role)) {
    return redirectWith(c, "/", "error", "只有管理员可以管理用户账号");
  }
  return null;
}

/** 读取路径参数 {id}；非法或非正数返回 null（对应 Go 版 pathID）。 */
function pathId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// 用户列表
// ---------------------------------------------------------------------------

userRoutes.get("/users", async (c) => {
  const denied = requireManageUsers(c);
  if (denied) return denied;

  const store = c.get("store");
  const filter: UserFilter = {
    search: (c.req.query("q") ?? "").trim(),
    role: c.req.query("role") ?? "",
    status: c.req.query("status") ?? "",
    page: parsePage(c.req.query("page")),
    perPage: parsePerPage(c.req.query("per_page")),
  };

  try {
    const { users, pagination } = await store.listUsers(filter);
    return render(
      c,
      200,
      "用户管理",
      "users",
      {
        users,
        pagination,
        filter,
        roles: ALL_ROLES,
        registration: await registrationPageData(c),
        query: currentQueryWithoutPage(c),
      },
      userListView,
    );
  } catch (err) {
    return serverError(c, err);
  }
});

// ---------------------------------------------------------------------------
// 自助注册开关
//
// 这是一个纯粹的「开 / 关」开关：管理员在「用户管理」页点一下，状态即定论。
// 配置项 INVENTORY_ALLOW_REGISTRATION 只在「从未在页面上设置过」时生效，
// 也就是首次部署时的初始状态；页面上一旦做出选择，就以那个选择为准。
// ---------------------------------------------------------------------------

/**
 * 由管理员在「用户管理」页开启或关闭自助注册。
 *
 * 表单提交的是**期望的目标状态**（enabled=true / false）而不是「切换」：
 * 重复提交、或在另一个标签页里已经改过的情况下，结果依然可预期 ——
 * 「切换」语义的按钮会让并发操作互相打架。
 */
userRoutes.post("/users/registration", async (c) => {
  const denied = requireManageUsers(c);
  if (denied) return denied;

  const store = c.get("store");
  const logger = c.get("logger");
  const actor = c.get("user")!.username;

  const raw = await formValue(c, "enabled");

  // 参数解析刻意严格：字段缺失、取值非法都直接拒绝。
  // 若沿用 formBool「读不到就当 false」的习惯，一次畸形请求就会变成
  // 「静默关闭注册」—— 一个安全相关的开关不该有这种失败方式。
  const enable = parseGoBool(raw);
  if (enable === null) {
    logger.warn("注册开关请求参数不合法", { enabled: raw, 操作人: actor });
    return redirectWith(c, usersPath, "error", "请求参数不正确，请刷新页面后重试");
  }

  try {
    await store.setRegistrationEnabled(enable);
  } catch (err) {
    logger.error("保存自助注册开关失败", {
      错误: err instanceof Error ? err.message : String(err),
      操作人: actor,
    });
    return redirectWith(c, usersPath, "error", "保存自助注册开关失败，请稍后重试");
  }

  // 写入成功后直接回填请求上下文，管理员点完立刻看到新状态（布局会读它）。
  // 这里信任写入值而不是回读：落库的就是目标的布尔值，回读只会得到同一个值，
  // 白搭一次查询。
  c.set("registration", enable);

  logger.info("管理员调整了自助注册开关", { 状态: registrationWord(enable), 操作人: actor });
  return redirectWith(c, usersPath, "success", `已${registrationWord(enable)}自助注册`);
});

/**
 * 复刻 Go 的 strconv.ParseBool：只接受这几种写法，其余一律判为非法。
 * 直接用「读不到就当 false」会引入「畸形请求静默关掉注册」的隐患。
 */
function parseGoBool(raw: string): boolean | null {
  switch (raw) {
    case "1":
    case "t":
    case "T":
    case "TRUE":
    case "true":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "FALSE":
    case "false":
    case "False":
      return false;
    default:
      return null;
  }
}

/** registrationWord 把开关状态转成中文，供提示与日志复用。 */
function registrationWord(enabled: boolean): string {
  return enabled ? "开启" : "关闭";
}

/**
 * 组装「用户管理」页里自助注册卡片需要的数据。
 *
 * 只暴露 enabled：卡片呈现的就是一个二值开关，没有「当前取值来自哪一边」
 * 这第三种状态需要向管理员解释。
 */
async function registrationPageData(
  c: Context<AppEnv>,
): Promise<{ enabled: boolean; defaultRole: string }> {
  // 自助注册用户的默认角色由配置决定，卡片上如实说明，
  // 免得管理员以为新注册的人会直接拿到可写权限。
  const cfg = c.get("cfg");
  let role: string = cfg.defaultRole;
  if (!roleValid(role)) role = "viewer";

  // registrationEnabled 会顺带把结果写入 c.registration，布局渲染时复用。
  const enabled = await registrationEnabled(c);
  return { enabled, defaultRole: roleLabel(role as Role) };
}

// ---------------------------------------------------------------------------
// 新建用户
// ---------------------------------------------------------------------------

userRoutes.get("/users/new", async (c) => {
  const denied = requireManageUsers(c);
  if (denied) return denied;

  return render(
    c,
    200,
    "新建用户",
    "users",
    {
      target: null,
      values: { role: "viewer" },
      errors: {},
      roles: ALL_ROLES,
      isEdit: false,
    },
    userFormView,
  );
});

userRoutes.post("/users", async (c) => {
  const denied = requireManageUsers(c);
  if (denied) return denied;

  const store = c.get("store");
  const logger = c.get("logger");

  const username = await formValue(c, "username");
  const email = await formValue(c, "email");
  const fullName = await formValue(c, "full_name");
  const password = await formRaw(c, "password");
  const roleRaw = await formValue(c, "role");

  const values: Record<string, string> = {
    username,
    email,
    full_name: fullName,
    role: roleRaw,
  };
  const errors: Record<string, string> = {};

  if (!isValidUsername(username)) {
    errors.username = "用户名需为 3-32 位字母、数字、下划线或连字符";
  }
  if (!isValidEmail(email)) {
    errors.email = "请输入有效的邮箱地址";
  }
  const pwError = validatePassword(password);
  if (pwError) errors.password = pwError;
  if (!roleValid(roleRaw)) {
    errors.role = "请选择有效的角色";
  }

  if (Object.keys(errors).length > 0) {
    return render(
      c,
      422,
      "新建用户",
      "users",
      { target: null, values, errors, roles: ALL_ROLES, isEdit: false },
      userFormView,
    );
  }

  try {
    const created = await store.createUser({
      username,
      email,
      password,
      fullName,
      role: roleRaw as Role,
    });
    logger.info("管理员创建了用户", {
      新用户: created.username,
      角色: roleLabel(created.role),
      操作人: c.get("user")!.username,
    });
    return redirectWith(c, usersPath, "success", `用户「${created.username}」创建成功`);
  } catch (err) {
    if (isErrorCode(err, "conflict")) {
      const message = businessErrorMessage(err);
      if (message.includes("用户名")) errors.username = message;
      else errors.email = message;
    } else {
      errors.form = businessErrorMessage(err);
    }
    return render(
      c,
      422,
      "新建用户",
      "users",
      { target: null, values, errors, roles: ALL_ROLES, isEdit: false },
      userFormView,
    );
  }
});

// ---------------------------------------------------------------------------
// 编辑用户
// ---------------------------------------------------------------------------

userRoutes.get("/users/:id/edit", async (c) => {
  const denied = requireManageUsers(c);
  if (denied) return denied;

  const id = pathId(c.req.param("id"));
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  let target: User | null;
  try {
    target = await store.getUserById(id);
  } catch (err) {
    return serverError(c, err);
  }
  if (!target) return notFoundPage(c);

  return render(
    c,
    200,
    "编辑用户",
    "users",
    {
      target,
      values: {
        username: target.username,
        email: target.email,
        full_name: target.fullName,
        role: target.role,
        status: target.status,
      },
      errors: {},
      roles: ALL_ROLES,
      isEdit: true,
    },
    userFormView,
  );
});

userRoutes.post("/users/:id", async (c) => {
  const denied = requireManageUsers(c);
  if (denied) return denied;

  const id = pathId(c.req.param("id"));
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  const logger = c.get("logger");

  let target: User | null;
  try {
    target = await store.getUserById(id);
  } catch (err) {
    return serverError(c, err);
  }
  if (!target) return notFoundPage(c);

  const current = c.get("user")!;
  const roleRaw = await formValue(c, "role");
  let status = await formValue(c, "status");
  if (status === "") status = USER_STATUS_ACTIVE;
  const email = await formValue(c, "email");
  const fullName = await formValue(c, "full_name");
  const password = await formRaw(c, "password");

  const values: Record<string, string> = {
    username: target.username,
    email,
    full_name: fullName,
    role: roleRaw,
    status,
  };
  const errors: Record<string, string> = {};

  if (!isValidEmail(email)) {
    errors.email = "请输入有效的邮箱地址";
  }
  if (!roleValid(roleRaw)) {
    errors.role = "请选择有效的角色";
  }
  if (password !== "") {
    const pwError = validatePassword(password);
    if (pwError) errors.password = pwError;
  }
  if (id === current.id && (roleRaw !== "admin" || status !== USER_STATUS_ACTIVE)) {
    errors.form = "不能修改自己的角色或禁用自己的账号";
  }

  if (Object.keys(errors).length > 0) {
    return render(
      c,
      422,
      "编辑用户",
      "users",
      { target, values, errors, roles: ALL_ROLES, isEdit: true },
      userFormView,
    );
  }

  try {
    await store.updateUserByAdmin(id, {
      fullName,
      email,
      role: roleRaw as Role,
      status,
      password,
    });
  } catch (err) {
    // 冲突（邮箱占用）落到字段上；其余（如 lastAdmin）落到表单级提示，
    // 文案由 businessErrorMessage 原样透传。
    if (isErrorCode(err, "conflict")) {
      errors.email = businessErrorMessage(err);
    } else {
      errors.form = businessErrorMessage(err);
    }
    return render(
      c,
      422,
      "编辑用户",
      "users",
      { target, values, errors, roles: ALL_ROLES, isEdit: true },
      userFormView,
    );
  }

  logger.info("管理员更新了用户", { 目标用户: target.username, 操作人: current.username });
  return redirectWith(c, usersPath, "success", `用户「${target.username}」已更新`);
});

// ---------------------------------------------------------------------------
// 删除用户
// ---------------------------------------------------------------------------

userRoutes.post("/users/:id/delete", async (c) => {
  const denied = requireManageUsers(c);
  if (denied) return denied;

  const id = pathId(c.req.param("id"));
  if (id === null) return notFoundPage(c);

  const store = c.get("store");
  const logger = c.get("logger");
  const current = c.get("user")!;

  if (id === current.id) {
    return redirectWith(c, usersPath, "error", "不能删除自己的账号");
  }

  let target: User | null;
  try {
    target = await store.getUserById(id);
  } catch (err) {
    return redirectWith(c, usersPath, "error", businessErrorMessage(err));
  }
  if (!target) {
    return redirectWith(c, usersPath, "error", "记录不存在或已被删除");
  }

  try {
    await store.deleteUser(id);
  } catch (err) {
    return redirectWith(c, usersPath, "error", businessErrorMessage(err));
  }

  logger.info("管理员删除了用户", { 目标用户: target.username, 操作人: current.username });
  return redirectWith(c, usersPath, "success", `用户「${target.username}」已删除`);
});
