import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Flash } from "@/components/ui";
import { ago } from "@/lib/format";
import { db } from "@/lib/store/supabase";
import { QUOTE_STATUSES, type Company, type Contact, type Quote } from "@/lib/types";
import { saveQuote } from "../../../actions";

export const dynamic = "force-dynamic";

const STATUS_LABEL = { new: "New", quoting: "Working on rate", quoted: "Quoted", won: "Won", lost: "Lost" } as const;

const FACTS: [string, string][] = [
  ["top_us_port", "Main US port"],
  ["top_route_from", "Ships from"],
  ["top_route_to", "Ships to"],
  ["shipments_90d", "Shipments, last 90 days"],
  ["shipments_year", "Shipments, last year"],
  ["last_shipment", "Last shipment"],
  ["company_phone", "Company phone"],
];

type Row = Quote & { company: Company | null; contact: Contact | null; inbox: { email: string } | null };

export default async function QuotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  const { id } = await params;
  const { msg } = await searchParams;
  const res = await db().from("quotes").select("*, company:companies(*), contact:contacts(*), inbox:inboxes(email)").eq("id", id).maybeSingle();
  const q = res.data as Row | null;
  if (!q) notFound();

  const replies = await db()
    .from("messages")
    .select("id, from_email, subject, snippet, occurred_at")
    .eq("direction", "inbound")
    .eq("kind", "reply")
    .eq("from_email", q.from_email)
    .order("occurred_at", { ascending: false })
    .limit(10);

  const name = [q.contact?.first_name, q.contact?.last_name].filter(Boolean).join(" ");
  const facts = { ...(q.company?.facts ?? {}), ...(q.contact?.fields ?? {}) } as Record<string, string>;
  const gmailLink = q.inbox && q.gmail_thread_id ? `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(q.inbox.email)}#all/${q.gmail_thread_id}` : null;

  return (
    <>
      <p className="small"><Link href="/quotes">← All quotes</Link></p>
      <h1>{q.company?.name ?? q.from_email} <Badge value={q.status} /></h1>
      <Flash msg={msg} />

      <div className="panel">
        <div className="row" style={{ alignItems: "start" }}>
          <div>
            <div><strong>{name || q.from_email}</strong>{q.contact?.title ? `, ${q.contact.title}` : ""}</div>
            <div className="muted small">{q.from_email}</div>
            {q.inbox && <div className="muted small">Wrote to {q.inbox.email}. Answer from that inbox so it stays in the same thread.</div>}
            {gmailLink && <div className="actions"><a className="button" href={gmailLink} target="_blank" rel="noreferrer">Open the conversation in Gmail</a></div>}
          </div>
          <div className="small">
            {FACTS.filter(([k]) => facts[k]).map(([k, label]) => <div key={k}><span className="muted">{label}:</span> {facts[k]}</div>)}
            {q.company?.domain && <div><span className="muted">Website:</span> <a href={`https://${q.company.domain}`} target="_blank" rel="noreferrer">{q.company.domain}</a></div>}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Quote</h2>
        <form action={saveQuote}>
          <input type="hidden" name="id" value={q.id} />
          <div className="row">
            <div><label>From (city or port)</label><input type="text" name="lane_from" defaultValue={q.lane_from} placeholder={facts.top_us_port ?? ""} /></div>
            <div><label>To</label><input type="text" name="lane_to" defaultValue={q.lane_to} /></div>
            <div><label>Equipment</label><input type="text" name="equipment" defaultValue={q.equipment} placeholder="53' dry van, 40' container..." /></div>
            <div><label>Rate quoted (USD)</label><input type="number" name="rate_quoted" min={0} step="0.01" defaultValue={q.rate_quoted ?? ""} /></div>
            <div>
              <label>Status</label>
              <select name="status" defaultValue={q.status}>
                {QUOTE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </div>
          </div>
          <label>Notes</label>
          <textarea name="notes" rows={4} defaultValue={q.notes} style={{ minHeight: 90, fontFamily: "inherit" }} />
          <div className="actions"><button type="submit">Save</button></div>
        </form>
      </div>

      <div className="panel">
        <h2>Their replies ({q.reply_count})</h2>
        {(replies.data ?? []).map((m) => (
          <div key={m.id} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
            <div className="small"><strong>{m.subject}</strong> <span className="muted">· {ago(m.occurred_at)}</span></div>
            <div>{m.snippet}</div>
          </div>
        ))}
        {!replies.data?.length && <p>{q.last_reply_snippet || <span className="muted">Added by hand.</span>}</p>}
      </div>
    </>
  );
}
