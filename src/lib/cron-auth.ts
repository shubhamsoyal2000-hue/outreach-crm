import "server-only";
import { env } from "./config";
import { safeEqual } from "./crypto";
import { db } from "./store/supabase";

/** Accepts the secret in Supabase Vault (cron_secret), or CRON_SECRET if set in the environment. */
export async function cronAuthorized(request: Request): Promise<boolean> {
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length);
  if (token.length < 24) return false;
  if (env.cronSecret && safeEqual(token, env.cronSecret)) return true;
  const { data, error } = await db().rpc("cron_secret_matches", { token });
  if (error) throw new Error(`check scheduler secret: ${error.message}`);
  return data === true;
}
