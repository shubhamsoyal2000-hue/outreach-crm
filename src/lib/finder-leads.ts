/**
 * Which email-finder addresses are worth a cold email. The finder reads whole
 * websites, so it also picks up press, careers and legal inboxes, foreign
 * head offices and full staff directories; those are left out.
 */

/** Most contacts to email at one company, so a staff directory never becomes 80 emails. */
export const FINDER_MAX_PER_COMPANY = 3;

/** Companies with more addresses than this are usually a foreign group's directory. */
export const FINDER_MAX_ADDRESSES = 25;

const FINDER_SOURCES = new Set(["website_finder", "research"]);
const US_LOOKING_DOMAIN = /\.(com|us|net|co)$/i;
const SKIP_LOCAL =
  /(media|press|news|career|job|hr|recruit|privacy|legal|claims|investor|^ir$|noreply|no-reply|donotreply|abuse|webmaster|billing|accounts?payable|^ap$|invoice|talent|marketing|^pr$|editor|compliance|security|dpo|gdpr|unsubscribe|wordpress|test|example)/i;
const LIKELY_BUYER = /^(sales|info|logistics|shipping|purchasing|import|operations|ops|orders|hello|contact)/i;

export function isFinderLead(contact: { email: string; source?: string | null }, companyDomain: string | null | undefined): boolean {
  if (!FINDER_SOURCES.has(contact.source ?? "")) return false;
  const [local, domain] = contact.email.toLowerCase().split("@");
  if (!domain || !companyDomain || domain !== companyDomain.toLowerCase()) return false;
  if (!US_LOOKING_DOMAIN.test(domain)) return false;
  return !SKIP_LOCAL.test(local);
}

/** Inboxes likely read by someone who books freight come first. */
export function finderRank(email: string): number {
  return LIKELY_BUYER.test(email.split("@")[0]) ? 0 : 1;
}
