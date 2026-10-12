// Pure HTML helpers for the website email finder: emails on a page, the pages
// worth reading next, the site's name, and the company websites a directory links to.

import { domainFromWebsite, isFreemailDomain, isValidSyntax } from "../email-rules";

export interface FoundEmail {
  email: string;
  first_name: string;
  last_name: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", period: "." };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Cloudflare's email protection: the first byte is the XOR key for the rest. */
export function decodeCfEmail(hex: string): string {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2) return "";
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ");
}

/** "john [at] acme [dot] com" and "john(at)acme.com" -> "john@acme.com" */
function unObfuscate(text: string): string {
  return text
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, "@")
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, ".");
}

const EMAIL_IN_TEXT = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const FILE_TLD = /\.(png|jpe?g|gif|webp|svg|bmp|ico|css|js|json|pdf|mp4|webm|woff2?|ttf)$/;
const DEPT_WORDS = new Set(["ops", "import", "imports", "export", "exports", "sea", "air", "ocean", "customs", "logistics", "team", "sales", "info", "admin", "support", "service", "office", "contact", "accounts", "usa", "us"]);

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** "john.smith@" -> John Smith; anything less clear stays blank rather than guessed wrong. */
export function nameFromEmail(email: string): [string, string] {
  const m = email.split("@")[0].match(/^([a-z]{2,15})[._-]([a-z]{2,20})$/);
  if (!m || DEPT_WORDS.has(m[1]) || DEPT_WORDS.has(m[2])) return ["", ""];
  return [titleCase(m[1]), titleCase(m[2])];
}

/** A link text like "John Smith" or "Mary-Ann O'Neil", not "Email us". */
function personName(text: string): [string, string] | null {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/^([A-Z][a-z'-]{1,20})\s+(?:[A-Z]\.\s+)?([A-Z][A-Za-z'-]{1,25})$/);
  if (!m || /^(email|contact|send|write|mail|click|sales|info|customer|general)$/i.test(m[1])) return null;
  return [m[1], m[2]];
}

function belongsTo(emailDomain: string, siteDomains: string[]): boolean {
  return siteDomains.some((d) => emailDomain === d || emailDomain.endsWith("." + d));
}

/** Emails on the page at the company's own domain(s). Other domains (web designers, plugins, free mail) are left out. */
export function extractEmails(html: string, siteDomains: string[]): FoundEmail[] {
  const names = new Map<string, [string, string]>();
  const raw: string[] = [];

  for (const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) raw.push(decodeCfEmail(m[1]));
  for (const m of html.matchAll(/email-protection#([0-9a-f]+)/gi)) raw.push(decodeCfEmail(m[1]));
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']\s*mailto:([^"'?]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let addr = m[1];
    try { addr = decodeURIComponent(addr); } catch { /* keep as is */ }
    addr = decodeEntities(addr).trim().toLowerCase();
    raw.push(addr);
    const who = personName(stripTags(m[2]));
    if (who) names.set(addr, who);
  }
  for (const m of html.matchAll(/mailto:([^"'?\s<>]+)/gi)) raw.push(decodeEntities(m[1]));
  for (const m of unObfuscate(stripTags(html)).matchAll(EMAIL_IN_TEXT)) raw.push(m[0]);

  const out: FoundEmail[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const email = r.trim().toLowerCase().replace(/^mailto:/, "").replace(/[.,;:]+$/, "");
    if (seen.has(email) || !isValidSyntax(email) || FILE_TLD.test(email)) continue;
    const domain = email.split("@")[1];
    if (!belongsTo(domain, siteDomains) || isFreemailDomain(domain)) continue;
    if (/^[0-9a-f]{16,}$/.test(email.split("@")[0])) continue;
    seen.add(email);
    const [first, last] = names.get(email) ?? nameFromEmail(email);
    out.push({ email, first_name: first, last_name: last });
  }
  return out;
}

interface Anchor {
  href: string;
  text: string;
}

function anchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = href ? (href[1] ?? href[2] ?? href[3] ?? "") : "";
    if (value) out.push({ href: decodeEntities(value.trim()), text: stripTags(m[2]).trim() });
  }
  return out;
}

const PAGE_HINTS: [RegExp, number][] = [
  [/contact/, 6],
  [/(our-)?team|staff|people|leadership|management|executives|directory|who-we-are/, 5],
  [/about/, 4],
  [/locations?|offices?|branch|branches/, 3],
  [/sales|services/, 1],
];

function sameSite(host: string, siteDomains: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return siteDomains.some((d) => h === d || h.endsWith("." + d));
}

/** The pages on this site most likely to list emails: contact, team, about, locations. */
export function pagesWorthReading(html: string, pageUrl: string, siteDomains: string[], max = 4): string[] {
  const scored = new Map<string, number>();
  for (const a of anchors(html)) {
    let u: URL;
    try { u = new URL(a.href, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !sameSite(u.host, siteDomains)) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?)$/i.test(u.pathname)) continue;
    u.hash = "";
    const key = u.href;
    if (key === new URL(pageUrl).href) continue;
    const hay = (u.pathname + " " + a.text).toLowerCase();
    let score = 0;
    for (const [re, s] of PAGE_HINTS) if (re.test(hay)) score = Math.max(score, s);
    if (!score) continue;
    if (/blog|news|career|job|privacy|terms|cookie|login|cart/.test(u.pathname.toLowerCase())) continue;
    scored.set(key, Math.max(scored.get(key) ?? 0, score));
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([u]) => u);
}

/** The company's name from og:site_name or the page title ("Acme Imports | Home" -> "Acme Imports"). */
export function siteName(html: string): string {
  const og = html.match(/<meta[^>]+property\s*=\s*["']og:site_name["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:site_name["']/i);
  if (og) return decodeEntities(og[1]).trim().slice(0, 120);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!title) return "";
  const parts = decodeEntities(title[1]).replace(/\s+/g, " ").split(/\s[|–—-]\s|\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
  const pick = parts.find((p) => !/^(home|homepage|welcome|index)$/i.test(p)) ?? "";
  return pick.slice(0, 120);
}

const NOT_COMPANY_SITES = /(^|\.)(facebook|fb|twitter|x|linkedin|instagram|youtube|youtu|google|goo|gstatic|googleapis|apple|microsoft|bing|w3|wordpress|wix|squarespace|cloudflare|pinterest|tiktok|whatsapp|wa|addthis|sharethis|jquery|bootstrapcdn|gravatar|schema|amazonaws|github|mozilla|adobe|yelp|bbb|mapquest|tripadvisor|doubleclick|hubspot|mailchimp|godaddy|paypal|vimeo|flickr|t|bit|tinyurl)\.[a-z.]+$/;

/** Company websites a directory page links out to, with the link text as a name when it is not just the URL. */
export function directorySites(html: string, pageUrl: string): { domain: string; name: string }[] {
  const dirHost = new URL(pageUrl).host.replace(/^www\./, "");
  const dirRoot = dirHost.split(".").slice(-2).join(".");
  const out = new Map<string, string>();
  for (const a of anchors(html)) {
    let u: URL;
    try { u = new URL(a.href, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const domain = domainFromWebsite(u.host);
    if (!domain || domain === dirRoot || domain.endsWith("." + dirRoot) || NOT_COMPANY_SITES.test(domain) || isFreemailDomain(domain)) continue;
    if (/\.(gov|mil|edu)$/.test(domain)) continue;
    const text = a.text.length > 2 && a.text.length < 100 && !/^(https?:|www\.)/i.test(a.text) && !/\.[a-z]{2,6}\/?$/i.test(a.text) && !/^(website|visit|web site|homepage|click here)/i.test(a.text) ? a.text : "";
    if (!out.has(domain) || (!out.get(domain) && text)) out.set(domain, text);
  }
  return [...out.entries()].map(([domain, name]) => ({ domain, name }));
}

/** Paths robots.txt asks every crawler ("User-agent: *") to stay out of. */
export function robotsDisallows(txt: string): string[] {
  const out: string[] = [];
  let applies = false;
  let inGroupHeader = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const key = k.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (!inGroupHeader) applies = false;
      inGroupHeader = true;
      if (value === "*") applies = true;
      continue;
    }
    inGroupHeader = false;
    if (applies && key === "disallow" && value) out.push(value);
  }
  return out;
}

export function robotsAllows(disallows: string[], path: string): boolean {
  return !disallows.some((d) => {
    if (!d.includes("*") && !d.endsWith("$")) return path.startsWith(d);
    const re = d.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + re).test(path);
  });
}
