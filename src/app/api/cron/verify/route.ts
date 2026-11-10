import { env } from "@/lib/config";
import { cronAuthorized } from "@/lib/cron-auth";
import { db } from "@/lib/store/supabase";
import { makeVerifier } from "@/lib/verify";
import { checkedBy } from "@/lib/verify/groups";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_EMAILS = 50;

/**
 * Checks a short list of addresses (e.g. the daily hand-written Outlook emails)
 * with MillionVerifier. An address that already has a MillionVerifier result in
 * the CRM is never checked again (no credit spent); a new result is saved on
 * every contact with that address, so the app won't re-check it either.
 * POST { "emails": ["a@b.com", ...] } with the scheduler's Bearer secret.
 */
export async function POST(request: Request) {
  if (!(await cronAuthorized(request))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { emails?: unknown } | null;
  const emails = Array.isArray(body?.emails)
    ? [...new Set(body.emails.filter((e): e is string => typeof e === "string").map((e) => e.trim().toLowerCase()).filter(Boolean))]
    : [];
  if (!emails.length) return Response.json({ error: "send { emails: [...] }" }, { status: 400 });
  if (emails.length > MAX_EMAILS) return Response.json({ error: `at most ${MAX_EMAILS} emails per call` }, { status: 400 });

  const verifier = makeVerifier(env.verifier, env.verifierApiKey);
  if (!verifier) return Response.json({ error: "no verifier configured" }, { status: 503 });
  const { data: settings } = await db().from("settings").select("allow_shared_inboxes").eq("id", 1).single();
  const allowShared = Boolean(settings?.allow_shared_inboxes);

  const results = [];
  for (const email of emails) {
    const { data: contacts, error } = await db()
      .from("contacts")
      .select("id, verification_status, verification_detail, verified_at")
      .ilike("email", email);
    if (error) return Response.json({ error: `read contacts: ${error.message}` }, { status: 500 });
    const prior = (contacts ?? []).find((c) => checkedBy(c.verification_detail) === "MillionVerifier" && c.verified_at);
    if (prior) {
      results.push({ email, status: prior.verification_status, detail: prior.verification_detail, checked_at: prior.verified_at, reused: true });
      continue;
    }
    try {
      const r = await verifier.verify(email, { allowShared });
      const at = new Date().toISOString();
      const ids = (contacts ?? []).map((c) => c.id);
      if (ids.length) {
        await db().from("contacts").update({ verification_status: r.status, verification_detail: r.detail, verified_at: at }).in("id", ids);
      }
      results.push({ email, status: r.status, detail: r.detail, checked_at: at, reused: false, saved_on_contacts: ids.length });
    } catch (err) {
      results.push({ email, status: "error", detail: (err as Error).message, reused: false });
    }
  }
  return Response.json({ at: new Date().toISOString(), results });
}
