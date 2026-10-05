import { Badge, Flash } from "@/components/ui";
import { db } from "@/lib/store/supabase";
import { addSuppression } from "../../actions";

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
          <div><label>Email or domain</label><input type="text" name="value" placeholder="jane@acme.com or acme.com" required /></div>
          <div><label>Note (optional)</label><input type="text" name="note" placeholder="existing customer" /></div>
          <div style={{ flex: "0 0 auto" }}><button type="submit">Add</button></div>
        </form>
      </div>
      <div className="panel">
        <h2>{total.count ?? 0} entries</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Email or domain</th><th>Reason</th><th>Note</th><th>Added</th></tr></thead>
            <tbody>
              {(rows.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td>{s.email ?? s.domain}</td>
                  <td><Badge value={s.reason} /></td>
                  <td className="small muted">{s.note}</td>
                  <td className="small">{new Date(s.created_at).toLocaleDateString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
