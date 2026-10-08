/**
 * Researched opening lines live in company.facts:
 *   line_draft       what research suggested, waiting for review
 *   line_source      the page the fact came from
 *   line_confidence  high / medium / low
 *   line_what        what the company makes or sells
 *   custom_line      the approved line; only this one is ever used in an email ({{custom_line}})
 *   line_status      approved / skipped
 */
export type LineStatus = "pending" | "approved" | "skipped";

export function lineStatus(facts: Record<string, string> | null | undefined): LineStatus {
  if (facts?.custom_line?.trim()) return "approved";
  if (facts?.line_status === "skipped") return "skipped";
  return "pending";
}

/** One sentence, no template braces, no line breaks, ends with a full stop. */
export function cleanLine(line: string): string {
  const s = line.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return /[.?!]$/.test(s) ? s : `${s}.`;
}

export function approveLine(facts: Record<string, string> | null | undefined, line: string): Record<string, string> {
  const clean = cleanLine(line);
  const next = { ...(facts ?? {}) };
  if (!clean) return skipLine(next);
  return { ...next, custom_line: clean, line_draft: clean, line_status: "approved" };
}

export function skipLine(facts: Record<string, string> | null | undefined): Record<string, string> {
  const next: Record<string, string> = { ...(facts ?? {}), line_status: "skipped" };
  delete next.custom_line;
  return next;
}
