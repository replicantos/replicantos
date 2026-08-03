import { createHash, randomBytes } from "node:crypto";

import { hash, verify } from "@node-rs/argon2";
import type { FastifyReply } from "fastify";

export const SESSION_COOKIE_NAME = "replicantos_session";
export const SESSION_LIFETIME_SECONDS = 12 * 60 * 60;

const ARGON2ID_OPTIONS = Object.freeze({
  // @node-rs/argon2 defaults to Argon2id version 19. Tests assert the encoded
  // algorithm/version so a dependency default change cannot silently weaken it.
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});

export interface PasswordService {
  hashPassword(password: string): Promise<string>;
  verifyPassword(
    passwordHash: string | null,
    password: string,
  ): Promise<boolean>;
}

export async function createPasswordService(): Promise<PasswordService> {
  const dummyHash = await hash(
    randomBytes(32).toString("base64url"),
    ARGON2ID_OPTIONS,
  );

  return {
    async hashPassword(password) {
      return hash(password, ARGON2ID_OPTIONS);
    },
    async verifyPassword(passwordHash, password) {
      try {
        const valid = await verify(passwordHash ?? dummyHash, password);
        return passwordHash !== null && valid;
      } catch {
        return false;
      }
    },
  };
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  secure: boolean,
): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    maxAge: SESSION_LIFETIME_SECONDS,
    path: "/",
    sameSite: "strict",
    secure,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure,
  });
}
