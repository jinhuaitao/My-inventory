// 会话与登录 / 找回密码尝试记录 —— 对应原 Go 版 internal/services/session.go。

import { nowUtcIso } from "../lib/time";
import { notFound } from "../lib/errors";
import { USER_STATUS_ACTIVE, type Session, type User } from "../types";
import { Store } from "./store";

const SESSION_COLUMNS = `id, user_id AS userId, token_hash AS tokenHash, csrf_token AS csrfToken,
  expires_at AS expiresAt, created_at AS createdAt, user_agent AS userAgent, ip`;

const USER_COLUMNS = `u.id AS id, u.username AS username, u.email AS email, u.password_hash AS passwordHash,
  u.full_name AS fullName, u.role AS role, u.status AS status, u.last_login_at AS lastLoginAt,
  u.created_at AS createdAt, u.updated_at AS updatedAt`;

/** 归一化限流用的账号标识。 */
export function normalizeAttemptIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

declare module "./store" {
  interface Store {
    createSession(session: Omit<Session, "id" | "createdAt">): Promise<number>;
    getSessionUser(tokenHash: string): Promise<{ session: Session; user: User } | null>;
    deleteSession(tokenHash: string): Promise<void>;
    deleteSessionsByUser(userId: number, exceptTokenHash?: string): Promise<number>;
    deleteSessionById(id: number, userId: number): Promise<void>;
    cleanupExpiredSessions(): Promise<number>;
    listUserSessions(userId: number): Promise<Session[]>;
    upgradePasswordHash(userId: number, hash: string): Promise<void>;

    recordRecoveryAttempt(userId: number, identifier: string, ip: string, success: boolean): Promise<void>;
    recordBlockedRecoveryAttempt(userId: number, identifier: string, ip: string): Promise<void>;
    countFailedRecovery(userId: number, sinceIso: string): Promise<number>;
    countFailedRecoveryByIdentifier(identifier: string, sinceIso: string): Promise<number>;
    countFailedRecoveryByIdentifierAndIp(identifier: string, ip: string, sinceIso: string): Promise<number>;
    countFailedRecoveryByUserAndIp(userId: number, ip: string, sinceIso: string): Promise<number>;
    clearFailedRecovery(userId: number): Promise<void>;
    cleanupRecoveryAttempts(beforeIso: string): Promise<number>;

    recordLoginAttempt(identifier: string, ip: string, success: boolean): Promise<void>;
    recordBlockedLoginAttempt(identifier: string, ip: string): Promise<void>;
    countFailedAttempts(identifier: string, sinceIso: string): Promise<number>;
    countFailedAttemptsByIdentifierAndIp(identifier: string, ip: string, sinceIso: string): Promise<number>;
    clearFailedAttempts(identifier: string): Promise<void>;
    cleanupLoginAttempts(beforeIso: string): Promise<number>;
  }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

Store.prototype.createSession = async function (
  this: Store,
  session: Omit<Session, "id" | "createdAt">,
): Promise<number> {
  const res = await this.db
    .prepare(
      `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, created_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      session.userId,
      session.tokenHash,
      session.csrfToken,
      session.expiresAt,
      nowUtcIso(),
      session.userAgent,
      session.ip,
    )
    .run();
  return Number((res.meta as { last_row_id?: number } | undefined)?.last_row_id ?? 0);
};

/** 通过令牌摘要一次性加载会话与关联用户。 */
Store.prototype.getSessionUser = async function (
  this: Store,
  tokenHash: string,
): Promise<{ session: Session; user: User } | null> {
  const row = await this.db
    .prepare(
      `SELECT s.id AS sessionId, s.user_id AS userId, s.token_hash AS tokenHash, s.csrf_token AS csrfToken,
              s.expires_at AS expiresAt, s.created_at AS sessionCreatedAt, s.user_agent AS userAgent, s.ip AS ip,
              ${USER_COLUMNS}
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<Session & User & { sessionId: number; sessionCreatedAt: string }>();

  if (!row) return null;

  const session: Session = {
    id: row.sessionId,
    userId: row.userId,
    tokenHash: row.tokenHash,
    csrfToken: row.csrfToken,
    expiresAt: row.expiresAt,
    createdAt: row.sessionCreatedAt,
    userAgent: row.userAgent,
    ip: row.ip,
  };
  const user: User = {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.passwordHash,
    fullName: row.fullName,
    role: row.role,
    status: row.status,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return { session, user };
};

Store.prototype.deleteSession = async function (this: Store, tokenHash: string): Promise<void> {
  await this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
};

Store.prototype.deleteSessionsByUser = async function (
  this: Store,
  userId: number,
  exceptTokenHash?: string,
): Promise<number> {
  const res = exceptTokenHash
    ? await this.db
        .prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`)
        .bind(userId, exceptTokenHash)
        .run()
    : await this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
  return res.meta.changes ?? 0;
};

/** 删除指定用户的一条会话；userID 参与条件判断，确保用户只能操作自己的会话。 */
Store.prototype.deleteSessionById = async function (
  this: Store,
  id: number,
  userId: number,
): Promise<void> {
  const res = await this.db
    .prepare(`DELETE FROM sessions WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    throw notFound();
  }
};

Store.prototype.cleanupExpiredSessions = async function (this: Store): Promise<number> {
  const res = await this.db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(nowUtcIso()).run();
  return res.meta.changes ?? 0;
};

Store.prototype.listUserSessions = async function (this: Store, userId: number): Promise<Session[]> {
  const rows = await this.db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .bind(userId, nowUtcIso())
    .all<Session>();
  return rows.results ?? [];
};

/** 登录成功后把陈旧的密码摘要（bcrypt / 低迭代 PBKDF2）升级为最新格式。 */
Store.prototype.upgradePasswordHash = async function (
  this: Store,
  userId: number,
  hash: string,
): Promise<void> {
  await this.db
    .prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`)
    .bind(hash, nowUtcIso(), userId)
    .run();
};

// ---------------------------------------------------------------------------
// 找回密码尝试（限制安全问题答题的暴力破解）
// ---------------------------------------------------------------------------

Store.prototype.recordRecoveryAttempt = async function (
  this: Store,
  userId: number,
  identifier: string,
  ip: string,
  success: boolean,
): Promise<void> {
  await this.db
    .prepare(
      `INSERT INTO recovery_attempts (user_id, identifier, ip, success, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(userId, normalizeAttemptIdentifier(identifier), ip, success ? 1 : 0, nowUtcIso())
    .run();
};

/**
 * 记录一次「因已被限流而拒绝」的尝试。
 *
 * 与普通失败必须区分开（blocked = 1）：限流判断发生在校验**之前**，攻击者只要在
 * 被锁期间持续发请求，每次都会写入一条新的失败记录、把计数窗口一路往后推，
 * 受害者的账号就永远不会解锁 —— 一个请求/分钟即可永久拒绝服务。
 */
Store.prototype.recordBlockedRecoveryAttempt = async function (
  this: Store,
  userId: number,
  identifier: string,
  ip: string,
): Promise<void> {
  await this.db
    .prepare(
      `INSERT INTO recovery_attempts (user_id, identifier, ip, success, blocked, created_at)
       VALUES (?, ?, ?, 0, 1, ?)`,
    )
    .bind(userId, normalizeAttemptIdentifier(identifier), ip, nowUtcIso())
    .run();
};

Store.prototype.countFailedRecovery = async function (
  this: Store,
  userId: number,
  sinceIso: string,
): Promise<number> {
  const row = await this.db
    .prepare(
      `SELECT COUNT(*) AS n FROM recovery_attempts
       WHERE user_id = ? AND success = 0 AND blocked = 0 AND created_at >= ?`,
    )
    .bind(userId, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

Store.prototype.countFailedRecoveryByIdentifier = async function (
  this: Store,
  identifier: string,
  sinceIso: string,
): Promise<number> {
  const id = normalizeAttemptIdentifier(identifier);
  if (id === "") return 0;
  const row = await this.db
    .prepare(
      `SELECT COUNT(*) AS n FROM recovery_attempts
       WHERE identifier = ? AND success = 0 AND blocked = 0 AND created_at >= ?`,
    )
    .bind(id, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

Store.prototype.countFailedRecoveryByIdentifierAndIp = async function (
  this: Store,
  identifier: string,
  ip: string,
  sinceIso: string,
): Promise<number> {
  const id = normalizeAttemptIdentifier(identifier);
  if (id === "") return 0;
  const row = await this.db
    .prepare(
      `SELECT COUNT(*) AS n FROM recovery_attempts
       WHERE identifier = ? AND ip = ? AND success = 0 AND blocked = 0 AND created_at >= ?`,
    )
    .bind(id, ip, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

Store.prototype.countFailedRecoveryByUserAndIp = async function (
  this: Store,
  userId: number,
  ip: string,
  sinceIso: string,
): Promise<number> {
  const row = await this.db
    .prepare(
      `SELECT COUNT(*) AS n FROM recovery_attempts
       WHERE user_id = ? AND ip = ? AND success = 0 AND blocked = 0 AND created_at >= ?`,
    )
    .bind(userId, ip, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

Store.prototype.clearFailedRecovery = async function (this: Store, userId: number): Promise<void> {
  await this.db.prepare(`DELETE FROM recovery_attempts WHERE user_id = ? AND success = 0`).bind(userId).run();
};

Store.prototype.cleanupRecoveryAttempts = async function (this: Store, beforeIso: string): Promise<number> {
  const res = await this.db.prepare(`DELETE FROM recovery_attempts WHERE created_at < ?`).bind(beforeIso).run();
  return res.meta.changes ?? 0;
};

// ---------------------------------------------------------------------------
// 登录尝试
// ---------------------------------------------------------------------------

Store.prototype.recordLoginAttempt = async function (
  this: Store,
  identifier: string,
  ip: string,
  success: boolean,
): Promise<void> {
  await this.db
    .prepare(`INSERT INTO login_attempts (identifier, ip, success, created_at) VALUES (?, ?, ?, ?)`)
    .bind(normalizeAttemptIdentifier(identifier), ip, success ? 1 : 0, nowUtcIso())
    .run();
};

Store.prototype.recordBlockedLoginAttempt = async function (
  this: Store,
  identifier: string,
  ip: string,
): Promise<void> {
  await this.db
    .prepare(`INSERT INTO login_attempts (identifier, ip, success, blocked, created_at) VALUES (?, ?, 0, 1, ?)`)
    .bind(normalizeAttemptIdentifier(identifier), ip, nowUtcIso())
    .run();
};

Store.prototype.countFailedAttempts = async function (
  this: Store,
  identifier: string,
  sinceIso: string,
): Promise<number> {
  const row = await this.db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_attempts
       WHERE identifier = ? AND success = 0 AND blocked = 0 AND created_at >= ?`,
    )
    .bind(normalizeAttemptIdentifier(identifier), sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

Store.prototype.countFailedAttemptsByIdentifierAndIp = async function (
  this: Store,
  identifier: string,
  ip: string,
  sinceIso: string,
): Promise<number> {
  const row = await this.db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_attempts
       WHERE identifier = ? AND ip = ? AND success = 0 AND blocked = 0 AND created_at >= ?`,
    )
    .bind(normalizeAttemptIdentifier(identifier), ip, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

Store.prototype.clearFailedAttempts = async function (this: Store, identifier: string): Promise<void> {
  await this.db
    .prepare(`DELETE FROM login_attempts WHERE identifier = ? AND success = 0`)
    .bind(normalizeAttemptIdentifier(identifier))
    .run();
};

Store.prototype.cleanupLoginAttempts = async function (this: Store, beforeIso: string): Promise<number> {
  const res = await this.db.prepare(`DELETE FROM login_attempts WHERE created_at < ?`).bind(beforeIso).run();
  return res.meta.changes ?? 0;
};

/** 用户是否为启用状态（供会话校验使用）。 */
export function isActiveUser(user: Pick<User, "status">): boolean {
  return user.status === USER_STATUS_ACTIVE;
}
