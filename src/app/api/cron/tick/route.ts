import { env } from "@/lib/config";
import { cronAuthorized } from "@/lib/cron-auth";
import { productionDeps } from "@/lib/engine";
import { runTick } from "@/lib/engine/tick";
import { SupabaseStore } from "@/lib/store/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Called every 5 minutes by the scheduler (see README). */
async function tick(request: Request) {
  if (!(await cronAuthorized(request))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const store = new SupabaseStore();
  const deps = productionDeps();
  const result = await runTick(store, deps, env.appUrl);
  return Response.json({ at: new Date().toISOString(), ...result });
}

export const GET = tick;
export const POST = tick;
