// 安全问题 —— 对应原 Go 版 internal/services/security.go。

import { hashPassword, verifyPassword } from "../lib/crypto";
import { AppError, invalidInput } from "../lib/errors";
import { nowUtcIso } from "../lib/time";
import { runeLength } from "../lib/validate";
import { SECURITY_QUESTION_COUNT, type AnswerInput, type SecurityQuestion } from "../types";
import { Store } from "./store";
import { normalizeAnswer } from "./users";

/** 安全问题与答案的长度限制（按字符数，而非字节数）。 */
export const SECURITY_QUESTION_MIN_LEN = 4;
export const SECURITY_QUESTION_MAX_LEN = 100;
export const SECURITY_ANSWER_MIN_LEN = 2;
export const SECURITY_ANSWER_MAX_LEN = 100;

declare module "./store" {
  interface Store {
    setSecurityQuestions(userId: number, inputs: AnswerInput[]): Promise<void>;
    getSecurityQuestions(userId: number): Promise<SecurityQuestion[]>;
    getSecurityQuestionTexts(userId: number): Promise<string[]>;
    countSecurityQuestions(userId: number): Promise<number>;
    hasSecurityQuestions(userId: number): Promise<boolean>;
    verifySecurityAnswers(userId: number, answers: string[]): Promise<boolean>;
    clearSecurityQuestions(userId: number): Promise<void>;
  }
}

/**
 * 校验一组安全问题的输入。抛出的错误已带「参数不合法」包装，可直接展示。
 */
export function validateSecurityAnswers(inputs: AnswerInput[]): void {
  if (inputs.length !== SECURITY_QUESTION_COUNT) {
    throw invalidInput(`需要设置 ${SECURITY_QUESTION_COUNT} 个安全问题`);
  }

  const seen = new Set<string>();
  for (let i = 0; i < inputs.length; i++) {
    const no = i + 1;
    const question = (inputs[i].question ?? "").trim();
    const answer = (inputs[i].answer ?? "").trim();

    const qLen = runeLength(question);
    if (qLen < SECURITY_QUESTION_MIN_LEN) {
      throw invalidInput(`第 ${no} 个问题至少需要 ${SECURITY_QUESTION_MIN_LEN} 个字`);
    }
    if (qLen > SECURITY_QUESTION_MAX_LEN) {
      throw invalidInput(`第 ${no} 个问题不能超过 ${SECURITY_QUESTION_MAX_LEN} 个字`);
    }

    const aLen = runeLength(answer);
    if (aLen < SECURITY_ANSWER_MIN_LEN) {
      throw invalidInput(`第 ${no} 个问题的答案至少需要 ${SECURITY_ANSWER_MIN_LEN} 个字`);
    }
    if (aLen > SECURITY_ANSWER_MAX_LEN) {
      throw invalidInput(`第 ${no} 个问题的答案不能超过 ${SECURITY_ANSWER_MAX_LEN} 个字`);
    }

    const key = question.toLowerCase();
    if (seen.has(key)) {
      throw invalidInput(`第 ${no} 个问题与前面的问题重复了`);
    }
    seen.add(key);
  }
}

/** 替换用户的全部安全问题（先清空再写入，整体在一个事务内）。 */
Store.prototype.setSecurityQuestions = async function (
  this: Store,
  userId: number,
  inputs: AnswerInput[],
): Promise<void> {
  validateSecurityAnswers(inputs);

  const hashes = await Promise.all(inputs.map((inp) => hashPassword(normalizeAnswer(inp.answer))));
  const now = nowUtcIso();

  await this.db.batch([
    this.db.prepare(`DELETE FROM security_questions WHERE user_id = ?`).bind(userId),
    ...inputs.map((inp, i) =>
      this.db
        .prepare(
          `INSERT INTO security_questions (user_id, position, question, answer_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, i + 1, inp.question.trim(), hashes[i], now, now),
    ),
  ]);
};

/** 返回用户已设置的安全问题（含答案摘要，仅供服务端校验）。 */
Store.prototype.getSecurityQuestions = async function (
  this: Store,
  userId: number,
): Promise<SecurityQuestion[]> {
  const rows = await this.db
    .prepare(
      `SELECT id, user_id AS userId, position, question, answer_hash AS answerHash,
              created_at AS createdAt, updated_at AS updatedAt
       FROM security_questions WHERE user_id = ? ORDER BY position ASC`,
    )
    .bind(userId)
    .all<SecurityQuestion>();
  return rows.results ?? [];
};

/** 只返回问题文本，供「找回密码」页面展示。 */
Store.prototype.getSecurityQuestionTexts = async function (
  this: Store,
  userId: number,
): Promise<string[]> {
  const questions = await this.getSecurityQuestions(userId);
  return questions.map((q) => q.question);
};

Store.prototype.countSecurityQuestions = async function (this: Store, userId: number): Promise<number> {
  const row = await this.db
    .prepare(`SELECT COUNT(*) AS n FROM security_questions WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

Store.prototype.hasSecurityQuestions = async function (this: Store, userId: number): Promise<boolean> {
  return (await this.countSecurityQuestions(userId)) >= SECURITY_QUESTION_COUNT;
};

/**
 * 校验用户提交的答案是否全部正确。
 *
 * 为了让耗时与答对数量无关，这里会校验**全部**题目，而不是遇到第一个错误就返回 ——
 * 否则攻击者可以用响应时间推测答对了几题。
 */
Store.prototype.verifySecurityAnswers = async function (
  this: Store,
  userId: number,
  answers: string[],
): Promise<boolean> {
  const questions = await this.getSecurityQuestions(userId);
  if (questions.length < SECURITY_QUESTION_COUNT) {
    throw new AppError("securityQuestionsNotSet");
  }
  if (answers.length !== questions.length) return false;

  const results = await Promise.all(
    questions.map((q) => verifyPassword(q.answerHash, normalizeAnswer(answers[q.position - 1] ?? ""))),
  );
  return results.every((r) => r);
};

Store.prototype.clearSecurityQuestions = async function (this: Store, userId: number): Promise<void> {
  await this.db.prepare(`DELETE FROM security_questions WHERE user_id = ?`).bind(userId).run();
};
