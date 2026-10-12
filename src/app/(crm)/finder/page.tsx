import { Flash } from "@/components/ui";
import { db } from "@/lib/store/supabase";
import { addFinderDirectory, addFinderSites, queueKnownCompanies, saveFinderSettings, setDirectoryStatus } from "../../finder-actions";

export const dynamic = "force-dynamic";

interface Site { domain: string; name: string; source: string; source_ref: string | null; status: string; emails_found: number; emails_added: number; error: string | null; checked_at: string | null }
interface Directory { id: string; label: string; url_template: string; kind: string | null; next_page: number; last_page: number | null; status: string; sites_found: number; error: string | null }

const STATUS: Record<string, string> = { done: "Emails found", no_emails: "No emails listed", failed: "Website did not load", skipped: "Asks not to be read", pending: "Waiting" };
const SOURCE: Record<string, string> = { directory: "Directory", pasted: "Pasted", leads: "Company in Leads" };

function count(q: PromiseLike<{ count: number | null }>) {
  return Promise.resolve(q).then((r) => r.count ?? 0);
}

export default async function FinderPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const today = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
  const [settingsRes, readToday, addedToday, waiting, addedAll, recentRes, dirsRes] = await Promise.all([
    db().from("settings").select("finder_enabled, finder_daily_sites").eq("id", 1).single(),
    count(db().from("finder_sites").select("domain", { count: "exact", head: true }).gte("checked_at", today)),
    count(db().from("contacts").select("id", { count: "exact", head: true }).eq("source", "website_finder").gte("created_at", today)),
    count(db().from("finder_sites").select("domain", { count: "exact", head: true }).eq("status", "pending")),
    count(db().from("contacts").select("id", { count: "exact", head: true }).eq("source", "website_finder")),
    db().from("finder_sites").select("domain, name, source, source_ref, status, emails_found, emails_added, error, checked_at").not("checked_at", "is", null).order("checked_at", { ascending: false }).limit(60),
    db().from("finder_directories").select("*").order("created_at"),
  ]);
  const settings = (settingsRes.data ?? { finder_enabled: false, finder_daily_sites: 0 }) as { finder_enabled: boolean; finder_daily_sites: number };
  const recent = (recentRes.data ?? []) as Site[];
  const dirs = (dirsRes.data ?? []) as Directory[];

  return (
    <>
      <h1>Email finder</h1>
      <Flash msg={msg} />
      <p className="muted">
        Reads company websites (home, contact, about and team pages) and adds the emails listed there to Leads, with the source
        &ldquo;website_finder&rdquo;. It runs by itself every minute. Do-not-email domains are skipped, and every address is still checked
        by MillionVerifier right before it is sent.
      </p>

      <div className="grid">
        <div className="stat"><div className="n">{addedToday}</div><div className="l">New emails added today</div></div>
        <div className="stat"><div className="n">{readToday} / {settings.finder_daily_sites}</div><div className="l">Websites read today</div></div>
        <div className="stat"><div className="n">{waiting}</div><div className="l">Websites waiting</div></div>
        <div className="stat"><div className="n">{addedAll}</div><div className="l">Emails added, all time</div></div>
      </div>

      <div className="panel">
        <h2>Settings</h2>
        <form action={saveFinderSettings} className="row">
          <label style={{ flex: "0 0 auto" }}><input type="checkbox" name="finder_enabled" defaultChecked={settings.finder_enabled} /> Finder is on</label>
          <div><label className="small muted">Websites per day</label><input type="number" name="finder_daily_sites" min={0} max={5000} defaultValue={settings.finder_daily_sites} /></div>
          <div style={{ flex: "0 0 auto" }}><button type="submit">Save</button></div>
        </form>
      </div>

      <div className="panel">
        <h2>Add websites</h2>
        <form action={addFinderSites}>
          <textarea name="sites" rows={6} placeholder={"One per line, for example:\nacme-imports.com\nBlue River Foods, blueriverfoods.com"} style={{ width: "100%" }} />
          <div className="row" style={{ marginTop: 8 }}>
            <div>
              <select name="kind" defaultValue="">
                <option value="">Let the app guess the type</option>
                <option value="importer">These are importers</option>
                <option value="forwarder">These are forwarders</option>
              </select>
            </div>
            <div style={{ flex: "0 0 auto" }}><button type="submit">Add to queue</button></div>
          </div>
        </form>
        <form action={queueKnownCompanies} className="actions">
          <button type="submit" className="secondary">Also read the websites of companies already in Leads</button>
        </form>
      </div>

      <div className="panel">
        <h2>Directories</h2>
        <p className="small muted">Business directories that link to company websites. One page is read whenever fewer than 40 websites are waiting.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Directory</th><th>Type</th><th className="num">Next page</th><th className="num">Websites found</th><th>Status</th><th /></tr></thead>
            <tbody>
              {dirs.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.label}</strong><div className="small muted">{d.url_template}</div></td>
                  <td>{d.kind ?? "guess"}</td>
                  <td className="num">{d.next_page}{d.last_page ? ` of ${d.last_page}` : ""}</td>
                  <td className="num">{d.sites_found}</td>
                  <td>{d.status}{d.error ? <div className="small muted">{d.error}</div> : null}</td>
                  <td>
                    <form action={setDirectoryStatus}>
                      <input type="hidden" name="id" value={d.id} />
                      <input type="hidden" name="status" value={d.status === "active" ? "paused" : "active"} />
                      <button type="submit" className="secondary">{d.status === "active" ? "Pause" : "Turn on"}</button>
                    </form>
                  </td>
                </tr>
              ))}
              {!dirs.length && <tr><td colSpan={6} className="muted">No directories yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <details style={{ marginTop: 12 }}>
          <summary className="small">Add a directory</summary>
          <form action={addFinderDirectory} className="row" style={{ marginTop: 8 }}>
            <div><input name="label" placeholder="Name, e.g. Freightnet US forwarders" /></div>
            <div style={{ flex: 3 }}><input name="url_template" placeholder="https://example.com/list?page={page}" /></div>
            <div style={{ flex: "0 0 90px", minWidth: 90 }}><input name="last_page" type="number" placeholder="Last page" /></div>
            <div>
              <select name="kind" defaultValue="">
                <option value="">Guess the type</option>
                <option value="importer">Importers</option>
                <option value="forwarder">Forwarders</option>
              </select>
            </div>
            <div style={{ flex: "0 0 auto" }}><button type="submit">Add</button></div>
          </form>
        </details>
      </div>

      <div className="panel">
        <h2>Recently read</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Website</th><th>Company</th><th>From</th><th>Result</th><th className="num">Emails</th><th className="num">New in Leads</th></tr></thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.domain}>
                  <td><a href={`https://${s.domain}`} target="_blank" rel="noreferrer">{s.domain}</a></td>
                  <td>{s.name}</td>
                  <td className="small">{SOURCE[s.source] ?? s.source}{s.source_ref ? <div className="muted">{s.source_ref}</div> : null}</td>
                  <td className="small">{STATUS[s.status] ?? s.status}{s.error && s.status === "done" ? <div className="muted">{s.error}</div> : null}</td>
                  <td className="num">{s.emails_found}</td>
                  <td className="num">{s.emails_added}</td>
                </tr>
              ))}
              {!recent.length && <tr><td colSpan={6} className="muted">Nothing read yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
