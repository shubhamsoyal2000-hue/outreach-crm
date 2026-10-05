// Cheap checks that run before any paid verification call.

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().replace(/^mailto:/, "");
}

export function isValidSyntax(email: string): boolean {
  if (email.length > 254) return false;
  const [local, domain] = email.split("@");
  if (!local || !domain || local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return EMAIL_RE.test(email);
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Shared mailboxes nobody personally owns. Cold email to these gets reported as spam. */
const ROLE_LOCAL_PARTS = new Set([
  "info", "sales", "support", "contact", "admin", "office", "hello", "help", "service",
  "customerservice", "enquiries", "inquiries", "billing", "accounts", "accounting", "ap", "ar",
  "hr", "jobs", "careers", "marketing", "media", "press", "webmaster", "postmaster", "abuse",
  "noreply", "no-reply", "donotreply", "do-not-reply", "mail", "team", "orders", "general",
  "reception", "privacy", "legal", "security", "spam", "root", "list", "newsletter",
]);

export function isRoleAddress(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf("@")).split("+")[0];
  return ROLE_LOCAL_PARTS.has(local);
}

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org",
  "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com",
  "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mailnesia.com", "moakt.com",
]);

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain);
}

const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net",
  "att.net", "sbcglobal.net", "verizon.net", "proton.me", "protonmail.com", "gmx.com", "zoho.com",
]);

/** Personal mailbox providers: their domain says nothing about the company. */
export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain);
}

/** "https://www.Acme-Imports.com/about" -> "acme-imports.com" */
export function domainFromWebsite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#:]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

/** A matching key for company names: "ACME Imports, Inc." and "Acme Imports Inc" match. */
export function companyNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|lp|llp|plc|usa|us)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type PrecheckResult = { ok: true } | { ok: false; reason: "syntax" | "role" | "disposable" };

export function precheck(email: string): PrecheckResult {
  if (!isValidSyntax(email)) return { ok: false, reason: "syntax" };
  if (isRoleAddress(email)) return { ok: false, reason: "role" };
  if (isDisposableDomain(emailDomain(email))) return { ok: false, reason: "disposable" };
  return { ok: true };
}
