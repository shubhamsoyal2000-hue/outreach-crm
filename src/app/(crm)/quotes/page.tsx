import Link from "next/link";
import { Badge, Flash } from "@/components/ui";
import { ago, money } from "@/lib/format";
import { db } from "@/lib/store/supabase";
import { QUOTE_STATUSES, type Quote, type QuoteStatus } from "@/lib/types";
import { addQuote } from "../../actions";

export const dynamic = "force-dynamic";

type Row = Quote & { company: { name: string } | null; contact: { first_name: string | null; last_name: string | null } | null };

const LABEL: Record<QuoteStatus | "open", string> = {
  open: "Open",
  new: "New",
  quoting: "Working on rate",
  quoted: "Quoted",
  won: "Won",
  lost: "Lost",
};

export default async function QuotesPage({ searchParams }: { searchParams: Promise<{ msg?: string; status?: string }> }) {
  const { msg, status } = await searchParams;
  const tab: QuoteStatus | "open" = QUOTE_STATUSES.includes(status as QuoteStatus) ? (status as QuoteStatus) : "open";

  const [all, list] = await Promise.all([
    db().from("quotes").select("status"),
    (tab === "open"
      ? db().from("quotes").select("*, company:companies(name), contact:contacts(first_name, last_name)").not("status", "in", "(won,lost)")
      : db().from("quotes").select("*, company:companies(name), contact:contacts(first_name, last_name)").eq("status", tab)
    ).order("last_reply_at", { ascending: false }).limit(200),
  ]);
  const counts: Record<string, number> = { open: 0 };
  for (const q of all.data ?? []) {
    counts[q.status] = (counts[q.status] ?? 0) + 1;
    if (q.status !== "won" && q.status !== "lost") counts.open++;
  }
  const rows = (list.data ?? []) as Row[];

  return (
    <>
      <h1>Quotes</h1>
      <Flash msg={msg} />
      <p className="muted small">Every prospect who replies gets a card here. Fill in the lane and rate as you work it, and mark it won or lost.</p>

      <div className="actions" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        {(["open", ...QUOTE_STATUSES] as const).map((s) => (
          <Link key={s} href={s === "open" ? "/quotes" : `/quotes?status=${s}`} className={`button ${s === tab ? "" : "secondary"}`}>
            {LABEL[s]} ({counts[s] ?? 0})
          </Link>
        ))}
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Company</th><th>Who</th><th>Lane</th><th>Equipment</th><th className="num">Rate</th><th>Status</th><th>Last reply</th></tr>
            </thead>
            <tbody>
              {rows.map((q) => {
                const name = [q.contact?.first_name, q.contact?.last_name].filter(Boolean).join(" ");
                const lane = q.lane_from || q.lane_to ? `${q.lane_from || "?"} → ${q.lane_to || "?"}` : "";
                return (
                  <tr key={q.id}>
                    <td><Link href={`/quotes/${q.id}`}>{q.company?.name ?? q.from_email.split("@")[1]}</Link></td>
                    <td>{name ? `${name} · ` : ""}<span className="muted small">{q.from_email}</span></td>
                    <td>{lane || <span className="muted small">add lane</span>}</td>
                    <td>{q.equipment}</td>
                    <td className="num">{money(q.rate_quoted)}</td>
                    <td><Badge value={q.status} /></td>
                    <td>
                      {ago(q.last_reply_at)}
                      <div className="muted small" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.last_reply_snippet}</div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={7} className="muted">Nothing here yet. Replies show up automatically within 5 minutes.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Add a quote request by hand</h2>
        <p className="muted small">For requests that came by phone, WhatsApp or another inbox.</p>
        <form action={addQuote}>
          <div className="row">
            <div><label>Their email</label><input type="email" name="from_email" required /></div>
            <div><label>From (city or port)</label><input type="text" name="lane_from" /></div>
            <div><label>To</label><input type="text" name="lane_to" /></div>
            <div><label>Equipment</label><input type="text" name="equipment" placeholder="53' dry van, 40' container..." /></div>
          </div>
          <label>Notes</label>
          <textarea name="notes" rows={2} style={{ minHeight: 60, fontFamily: "inherit" }} />
          <button type="submit">Add quote</button>
        </form>
      </div>
    </>
  );
}
