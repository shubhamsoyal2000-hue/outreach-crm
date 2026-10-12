import type { VerificationStatus } from "../types";

export type VerifyGroup = "good" | "risky" | "bad";

/** Good to email, risky (may or may not reach a person) or bad (will bounce or should never be emailed). */
export const GROUP_STATUSES: Record<VerifyGroup, VerificationStatus[]> = {
  good: ["valid"],
  risky: ["catch_all", "risky", "unknown"],
  bad: ["invalid", "disposable"],
};

export function groupOf(status: VerificationStatus): VerifyGroup | null {
  for (const g of Object.keys(GROUP_STATUSES) as VerifyGroup[]) if (GROUP_STATUSES[g].includes(status)) return g;
  return null;
}

/** Who decided the status, read from the detail the app stored with it. */
export function checkedBy(detail: string | null): string {
  const d = (detail ?? "").trim();
  if (/gmail history/i.test(d)) return "Gmail history";
  if (/^hard bounce/i.test(d)) return "Bounced";
  if (/^(syntax|role|domain has no mail server)$/i.test(d)) return "App check";
  if (/^(ok|catch_all|invalid|disposable|unknown|error)( \/|$)/.test(d)) return "MillionVerifier";
  return d ? "Other" : "";
}
