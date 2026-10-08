import Papa from "papaparse";
import { db } from "@/lib/store/supabase";

export const dynamic = "force-dynamic";

const FILTERS: Record<string, { kind: string[]; hasData?: boolean }> = {
  todo: { kind: ["importer"], hasData: false },
  done: { kind: ["importer"], hasData: true },
  forwarder: { kind: ["forwarder"] },
  other: { kind: ["carrier", "other"] },
};

/** The ImportInfo list as a CSV (signed-in team only, via the proxy). */
export async function GET(request: Request) {
  const tab = new URL(request.url).searchParams.get("tab") ?? "todo";
  const f = FILTERS[tab] ?? FILTERS.todo;
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db().from("company_lookup").select("name, domain, kind, contacts, last_emailed, has_data, top_us_port").eq("status", "active").in("kind", f.kind);
    if (f.hasData !== undefined) q = q.eq("has_data", f.hasData);
    const page = await q.order("contacts", { ascending: false }).order("domain").range(from, from + 999);
    if (page.error) return new Response(page.error.message, { status: 500 });
    out.push(...(page.data ?? []));
    if ((page.data ?? []).length < 1000) break;
  }
  return new Response(Papa.unparse(out), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="importinfo-${tab}.csv"` },
  });
}
