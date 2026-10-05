import { Badge, Flash, Stat } from "@/components/ui";
import { db } from "@/lib/store/supabase";
import { importCsv, setCompanyDoNotContact } from "../../actions";

export const dynamic = "force-dynamic";

const STATUSES = ["valid", "catch_all", "unverified", "unknown", "risky", "invalid", "disposable"] as const;

export default async function ContactsPage({ searchParams }: { searchParams: Promise<{ msg?: string; q?: string }> }) {
  const { msg, q } = await searchParams;
  const counts = await Promise.all(
    STATUSES.map(async (s) => (await db().from("contacts").select("id", { count: "exact", head: true }).eq("verification_status", s)).count ?? 0),
  );
  let query = db()
    .from("contacts")
    .select("id, email, first_name, last_name, title, verification_status, fields, created_at, company:companies(id, name, status)")
    .order("created_at", { ascending: false })
    .limit(100);
  const term = q?.trim().toLowerCase().replace(/[%,()]/g, "");
  if (term) query = query.or(`email.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%`);
  const contacts = await query;

  return (
    <>
      <h1>Leads</h1>
      <Flash msg={msg} />
      <div className="grid">
        {STATUSES.map((s, i) => <Stat key={s} n={counts[i]} label={s.replace("_", "-")} />)}
      </div>

      <div className="panel">
        <h2>Import a CSV</h2>
        <p className="muted small">
          One row per person. An <strong>email</strong> column is required. Name, title, company, website and state are recognised under common
          headings; every other column (commodity, port, HS code, shipments...) is kept and can be used in emails as {"{{column_name}}"}.
          Shared mailboxes like info@ and sales@, duplicates, and anyone who opted out or bounced before are skipped automatically.
          Keep each file under about 4 MB.
        </p>
        <form action={importCsv}>
          <div className="row">
            <div><input type="file" name="file" accept=".csv,text/csv" required /></div>
            <div style={{ flex: "0 0 auto" }}><button type="submit">Import</button></div>
          </div>
        </form>
      </div>

      <div className="panel">
        <form className="row" style={{ marginBottom: 12 }}>
          <div><input type="text" name="q" defaultValue={q} placeholder="Search by email or name" /></div>
          <div style={{ flex: "0 0 auto" }}><button type="submit" className="secondary">Search</button></div>
        </form>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Contact</th><th>Company</th><th>Email check</th><th>Fields</th><th></th></tr></thead>
            <tbody>
              {(contacts.data ?? []).map((c) => {
                const company = c.company as unknown as { id: string; name: string; status: string } | null;
                return (
                  <tr key={c.id}>
                    <td>
                      {[c.first_name, c.last_name].filter(Boolean).join(" ") || <span className="muted">no name</span>}
                      <div className="small muted">{c.email}{c.title ? ` · ${c.title}` : ""}</div>
                    </td>
                    <td>{company?.name}{company && company.status !== "active" && <> <Badge value={company.status} /></>}</td>
                    <td><Badge value={c.verification_status} /></td>
                    <td className="small muted">{Object.entries((c.fields ?? {}) as Record<string, string>).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(" · ")}</td>
                    <td>
                      {company && company.status === "active" && (
                        <form action={setCompanyDoNotContact}>
                          <input type="hidden" name="company_id" value={company.id} />
                          <button type="submit" className="secondary small" title="Existing customer, competitor, or asked not to be contacted">Do not contact</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!contacts.data?.length && <tr><td colSpan={5} className="muted">No leads yet. Import a CSV above.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>Showing the newest 100.</p>
      </div>
    </>
  );
}
