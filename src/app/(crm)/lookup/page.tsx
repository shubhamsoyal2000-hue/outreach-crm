import Link from "next/link";
import { Flash } from "@/components/ui";
import { db } from "@/lib/store/supabase";
import { setCompanyKind } from "../../actions";

export const dynamic = "force-dynamic";

interface Row { id: string; name: string; domain: string | null; kind: string; status: string; has_data: boolean; top_us_port: string | null; contacts: number; last_emailed: string | null }

const TABS = {
  todo: { label: "To look up", what: "Importers without ImportInfo data yet, most contacts first. Search each one on ImportInfo and click + Add to CRM list on its page; the ports and routes then go into their emails." },
  done: { label: "Done", what: "Importers whose ImportInfo data is in. Their emails use their real ports and routes." },
  forwarder: { label: "Forwarders", what: "Freight forwarders and customs brokers. ImportInfo won't have useful data on them; they get the forwarder sequence instead." },
  other: { label: "Carriers & other", what: "Trucking companies, ocean carriers and government addresses. Not emailed unless you change their type." },
} as const;
type Tab = keyof typeof TABS;

function guessName(r: Row): string {
  if (r.name && r.name !== r.domain) return r.name;
  const label = (r.domain ?? "").split(".").slice(-2, -1)[0] ?? r.name;
  return label.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function query(tab: Tab, head = false) {
  const q = db().from("company_lookup").select("*", head ? { count: "exact", head: true } : undefined).eq("status", "active");
  if (tab === "todo") return q.eq("kind", "importer").eq("has_data", false);
  if (tab === "done") return q.eq("kind", "importer").eq("has_data", true);
  if (tab === "forwarder") return q.eq("kind", "forwarder");
  return q.in("kind", ["carrier", "other"]);
}

export default async function LookupPage({ searchParams }: { searchParams: Promise<{ msg?: string; tab?: string }> }) {
  const { msg, tab: rawTab } = await searchParams;
  const tab: Tab = rawTab && rawTab in TABS ? (rawTab as Tab) : "todo";
  const counts = await Promise.all((Object.keys(TABS) as Tab[]).map(async (t) => (await query(t, true)).count ?? 0));
  const rows = ((await query(tab).order("contacts", { ascending: false }).order("domain").limit(300)).data ?? []) as Row[];

  return (
    <>
      <h1>ImportInfo list</h1>
      <Flash msg={msg} />
      <div className="actions" style={{ marginBottom: 14 }}>
        {(Object.keys(TABS) as Tab[]).map((t, i) => (
          <Link key={t} href={`/lookup?tab=${t}`} className={`button ${t === tab ? "" : "secondary"}`}>{TABS[t].label} ({counts[i]})</Link>
        ))}
        <a className="button secondary" href={`/lookup/export?tab=${tab}`}>Download as CSV</a>
      </div>
      <p className="muted small">{TABS[tab].what} Wrong type? Change it in the last column.</p>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Search ImportInfo for</th><th>Website</th><th className="num">Contacts</th><th>You last emailed</th>{tab === "done" && <th>Main port</th>}<th>Type</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  <td className="muted small">{i + 1}</td>
                  <td><strong>{guessName(r)}</strong></td>
                  <td>{r.domain ? <a href={`https://${r.domain}`} target="_blank" rel="noreferrer">{r.domain}</a> : ""}</td>
                  <td className="num">{r.contacts}</td>
                  <td>{r.last_emailed ?? ""}</td>
                  {tab === "done" && <td>{r.top_us_port}</td>}
                  <td>
                    <form action={setCompanyKind} className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <input type="hidden" name="company_id" value={r.id} />
                      <input type="hidden" name="tab" value={tab} />
                      <select name="kind" defaultValue={r.kind} style={{ minWidth: 110 }}>
                        <option value="importer">Importer</option>
                        <option value="forwarder">Forwarder</option>
                        <option value="carrier">Carrier</option>
                        <option value="other">Other</option>
                      </select>
                      <button type="submit" className="secondary" style={{ flex: "0 0 auto" }}>Save</button>
                    </form>
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} className="muted">Nothing here.</td></tr>}
            </tbody>
          </table>
        </div>
        {rows.length === 300 && <p className="muted small">Showing the first 300. Download the CSV for the full list.</p>}
      </div>
    </>
  );
}
