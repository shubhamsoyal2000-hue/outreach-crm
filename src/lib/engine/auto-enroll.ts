import type { Store } from "../store/types";
import { enrollContacts, type EnrollSummary } from "./enroll";

export type AutoEnrollOutcome = (EnrollSummary & { sequence_id: string }) | { skipped: string } | { error: string };

/**
 * Puts importers that have an approved opening line into the active
 * auto-enroll sequence, so the daily research goes out without a click.
 * Anyone already in a sequence is left alone.
 */
export async function runAutoEnroll(store: Store, now: Date): Promise<AutoEnrollOutcome> {
  const sequenceId = await store.autoEnrollSequenceId();
  if (!sequenceId) return { skipped: "no active auto-enroll sequence" };
  const candidates = await store.researchedCandidates();
  if (!candidates.length) return { sequence_id: sequenceId, enrolled: 0, skipped: {} };
  return { sequence_id: sequenceId, ...(await enrollContacts(store, sequenceId, candidates, now)) };
}
