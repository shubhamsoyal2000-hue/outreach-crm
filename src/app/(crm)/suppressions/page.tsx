import { Badge, Flash } from "@/components/ui";
import { db } from "@/lib/store/supabase";
import { addSuppression, removeSuppression } from "../../actions";

export const dynamic = "force-dynamic";

export default async function SuppressionsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const rows = await db().from("suppressions").select("*").order("created_at", { ascending: false }).limit(200);
  const total = await db().from("suppressions").select("id", { count: "exact", head: true });
  return (
    <>
      <h1>Do not email</h1>
      <Flash msg={msg} />
      <div className="panel">
        <p className="muted small">
          Everyone here is skipped on every import and every send, from every inbox. Unsubscribes, opt-out replies and hard bounces are added
          automatically. Add your existing customers&apos; domains so they never get cold email.
        </p>
        <form action={addSuppression} className="row">
          <div><label>Emails or domains, one per line (pasting a list works)</label><textarea name="value" rows={4} placeholder={"acme.com\njane@example.com\nwww.bigshipper.com"} required /></div>
          <div><label>Note (optional)</label><input type="text" name="note" placeholder="existing customer" /></div>
          <div style={{ flex: "0 0 auto" }}><button type="submit">Add</button></div>
        </form>
      </div>
      <div className="panel">
        <h2>{total.count ?? 0} entries</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Email or domain</th><th>Reason</th><th>Note</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {(rows.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td>{s.email ?? s.domain}</td>
                  <td><Badge value={s.reason} /></td>
                  <td className="small muted">{s.note}</td>
                  <td className="small">{new Date(s.created_at).toLocaleDateString("en-US")}</td>
                  <td>
                    {s.reason === "manual" && (
                      <form action={removeSuppression}>
                        <input type="hidden" name="id" value={s.id} />
                        <button type="submit" className="secondary">Remove</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
