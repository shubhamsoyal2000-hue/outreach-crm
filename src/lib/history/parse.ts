import { domainAndParents, emailDomain, isFreemailDomain, isValidSyntax, normalizeEmail, precheck } from "../email-rules";

export interface ParsedAddress {
  email: string;
  name: string;
}

const ADDRESS = /"([^"]*)"\s*<([^>]+)>|([^,<>"]*)<([^>]+)>|([^\s,;<>"]+@[^\s,;<>"]+)/g;

/** Every address in a To/Cc/Bcc header, lower-cased, with the display name when there is one. */
export function parseAddressList(header: string | undefined): ParsedAddress[] {
  if (!header) return [];
  const out: ParsedAddress[] = [];
  const seen = new Set<string>();
  for (const m of header.matchAll(ADDRESS)) {
    const email = normalizeEmail(m[2] ?? m[4] ?? m[5] ?? "");
    const name = (m[1] ?? m[3] ?? "").trim().replace(/^'+|'+$/g, "");
    if (!isValidSyntax(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: name.includes("@") ? "" : name });
  }
  return out;
}

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Which of the addresses we wrote to a bounce is about: the X-Failed-Recipients
 * header when the bounce has one, else addresses it mentions that we did write
 * to, else the only recipient of the thread it landed in.
 */
export function bounceTargets(failedHeader: string | undefined, text: string, threadRecipients: string[]): string[] {
  const fromHeader = parseAddressList(failedHeader).map((a) => a.email);
  if (fromHeader.length) return fromHeader;
  const mentioned = new Set((text.match(EMAIL_IN_TEXT) ?? []).map((e) => normalizeEmail(e)));
  const hits = threadRecipients.filter((r) => mentioned.has(r));
  if (hits.length) return hits;
  return threadRecipients.length === 1 ? threadRecipients : [];
}

const CARRIER_LOCAL = /(dispatch|trucking|carrier|loadboard|^loads?\b|^drivers?\b|^fleet\b|^safety\b|^eld\b|factoring|owner.?operator)/;
const CARRIER_DOMAIN = /(trucking|truckline|freightline|transport(?!ation(broker|brokerage))|hauling|haulers?|carriers?\b|cartage|dispatch|expressinc|roadway)/;
const CARRIER_FREEMAIL_LOCAL = /(truck|transport|dispatch|freight|carrier|haul|express|logistic|cargo|load)/;

/** Why an address looks like a trucking company or dispatcher rather than a shipper, if it does. */
export function carrierReason(email: string): string | null {
  const local = email.slice(0, email.lastIndexOf("@"));
  const domain = emailDomain(email);
  const label = domain.split(".").slice(0, -1).join(".");
  if (isFreemailDomain(domain)) {
    return CARRIER_FREEMAIL_LOCAL.test(local)
      ? "personal email with a trucking-style name"
      : "personal address (Gmail, Yahoo, QQ...): could be a carrier, a dispatcher or an overseas agent";
  }
  if (CARRIER_LOCAL.test(local)) return `"${local}@" is a carrier-style inbox`;
  if (CARRIER_DOMAIN.test(label)) return `company name "${label}" sounds like a carrier`;
  return null;
}

export interface HistoryAddressRow {
  email: string;
  name: string | null;
  first_sent: string;
  last_sent: string;
  sent_count: number;
  inboxes: string[];
  bounced_at: string | null;
  replied_at: string | null;
  reply_count: number;
  opted_out_at: string | null;
  in_crm: boolean;
  suppressed: boolean;
}

export type HistoryGroup = "bounced" | "opted_out" | "replied" | "recent" | "older" | "carrier" | "internal";

export interface ClassifiedAddress extends HistoryAddressRow {
  group: HistoryGroup;
  reason: string;
}

export interface ClassifyOptions {
  now: Date;
  /** Delivered this recently without a bounce counts as verified. */
  recentDays: number;
  /** Our own addresses: the sending inboxes and the alert address. */
  ownEmails: string[];
  /** Our own company domains, and a squashed company name ("cargosolution") that marks colleagues. */
  ownDomains: string[];
  companyToken: string;
  allowShared: boolean;
  /** Domains on the Do not email list. */
  blockedDomains?: string[];
}

/** Sorts every address we wrote to into the groups the review page shows. */
export function classifyHistory(rows: HistoryAddressRow[], o: ClassifyOptions): ClassifiedAddress[] {
  const own = new Set(o.ownEmails.map(normalizeEmail));
  const ownDomains = new Set(o.ownDomains);
  const blocked = new Set(o.blockedDomains ?? []);
  const recentSince = o.now.getTime() - o.recentDays * 86_400_000;

  // A reply from anyone at a company domain counts for their colleagues too.
  const repliedDomains = new Set(
    rows.filter((r) => r.replied_at && !isFreemailDomain(emailDomain(r.email))).map((r) => emailDomain(r.email)),
  );

  return rows.map((r) => {
    const domain = emailDomain(r.email);
    const at = (group: HistoryGroup, reason: string): ClassifiedAddress => ({ ...r, group, reason });

    if (own.has(r.email) || ownDomains.has(domain) || (o.companyToken && domain.replace(/[^a-z0-9]/g, "").includes(o.companyToken))) {
      return at("internal", "your own team");
    }
    if (domainAndParents(domain).some((d) => blocked.has(d))) return at("internal", "company is on your Do not email list");
    const check = precheck(r.email, { allowShared: o.allowShared });
    if (!check.ok) return at("internal", check.reason === "role" ? "no-reply or system inbox" : `not usable (${check.reason})`);

    if (r.opted_out_at) return at("opted_out", "asked you to stop emailing");
    const bouncedLast = r.bounced_at && (!r.replied_at || new Date(r.replied_at) < new Date(r.bounced_at));
    if (bouncedLast) return at("bounced", "bounced");
    if (r.replied_at) return at("replied", `replied ${r.reply_count === 1 ? "once" : `${r.reply_count} times`}`);
    if (repliedDomains.has(domain)) return at("replied", "a colleague at this company replied");

    const carrier = carrierReason(r.email);
    if (carrier) return at("carrier", carrier);
    if (new Date(r.last_sent).getTime() >= recentSince) return at("recent", "delivered recently, no bounce");
    return at("older", "delivered, but before the last 3 months");
  });
}

/** "cargo solution brokerage" -> "cargosolution": the part of the name that shows up in our own domains. */
export function companyToken(companyName: string): string {
  const words = companyName.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const generic = new Set(["llc", "inc", "ltd", "co", "corp", "company", "brokerage", "logistics", "group", "the"]);
  const core = words.filter((w) => !generic.has(w));
  const token = core.slice(0, 2).join("");
  return token.length >= 6 ? token : "";
}

/** "Jane Doe" -> ["Jane", "Doe"], ignoring names that are just the address again. */
export function splitName(name: string | null): { first: string; last: string } {
  const clean = (name ?? "").replace(/[()"]/g, "").trim();
  if (!clean || clean.includes("@")) return { first: "", last: "" };
  if (clean.includes(",")) {
    const [last, first] = clean.split(",").map((s) => s.trim());
    return { first: first.split(/\s+/)[0] ?? "", last };
  }
  const parts = clean.split(/\s+/);
  return { first: parts[0], last: parts.length > 1 ? parts[parts.length - 1] : "" };
}
