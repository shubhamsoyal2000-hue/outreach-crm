import { createHash } from "node:crypto";
import type { EnrollCandidate, NewEnrollment, Store } from "../store/types";
import type { Inbox } from "../types";

export interface EnrollSummary {
  enrolled: number;
  skipped: Record<string, number>;
}

const BLOCKED_VERIFICATION = new Set(["invalid", "disposable", "risky"]);

/** Someone we emailed by hand (see the Gmail history import) waits this long before the first sequence email. */
export const COOL_OFF_DAYS = 5;

/** The first send: now, or 5 days after the last time we emailed them by hand. */
export function firstSendAt(contact: { fields: Record<string, string> }, now: Date): Date {
  const last = contact.fields?.last_emailed ? new Date(`${contact.fields.last_emailed}T00:00:00Z`) : null;
  if (!last || Number.isNaN(last.getTime())) return now;
  const ready = new Date(last.getTime() + COOL_OFF_DAYS * 86_400_000);
  return ready > now ? ready : now;
}

/** Stable A/B split so a contact always gets the same subject variant. */
export function subjectVariant(contactId: string): "a" | "b" {
  return createHash("sha256").update(contactId).digest()[0] % 2 === 0 ? "a" : "b";
}

/**
 * Puts contacts into a sequence. Each contact is pinned to one inbox for the
 * whole sequence (so follow-ups come from the same sender, in the same
 * thread), choosing the inbox with the fewest active enrollments.
 */
export async function enrollContacts(
  store: Store,
  sequenceId: string,
  candidates: EnrollCandidate[],
  now: Date,
): Promise<EnrollSummary> {
  const skipped: Record<string, number> = {};
  const bump = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1);

  const inboxes = (await store.listInboxes()).filter((i: Inbox) => i.status !== "disconnected" && i.refresh_token_enc);
  if (!inboxes.length) return { enrolled: 0, skipped: { "no connected inbox": candidates.length } };
  const load = await store.activeEnrollmentCounts();

  const rows: NewEnrollment[] = [];
  for (const { contact, company, alreadyEnrolled } of candidates) {
    if (alreadyEnrolled) { bump("already in this sequence"); continue; }
    if (BLOCKED_VERIFICATION.has(contact.verification_status)) { bump("failed verification"); continue; }
    if (company && company.status !== "active") { bump("company replied or do-not-contact"); continue; }
    if (await store.isSuppressed(contact.email)) { bump("on suppression list"); continue; }

    const inbox = inboxes.reduce((best, i) => ((load[i.id] ?? 0) < (load[best.id] ?? 0) ? i : best));
    load[inbox.id] = (load[inbox.id] ?? 0) + 1;
    rows.push({
      sequence_id: sequenceId,
      contact_id: contact.id,
      inbox_id: inbox.id,
      subject_variant: subjectVariant(contact.id),
      next_send_at: firstSendAt(contact, now).toISOString(),
    });
  }
  const enrolled = rows.length ? await store.createEnrollments(rows) : 0;
  return { enrolled, skipped };
}
