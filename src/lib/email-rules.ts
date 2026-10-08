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

/** "cc.us.dsv.com" -> ["cc.us.dsv.com", "us.dsv.com", "dsv.com"], so blocking dsv.com covers its subdomains. */
export function domainAndParents(domain: string): string[] {
  const parts = domain.split(".");
  const out: string[] = [];
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join("."));
  return out;
}

/** Shared business inboxes (info@, sales@...). Skipped unless Settings allows them: they reply, but get more spam reports. */
const SHARED_LOCAL_PARTS = new Set([
  "info", "sales", "support", "contact", "admin", "office", "hello", "help", "service",
  "customerservice", "enquiries", "inquiries", "billing", "accounts", "accounting", "ap", "ar",
  "marketing", "mail", "team", "orders", "general", "reception",
]);

/** Mailboxes that never want sales email (no-reply, abuse, job applications...). Always skipped. */
const NEVER_LOCAL_PARTS = new Set([
  "hr", "jobs", "careers", "media", "press", "webmaster", "postmaster", "abuse", "noreply", "no-reply",
  "donotreply", "do-not-reply", "privacy", "legal", "security", "spam", "root", "list", "newsletter",
]);

function localPart(email: string): string {
  return email.slice(0, email.lastIndexOf("@")).split("+")[0];
}

/** True for shared inboxes that should be skipped, given whether Settings allows info@/sales@ style ones. */
export function isRoleAddress(email: string, allowShared = false): boolean {
  const local = localPart(email);
  return NEVER_LOCAL_PARTS.has(local) || (!allowShared && SHARED_LOCAL_PARTS.has(local));
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
  "yahoo.co.in", "yahoo.com.cn", "hotmail.co.uk", "live.cn", "rediffmail.com",
  // Common overseas providers that freight agents use.
  "qq.com", "163.com", "126.com", "foxmail.com", "sina.com", "sina.cn", "sohu.com", "yeah.net", "aliyun.com", "139.com",
  "naver.com", "hanmail.net", "daum.net", "yandex.ru", "mail.ru", "gmx.de", "web.de",
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

export function precheck(email: string, opts: { allowShared?: boolean } = {}): PrecheckResult {
  if (!isValidSyntax(email)) return { ok: false, reason: "syntax" };
  if (isRoleAddress(email, opts.allowShared)) return { ok: false, reason: "role" };
  if (isDisposableDomain(emailDomain(email))) return { ok: false, reason: "disposable" };
  return { ok: true };
}
