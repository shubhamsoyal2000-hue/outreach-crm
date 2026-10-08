import { domainAndParents, emailDomain, normalizeEmail, precheck } from "./email-rules";

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Addresses an auto-reply points us to instead ("please contact purchasing@acme.com"):
 * only at the sender's own company domain, never the sender, never no-reply or
 * system inboxes. At most five.
 */
export function referredAddresses(text: string, o: { sender: string; companyDomain?: string | null; ownEmails?: string[] }): string[] {
  const sender = normalizeEmail(o.sender);
  const domains = new Set([emailDomain(sender), ...(o.companyDomain ? [o.companyDomain] : [])].filter(Boolean));
  const own = new Set((o.ownEmails ?? []).map(normalizeEmail));
  const out: string[] = [];
  for (const raw of text.match(EMAIL_IN_TEXT) ?? []) {
    const email = normalizeEmail(raw.replace(/\.$/, ""));
    if (email === sender || own.has(email) || out.includes(email)) continue;
    if (!domainAndParents(emailDomain(email)).some((d) => domains.has(d))) continue;
    if (!precheck(email, { allowShared: true }).ok) continue;
    out.push(email);
    if (out.length === 5) break;
  }
  return out;
}

/** Plain text from an HTML email body, enough to find addresses and phrases in. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<a\s[^>]*href="mailto:([^"?]+)[^"]*"[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#64;|&commat;/g, "@")
    .replace(/[ \t]+/g, " ");
}
