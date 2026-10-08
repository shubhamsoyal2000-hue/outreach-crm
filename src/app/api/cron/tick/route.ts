import { env } from "@/lib/config";
import { safeEqual } from "@/lib/crypto";
import { productionDeps } from "@/lib/engine";
import { runTick } from "@/lib/engine/tick";
import { SupabaseStore, db } from "@/lib/store/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Called every 5 minutes by the scheduler (see README). */
async function tick(request: Request) {
  if (!(await authorized(request))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const store = new SupabaseStore();
  const deps = productionDeps();
  const result = await runTick(store, deps, env.appUrl);
  return Response.json({ at: new Date().toISOString(), ...result });
}

/** Accepts the secret in Supabase Vault (cron_secret), or CRON_SECRET if set in the environment. */
async function authorized(request: Request): Promise<boolean> {
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length);
  if (token.length < 24) return false;
  if (env.cronSecret && safeEqual(token, env.cronSecret)) return true;
  const { data, error } = await db().rpc("cron_secret_matches", { token });
  if (error) throw new Error(`check scheduler secret: ${error.message}`);
  return data === true;
}

export const GET = tick;
export const POST = tick;
