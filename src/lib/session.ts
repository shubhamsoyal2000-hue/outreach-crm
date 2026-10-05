import { sign, unsign } from "./crypto";

export const SESSION_COOKIE = "crm_session";
const SESSION_DAYS = 14;

export function newSessionToken(secret: string, now = Date.now()): string {
  return sign(secret, `session.${now + SESSION_DAYS * 86_400_000}`);
}

export function isValidSession(secret: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const value = unsign(secret, token);
  if (!value?.startsWith("session.")) return false;
  return Number(value.slice("session.".length)) > now;
}

export const sessionMaxAge = SESSION_DAYS * 86_400;
