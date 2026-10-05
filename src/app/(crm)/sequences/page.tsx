import Link from "next/link";
import { Badge, Flash } from "@/components/ui";
import { db } from "@/lib/store/supabase";
import { createSequence } from "../../actions";

export const dynamic = "force-dynamic";

export default async function SequencesPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const stats = await db().from("sequence_stats").select("*");
  return (
    <>
      <h1>Sequences</h1>
      <Flash msg={msg} />
      <div className="panel">
        <h2>New sequence</h2>
        <p className="muted small">Starts from a 4-email template (first email plus 3 follow-ups in the same thread). Edit the copy before activating.</p>
        <form action={createSequence} className="row">
          <div><input type="text" name="name" placeholder="Furniture importers, East Coast ports" /></div>
          <div style={{ flex: "0 0 auto" }}><button type="submit">Create</button></div>
        </form>
      </div>
      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Sequence</th><th>Status</th><th className="num">Enrolled</th><th className="num">In progress</th><th className="num">Sent</th><th className="num">Replied</th></tr></thead>
            <tbody>
              {(stats.data ?? []).map((s) => (
                <tr key={s.sequence_id}>
                  <td><Link href={`/sequences/${s.sequence_id}`}>{s.name}</Link></td>
                  <td><Badge value={s.status} /></td>
                  <td className="num">{s.enrolled}</td>
                  <td className="num">{s.active}</td>
                  <td className="num">{s.sent}</td>
                  <td className="num">{s.replied}</td>
                </tr>
              ))}
              {!stats.data?.length && <tr><td colSpan={6} className="muted">No sequences yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
