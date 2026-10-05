import { Badge, Flash, Stat } from "@/components/ui";
import { collectorBookmarklet } from "@/lib/importinfo/collector";
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
          No-reply addresses, duplicates, and anyone who opted out or bounced before are skipped automatically, and so are shared inboxes like info@ unless Settings allows them.
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
        <h2>Collect leads from ImportInfo</h2>
        <ol className="small">
          <li>Drag this button to your browser&apos;s bookmarks bar:{" "}
            {/* React blocks javascript: links, so this one is plain HTML. */}
            <span dangerouslySetInnerHTML={{ __html: `<a class="button" href="${collectorBookmarklet()}" title="Drag me to your bookmarks bar">+ Add to CRM list</a>` }} />
          </li>
          <li>On importinfo.com, open a company page that lists email addresses and click the bookmark. It adds that page&apos;s emails to a list saved in your browser, fixing broken ones like &ldquo;ops expeditors.com&rdquo;.</li>
          <li>Repeat on as many pages as you like, then click <strong>Download CSV</strong> in the box it shows and import the file above.</li>
        </ol>
        <p className="small muted">
          Each lead also gets the company&apos;s shipment facts, ready to use in emails with a fallback after the bar:{" "}
          <code>{"{{top_us_port|your port}}"}</code>, <code>{"{{top_route_from}}"}</code>, <code>{"{{top_route_to}}"}</code>,{" "}
          <code>{"{{shipments_90d}}"}</code>, <code>{"{{shipments_year}}"}</code>, <code>{"{{last_shipment}}"}</code>. The state sets the
          send-time zone.
        </p>
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
