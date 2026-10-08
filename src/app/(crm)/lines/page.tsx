import Link from "next/link";
import { Flash } from "@/components/ui";
import { lineStatus, type LineStatus } from "@/lib/opening-lines";
import { db } from "@/lib/store/supabase";
import { approveAllLines, reviewLine } from "../../line-actions";

export const dynamic = "force-dynamic";

interface Row { id: string; name: string; domain: string | null; kind: string | null; facts: Record<string, string> }

const TABS: Record<LineStatus, { label: string; what: string }> = {
  pending: { label: "To review", what: "Read each line, fix anything that's off, then click Approve. Only approved lines are ever sent." },
  approved: { label: "Approved", what: "These go into the first email of the \"Importers, researched first touch\" sequence." },
  skipped: { label: "Skipped", what: "These companies won't get the researched email. You can still approve one here." },
};

const CONF: Record<string, "good" | "warn" | "bad"> = { high: "good", medium: "warn", low: "bad" };

export default async function LinesPage({ searchParams }: { searchParams: Promise<{ msg?: string; tab?: string }> }) {
  const { msg, tab: rawTab } = await searchParams;
  const tab: LineStatus = rawTab && rawTab in TABS ? (rawTab as LineStatus) : "pending";
  const res = await db().from("companies").select("id, name, domain, kind, facts").not("facts->>line_draft", "is", null).or("kind.is.null,kind.eq.importer").order("name");
  const all = (res.data ?? []) as Row[];
  const counts = { pending: 0, approved: 0, skipped: 0 } as Record<LineStatus, number>;
  for (const r of all) counts[lineStatus(r.facts)]++;
  const rows = all.filter((r) => lineStatus(r.facts) === tab);

  const ids = rows.map((r) => r.id);
  const contacts = new Map<string, number>();
  if (ids.length) {
    const c = await db().from("company_lookup").select("id, contacts").in("id", ids);
    for (const x of (c.data ?? []) as { id: string; contacts: number }[]) contacts.set(x.id, x.contacts);
  }

  return (
    <>
      <h1>Opening lines</h1>
      <Flash msg={msg} />
      <p className="muted small">
        Researched from each company&apos;s public website. Each line opens their first email like this: &quot;Hi Jane, <em>[line]</em> We handle drayage and FTL
        from the port to warehouses across the country...&quot; Only importers are listed here; companies that turned out to be forwarders or carriers moved to
        the forwarder list. <Link href="/lookup">Back to the ImportInfo list</Link>
      </p>
      <div className="actions" style={{ marginBottom: 14 }}>
        {(Object.keys(TABS) as LineStatus[]).map((t) => (
          <Link key={t} href={`/lines?tab=${t}`} className={`button ${t === tab ? "" : "secondary"}`}>{TABS[t].label} ({counts[t]})</Link>
        ))}
      </div>
      <p className="muted small">{TABS[tab].what}</p>

      {tab === "pending" && rows.length > 0 && (
        <form action={approveAllLines} className="panel row" style={{ alignItems: "center" }}>
          <span className="small">Approve all remaining lines, as written, that are</span>
          <label className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" name="confidence" value="high" defaultChecked style={{ width: "auto" }} /> high confidence</label>
          <label className="small" style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" name="confidence" value="medium" style={{ width: "auto" }} /> medium</label>
          <button type="submit" className="secondary" style={{ flex: "0 0 auto" }}>Approve these</button>
        </form>
      )}

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Company</th><th style={{ width: "55%" }}>Opening line</th><th className="num">Contacts</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const f = r.facts;
                const conf = f.line_confidence ?? "low";
                return (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.name}</strong>
                      <div className="small">{r.domain && <a href={`https://${r.domain}`} target="_blank" rel="noreferrer">{r.domain}</a>}</div>
                      {f.line_what && <div className="small muted">{f.line_what}</div>}
                    </td>
                    <td>
                      <form action={reviewLine}>
                        <input type="hidden" name="company_id" value={r.id} />
                        <input type="hidden" name="tab" value={tab} />
                        <textarea name="line" rows={3} defaultValue={f.custom_line ?? f.line_draft} />
                        <div className="actions" style={{ alignItems: "center", marginTop: 6 }}>
                          <span className={`badge ${CONF[conf] ?? ""}`}>{conf} confidence</span>
                          {f.line_source && <a className="small" href={f.line_source} target="_blank" rel="noreferrer">source</a>}
                          {f.line_note && <span className="small muted">{f.line_note}</span>}
                          <span style={{ flex: 1 }} />
                          <button type="submit" name="decision" value="approve" style={{ flex: "0 0 auto" }}>{tab === "approved" ? "Save" : "Approve"}</button>
                          {tab !== "skipped" && <button type="submit" name="decision" value="skip" className="secondary" style={{ flex: "0 0 auto" }}>Skip</button>}
                        </div>
                      </form>
                    </td>
                    <td className="num">{contacts.get(r.id) ?? ""}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={3} className="muted">Nothing here.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
