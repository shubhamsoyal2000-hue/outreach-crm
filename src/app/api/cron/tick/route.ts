import { env } from "@/lib/config";
import { safeEqual } from "@/lib/crypto";
import { productionDeps } from "@/lib/engine";
import { runSendPass } from "@/lib/engine/send";
import { runSyncPass } from "@/lib/engine/sync";
import { SupabaseStore } from "@/lib/store/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Called every 5 minutes by the scheduler (see README). Reads every inbox for
 * replies and bounces first, so nobody who just replied gets a follow-up,
 * then sends at most one email per inbox.
 */
async function tick(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env.cronSecret}`)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const store = new SupabaseStore();
  const deps = productionDeps();
  const sync = await runSyncPass(store, deps);
  const send = await runSendPass(store, deps);
  return Response.json({ at: new Date().toISOString(), sync, send });
}

export const GET = tick;
export const POST = tick;
