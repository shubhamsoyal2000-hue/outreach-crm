import Papa from "papaparse";
import { db } from "@/lib/store/supabase";
import type { VerificationStatus } from "@/lib/types";
import { checkedBy, GROUP_STATUSES, groupOf, type VerifyGroup } from "@/lib/verify/groups";

export const dynamic = "force-dynamic";

const LABEL: Record<VerifyGroup, string> = { good: "Good", risky: "Risky", bad: "Bad" };

interface Row {
  email: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  verification_status: VerificationStatus;
  verification_detail: string | null;
  verified_at: string | null;
  source: string | null;
  company: { name: string | null; domain: string | null; kind: string | null } | null;
}

/** Every checked email address as a CSV, optionally one group only (signed-in team only, via the proxy). */
export async function GET(request: Request) {
  const group = new URL(request.url).searchParams.get("group") as VerifyGroup | null;
  const statuses = group && GROUP_STATUSES[group] ? GROUP_STATUSES[group] : Object.values(GROUP_STATUSES).flat();
  const out: Record<string, string>[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await db()
      .from("contacts")
      .select("email, first_name, last_name, title, verification_status, verification_detail, verified_at, source, company:companies(name, domain, kind)")
      .in("verification_status", statuses)
      .order("email")
      .range(from, from + 999);
    if (page.error) return new Response(page.error.message, { status: 500 });
    for (const c of (page.data ?? []) as unknown as Row[]) {
      const g = groupOf(c.verification_status);
      out.push({
        email: c.email,
        result: g ? LABEL[g] : "",
        status: c.verification_status,
        detail: c.verification_detail ?? "",
        checked_by: checkedBy(c.verification_detail),
        checked_at: c.verified_at ? c.verified_at.slice(0, 10) : "",
        first_name: c.first_name ?? "",
        last_name: c.last_name ?? "",
        title: c.title ?? "",
        company: c.company?.name ?? "",
        domain: c.company?.domain ?? "",
        company_type: c.company?.kind ?? "",
        source: c.source ?? "",
      });
    }
    if ((page.data ?? []).length < 1000) break;
  }
  const name = group && GROUP_STATUSES[group] ? `checked-emails-${group}` : "checked-emails-all";
  return new Response(Papa.unparse(out), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"` },
  });
}
