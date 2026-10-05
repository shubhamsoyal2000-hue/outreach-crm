import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/config";
import { encrypt, safeEqual } from "@/lib/crypto";
import { accessTokenFromCode } from "@/lib/gmail";
import { db } from "@/lib/store/supabase";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const jar = await cookies();
  const expected = jar.get("oauth_state")?.value;
  jar.delete("oauth_state");
  const fail = (msg: string) => redirect(`/inboxes?error=${encodeURIComponent(msg)}`);

  if (params.get("error")) return fail(`Google said: ${params.get("error")}`);
  const state = params.get("state") ?? "";
  const code = params.get("code");
  if (!expected || !safeEqual(state, expected) || !code) return fail("The sign-in link expired. Try connecting again.");

  const { refreshToken, email } = await accessTokenFromCode(code);
  if (!refreshToken) return fail("Google did not return offline access. Remove the app's access in the Google account and connect again.");

  const existing = await db().from("inboxes").select("id").eq("email", email).maybeSingle();
  const tokenEnc = encrypt(env.encryptionKey, refreshToken);
  // A newly connected or reconnected inbox starts paused, so a human resumes it on purpose.
  const res = existing.data
    ? await db().from("inboxes").update({ refresh_token_enc: tokenEnc, status: "paused", paused_reason: "Reconnected. Check the settings, then resume." }).eq("id", existing.data.id)
    : await db().from("inboxes").insert({ email, refresh_token_enc: tokenEnc, status: "paused", paused_reason: "New inbox. Set the sender name, signature and cold start date, then resume." });
  if (res.error) return fail(res.error.message);
  redirect(`/inboxes?connected=${encodeURIComponent(email)}`);
}
