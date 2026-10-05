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
