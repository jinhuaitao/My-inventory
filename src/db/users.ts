// 用户数据访问 —— 对应原 Go 版 internal/services/user.go。

import {
  AppError,
  conflict,
  invalidInput,
  notFound,
  type ErrorCode,
} from "../lib/errors";
import { hashPassword, needsRehash, verifyPassword } from "../lib/crypto";
import { likePattern } from "../lib/sql";
import { conflictMessage, isUniqueViolation, uniqueField } from "../lib/sql";
import { newPagination, type Pagination } from "../lib/pagination";
import { isValidEmail, normalizeSku } from "../lib/validate";
import { nowUtcIso } from "../lib/time";
import { roleValid, USER_STATUS_ACTIVE, USER_STATUS_DISABLED, type Role, type User } from "../types";
import { Store } from "./store";

const USER_COLUMNS = `id, username, email, password_hash AS passwordHash, full_name AS fullName,
  role, status, last_login_at AS lastLoginAt, created_at AS createdAt, updated_at AS updatedAt`;

export interface CreateUserInput {
  username: string;
  email: string;
  password: string;
  fullName: string;
  role: Role;
}

export interface AdminUpdateUserInput {
  fullName: string;
  email: string;
  role: Role;
  status: string;
  password?: string;
}

export interface UserFilter {
  search?: string;
  role?: string;
  status?: string;
  page?: number;
  perPage?: number;
}

export interface PasswordCheckResult {
  ok: boolean;
  /** 校验成功后若摘要格式陈旧，这里给出应当写回的新摘要。 */
  upgradedHash?: string;
}

declare module "./store" {
  interface Store {
    getUserById(id: number): Promise<User | null>;
    getUserByIdentifier(identifier: string): Promise<User | null>;
    getUserByEmail(email: string): Promise<User | null>;
    countUsers(): Promise<number>;
    countActiveAdmins(): Promise<number>;
    createUser(input: CreateUserInput): Promise<User>;
    createUserWithQuestions(
      input: CreateUserInput,
      questions: { question: string; answer: string }[],
    ): Promise<User>;
    updateProfile(userId: number, fullName: string, email: string): Promise<void>;
    updateUserByAdmin(userId: number, input: AdminUpdateUserInput): Promise<void>;
    setPassword(userId: number, newPassword: string): Promise<void>;
    changePassword(userId: number, currentPassword: string, newPassword: string): Promise<void>;
    touchLastLogin(userId: number): Promise<void>;
    setUserStatus(userId: number, status: string): Promise<void>;
    deleteUser(userId: number): Promise<void>;
    listUsers(filter: UserFilter): Promise<{ users: User[]; pagination: Pagination }>;
    /** 校验密码；第二个返回值表示摘要是否需要升级。 */
    checkPassword(hash: string, plain: string): Promise<PasswordCheckResult>;
  }
}

function normalizeCreateInput(input: CreateUserInput): CreateUserInput {
  const role = (input.role || "viewer") as Role;
  if (!roleValid(role)) throw invalidInput("角色不合法");
  return {
    username: input.username.trim(),
    email: input.email.trim().toLowerCase(),
    fullName: input.fullName.trim(),
    password: input.password,
    role,
  };
}

Store.prototype.getUserById = async function (this: Store, id: number): Promise<User | null> {
  return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first<User>();
};

Store.prototype.getUserByIdentifier = async function (this: Store, identifier: string): Promise<User | null> {
  const id = identifier.trim();
  return this.db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ? OR email = ? LIMIT 1`)
    .bind(id, id.toLowerCase())
    .first<User>();
};

Store.prototype.getUserByEmail = async function (this: Store, email: string): Promise<User | null> {
  return this.db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ? LIMIT 1`)
    .bind(email.trim().toLowerCase())
    .first<User>();
};

Store.prototype.countUsers = async function (this: Store): Promise<number> {
  const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return row?.n ?? 0;
};

Store.prototype.countActiveAdmins = async function (this: Store): Promise<number> {
  const row = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = ? AND status = ?`)
    .bind("admin", USER_STATUS_ACTIVE)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

/** 写入一条用户记录；返回新 ID。 */
async function insertUser(
  store: Store,
  input: CreateUserInput,
  passwordHash: string,
): Promise<number> {
  const now = nowUtcIso();
  const res = await store.db
    .prepare(
      `INSERT INTO users (username, email, password_hash, full_name, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.username, input.email, passwordHash, input.fullName, input.role, USER_STATUS_ACTIVE, now, now)
    .run();
  return Number((res.meta as { last_row_id?: number }).last_row_id ?? 0);
}

Store.prototype.createUser = async function (this: Store, raw: CreateUserInput): Promise<User> {
  const input = normalizeCreateInput(raw);
  const hash = await hashPassword(input.password);
  let id: number;
  try {
    id = await insertUser(this, input, hash);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(conflictMessage(uniqueField(err)));
    throw err;
  }
  const user = await this.getUserById(id);
  if (!user) throw notFound();
  return user;
};

/**
 * 在一个事务内创建账号并写入安全问题。
 *
 * 早先注册流程是「CreateUser 成功后再 SetSecurityQuestions，失败则手工删除补偿」：
 * 补偿本身也可能失败，留下一个没有安全问题、又已被并发登录写入了会话的半成品账号。
 * 安全问题与账号必须同生同死 —— D1 的 batch 是原子的，这里天然满足。
 */
Store.prototype.createUserWithQuestions = async function (
  this: Store,
  raw: CreateUserInput,
  questions: { question: string; answer: string }[],
): Promise<User> {
  const input = normalizeCreateInput(raw);

  // 哈希计算刻意放在 batch 之外：批量事务会占用数据库写锁，
  // 不该让几次 PBKDF2 运算一直占着它。
  const userHash = await hashPassword(input.password);
  const answerHashes = await Promise.all(questions.map((q) => hashPassword(normalizeAnswer(q.answer))));

  const now = nowUtcIso();
  const statements = [
    this.db
      .prepare(
        `INSERT INTO users (username, email, password_hash, full_name, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.username, input.email, userHash, input.fullName, input.role, USER_STATUS_ACTIVE, now, now),
    ...questions.map((q, i) =>
      this.db
        .prepare(
          `INSERT INTO security_questions (user_id, position, question, answer_hash, created_at, updated_at)
           SELECT id, ?, ?, ?, ?, ? FROM users WHERE username = ?`,
        )
        .bind(i + 1, q.question.trim(), answerHashes[i], now, now, input.username),
    ),
  ];

  let results: D1Result<unknown>[];
  try {
    results = await this.db.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(conflictMessage(uniqueField(err)));
    throw err;
  }

  const id = Number((results[0].meta as { last_row_id?: number }).last_row_id ?? 0);
  const user = await this.getUserById(id);
  if (!user) throw notFound();
  return user;
};

Store.prototype.updateProfile = async function (
  this: Store,
  userId: number,
  fullName: string,
  email: string,
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!isValidEmail(normalized)) throw invalidInput("邮箱格式不正确");
  try {
    const res = await this.db
      .prepare(`UPDATE users SET full_name = ?, email = ?, updated_at = ? WHERE id = ?`)
      .bind(fullName.trim(), normalized, nowUtcIso(), userId)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      // 用户已不存在（例如刚被管理员删除）。不检查的话这里会静默成功，
      // 页面提示「资料已更新」，实际上一行都没改 —— 这类假成功最难排查。
      throw notFound();
    }
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(conflictMessage(uniqueField(err)));
    throw err;
  }
};

/**
 * 管理员修改用户资料、角色与状态。
 *
 * 「最后一个管理员检查」直接写进 UPDATE 的 WHERE 子句，让「检查 + 写入」
 * 成为**同一条语句**：拆成两次执行时，中间可以插进并发提权 / 降权，
 * 两个请求都看到「还有 2 个管理员」然后各降一级，最后系统一个管理员都不剩。
 */
Store.prototype.updateUserByAdmin = async function (
  this: Store,
  userId: number,
  input: AdminUpdateUserInput,
): Promise<void> {
  if (!roleValid(input.role)) throw invalidInput("角色不合法");
  if (input.status !== USER_STATUS_ACTIVE && input.status !== USER_STATUS_DISABLED) {
    throw invalidInput("状态不合法");
  }
  const email = input.email.trim().toLowerCase();
  if (!isValidEmail(email)) throw invalidInput("邮箱格式不正确");

  const passwordHash = input.password && input.password.trim() !== "" ? await hashPassword(input.password) : "";
  const now = nowUtcIso();

  const guard = `(
    (? = 'admin' AND ? = 'active')
    OR NOT (role = 'admin' AND status = 'active')
    OR (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active') > 1
  )`;

  try {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE users SET full_name = ?, email = ?, role = ?, status = ?, updated_at = ?
           WHERE id = ? AND ${guard}`,
        )
        .bind(input.fullName.trim(), email, input.role, input.status, now, userId, input.role, input.status),
      // 重置密码与踢会话，同样只在上面那条更新确实生效时执行
      this.db
        .prepare(
          `UPDATE users SET password_hash = ?, updated_at = ?
           WHERE id = ? AND role = ? AND status = ? AND ? <> ''`,
        )
        .bind(passwordHash, now, userId, input.role, input.status, passwordHash),
      this.db
        .prepare(
          `DELETE FROM sessions WHERE user_id = ? AND ? <> ''
             AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)`,
        )
        .bind(userId, passwordHash, userId, passwordHash),
    ]);

    if ((results[0].meta.changes ?? 0) === 0) {
      const current = await this.getUserById(userId);
      if (!current) throw notFound();
      throw new AppError("lastAdmin");
    }
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(conflictMessage(uniqueField(err)));
    throw err;
  }
};

Store.prototype.setPassword = async function (
  this: Store,
  userId: number,
  newPassword: string,
): Promise<void> {
  const hash = await hashPassword(newPassword);
  const res = await this.db
    .prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`)
    .bind(hash, nowUtcIso(), userId)
    .run();
  if ((res.meta.changes ?? 0) === 0) throw notFound();
};

Store.prototype.changePassword = async function (
  this: Store,
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await this.getUserById(userId);
  if (!user) throw notFound();
  const { ok } = await this.checkPassword(user.passwordHash, currentPassword);
  if (!ok) throw new AppError("invalidCredentials", "当前密码不正确");
  await this.setPassword(userId, newPassword);
};

Store.prototype.touchLastLogin = async function (this: Store, userId: number): Promise<void> {
  await this.db
    .prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`)
    .bind(nowUtcIso(), userId)
    .run();
};

Store.prototype.setUserStatus = async function (
  this: Store,
  userId: number,
  status: string,
): Promise<void> {
  // 状态必须落在白名单内。这个函数会把参数原样写进 status 列，而登录鉴权只认
  // active —— 放任意字符串进来，一次畸形请求就能把账号改成「既不是 active
  // 也不是 disabled」的状态，账号从此登不上，界面上的「启用」按钮也救不回来。
  if (status !== USER_STATUS_ACTIVE && status !== USER_STATUS_DISABLED) {
    throw invalidInput(`状态不合法（可选 ${USER_STATUS_ACTIVE} / ${USER_STATUS_DISABLED}）`);
  }

  const guard = `(
    ? = 'active'
    OR NOT (role = 'admin' AND status = 'active')
    OR (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active') > 1
  )`;
  const res = await this.db
    .prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND ${guard}`)
    .bind(status, nowUtcIso(), userId, status)
    .run();

  if ((res.meta.changes ?? 0) === 0) {
    const current = await this.getUserById(userId);
    if (!current) throw notFound();
    throw new AppError("lastAdmin");
  }
};

/**
 * 删除账号。
 *
 * 「最后一个管理员」与「是否有流水」两项检查与 DELETE 必须在同一条语句里：
 * 拆开执行时，两次检查之间只要有人用该账号做了一次出入库，DELETE 就会把
 * 带审计记录的账号删掉。
 */
Store.prototype.deleteUser = async function (this: Store, userId: number): Promise<void> {
  const res = await this.db
    .prepare(
      `DELETE FROM users
       WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM stock_movements WHERE operator_id = users.id)
         AND (
           NOT (role = 'admin' AND status = 'active')
           OR (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active') > 1
         )`,
    )
    .bind(userId)
    .run();

  if ((res.meta.changes ?? 0) > 0) return;

  const user = await this.getUserById(userId);
  if (!user) throw notFound();

  const movements = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM stock_movements WHERE operator_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  if ((movements?.n ?? 0) > 0) {
    throw invalidInput(`该用户已有 ${movements!.n} 条库存操作记录，建议改为「禁用」而非删除`);
  }
  throw new AppError("lastAdmin");
};

Store.prototype.listUsers = async function (
  this: Store,
  filter: UserFilter,
): Promise<{ users: User[]; pagination: Pagination }> {
  const where: string[] = ["1=1"];
  const args: unknown[] = [];

  if (filter.search) {
    const like = likePattern(filter.search);
    where.push(`(username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR full_name LIKE ? ESCAPE '\\')`);
    args.push(like, like, like);
  }
  if (filter.role) {
    where.push(`role = ?`);
    args.push(filter.role);
  }
  if (filter.status) {
    where.push(`status = ?`);
    args.push(filter.status);
  }
  const whereSql = where.join(" AND ");

  const countRow = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE ${whereSql}`)
    .bind(...args)
    .first<{ n: number }>();
  const total = countRow?.n ?? 0;

  const pg = newPagination(filter.page ?? 1, filter.perPage ?? 20, total);

  const rows = await this.db
    .prepare(
      `SELECT ${USER_COLUMNS} FROM users WHERE ${whereSql}
       ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, id ASC
       LIMIT ? OFFSET ?`,
    )
    .bind(...args, pg.perPage, pg.offset)
    .all<User>();

  return { users: rows.results ?? [], pagination: pg };
};

/** 校验密码，并顺带判断摘要是否需要升级到最新的 PBKDF2 参数。 */
Store.prototype.checkPassword = async function (
  this: Store,
  hash: string,
  plain: string,
): Promise<PasswordCheckResult> {
  const ok = await verifyPassword(hash, plain);
  if (!ok) return { ok: false };
  if (needsRehash(hash)) {
    return { ok: true, upgradedHash: await hashPassword(plain) };
  }
  return { ok: true };
};

/** 归一化安全问题的答案（与原版 services.NormalizeAnswer 一致）。 */
export function normalizeAnswer(s: string): string {
  return s.trim().split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

/** SKU 规范化复用（供商品模块）。 */
export const normalizeSkuForStore = normalizeSku;

/** 供其它模块复用的错误码类型导出。 */
export type { ErrorCode };
