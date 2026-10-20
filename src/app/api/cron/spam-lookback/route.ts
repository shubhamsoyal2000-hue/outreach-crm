import { env } from "@/lib/config";
import { cronAuthorized } from "@/lib/cron-auth";
import { productionDeps } from "@/lib/engine";
import { sendAlerts } from "@/lib/engine/alerts";
import { syncInbox } from "@/lib/engine/sync";
import { SupabaseStore } from "@/lib/store/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One-off: reads each inbox's Spam folder back to `since` (default 2026-10-05) and
 * handles any reply, bounce or auto-reply filed there that the regular sync missed.
 * Optional `inbox` limits it to one address. Does not move the regular sync point.
 */
async function lookback(request: Request) {
  if (!(await cronAuthorized(request))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const since = new Date(params.get("since") ?? "2026-10-05T00:00:00Z");
  const only = params.get("inbox")?.toLowerCase();
  const store = new SupabaseStore();
  const deps = productionDeps();
  const settings = await store.getSettings();
  const inboxes = (await store.listInboxes()).filter((i) => !only || i.email.toLowerCase() === only);
  const sync = [];
  for (const inbox of inboxes) sync.push(await syncInbox(store, deps, settings, inbox, { since, spamOnly: true }));
  const alert = await sendAlerts(store, deps, settings, sync, [], env.appUrl).catch((err: unknown) => ({ sent: false, error: String(err) }));
  return Response.json({ since: since.toISOString(), sync, alert });
}

export const GET = lookback;
export const POST = lookback;
