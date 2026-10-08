import type { Store } from "../store/types";
import { newInboxProblems, sendAlerts, type AlertOutcome } from "./alerts";
import type { EngineDeps } from "./ports";
import { runSendPass, type SendOutcome } from "./send";
import { runSyncPass, type SyncOutcome } from "./sync";

/**
 * One scheduler pass: read every inbox for replies and bounces first, so
 * nobody who just replied gets a follow-up, then send at most one email per
 * inbox, then email the team about new replies and inboxes that just stopped.
 */
export async function runTick(store: Store, deps: EngineDeps, appUrl: string): Promise<{ sync: SyncOutcome[]; send: SendOutcome[]; alert: AlertOutcome }> {
  const before = await store.listInboxes();
  const sync = await runSyncPass(store, deps);
  const send = await runSendPass(store, deps);
  const problems = newInboxProblems(before, await store.listInboxes());
  const alert = await sendAlerts(store, deps, await store.getSettings(), sync, problems, appUrl).catch(
    (err: unknown): AlertOutcome => ({ sent: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return { sync, send, alert };
}
