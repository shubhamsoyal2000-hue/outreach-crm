import { createHash } from "node:crypto";

// {{field}} placeholders. {{field|fallback}} uses the fallback when the field is
// empty. A field with no value and no fallback is reported as missing, and the
// send is skipped rather than going out with a blank in it.

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_ ]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export function fieldKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export interface Rendered {
  text: string;
  missing: string[];
}

export function render(template: string, vars: Record<string, string | null | undefined>): Rendered {
  const missing = new Set<string>();
  const text = template.replace(PLACEHOLDER, (_, rawKey: string, fallback: string | undefined) => {
    const key = fieldKey(rawKey);
    const value = vars[key]?.toString().trim();
    if (value) return value;
    if (fallback !== undefined) return fallback;
    missing.add(key);
    return "";
  });
  return { text, missing: [...missing] };
}

export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => fieldKey(m[1]));
}

/** Title-cases names typed in all caps or all lower case, leaves mixed case alone. */
export function tidyName(name: string): string {
  const s = name.trim();
  if (!s) return s;
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;
  return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

// [[option one|option two|option three]] picks one option per email, so the
// same step reads differently from one recipient to the next. Options may hold
// {{placeholders}}, including ones with a |fallback. An empty option is allowed.
const SPIN = /\[\[([\s\S]*?)\]\]/g;

function splitOptions(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner.startsWith("{{", i)) { depth++; cur += "{{"; i++; continue; }
    if (inner.startsWith("}}", i) && depth > 0) { depth--; cur += "}}"; i++; continue; }
    if (inner[i] === "|" && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += inner[i];
  }
  out.push(cur);
  return out;
}

function pick(seed: string, n: number): number {
  return createHash("sha256").update(seed).digest().readUInt32BE(0) % n;
}

/** Resolves every [[a|b|c]] choice. The same seed always gives the same email. */
export function spin(template: string, seed: string): string {
  let index = 0;
  const out = template.replace(SPIN, (_, inner: string) => {
    const options = splitOptions(inner);
    return options[pick(`${seed}:${index++}`, options.length)].trim();
  });
  // An empty choice leaves a double space or a space before punctuation behind.
  return out.replace(/[ \t]{2,}/g, " ").replace(/ +([.,?!])/g, "$1").replace(/ +\n/g, "\n");
}

/** How many different versions a template's [[...]] choices can produce. */
export function spinCount(template: string): number {
  return [...template.matchAll(SPIN)].reduce((n, m) => n * splitOptions(m[1]).length, 1);
}

/** Fingerprint of an email's wording, ignoring case and spacing, to catch two identical emails. */
export function copyHash(text: string): string {
  return createHash("sha256").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}
