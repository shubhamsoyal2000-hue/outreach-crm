import Link from "next/link";
import { Badge, Flash, pct, Stat } from "@/components/ui";
import { env } from "@/lib/config";
import { db, SupabaseStore } from "@/lib/store/supabase";
import { localDay, ymdToString } from "@/lib/time";
import { dailyCap } from "@/lib/warmup";
import { runNow, setSending } from "../actions";

export const dynamic = "force-dynamic";

interface InboxStat { inbox_id: string; email: string; status: string; sent: number; bounced: number; replied: number; auto_replies: number; unsubscribe_replies: number }
interface SeqStat { sequence_id: string; name: string; status: string; enrolled: number; active: number; sent: number; bounced: number; replied: number; unsubscribed: number }

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const store = new SupabaseStore();
  const settings = await store.getSettings();
  const inboxes = await store.listInboxes();
  const today = localDay(new Date(), settings.default_timezone);
  const todayStr = ymdToString(today);

  const [inboxStats, seqStats, replies, unverified, newQuotes] = await Promise.all([
    db().from("inbox_stats").select("*"),
    db().from("sequence_stats").select("*"),
    db()
      .from("messages")
      .select("id, kind, from_email, subject, snippet, occurred_at, contact:contacts(first_name, last_name, company:companies(name))")
      .eq("direction", "inbound")
      .in("kind", ["reply", "unsubscribe_reply"])
      .order("occurred_at", { ascending: false })
      .limit(25),
    db().from("contacts").select("id", { count: "exact", head: true }).eq("verification_status", "unverified"),
    db().from("quotes").select("id", { count: "exact", head: true }).eq("status", "new"),
  ]);
  const statsById = new Map(((inboxStats.data ?? []) as InboxStat[]).map((s) => [s.inbox_id, s]));
  const todayCounts = await Promise.all(inboxes.map((i) => store.countSentOnDay(i.id, todayStr)));

  const warnings: string[] = [];
  if (!settings.postal_address) warnings.push("Add your postal address in Settings. US law (CAN-SPAM) requires it in every email, so nothing sends without it.");
  if (!env.verifier || !env.verifierApiKey) warnings.push(`No email verification API is set up. ${unverified.count ?? 0} unverified contacts will wait instead of being emailed.`);
  if (!inboxes.length) warnings.push("No inbox is connected yet. Connect one under Inboxes.");
  for (const i of inboxes) if (i.status !== "active" && i.paused_reason) warnings.push(`${i.email} is ${i.status}: ${i.paused_reason}`);

  const totals = ((inboxStats.data ?? []) as InboxStat[]).reduce(
    (t, s) => ({ sent: t.sent + Number(s.sent), bounced: t.bounced + Number(s.bounced), replied: t.replied + Number(s.replied), unsub: t.unsub + Number(s.unsubscribe_replies) }),
    { sent: 0, bounced: 0, replied: 0, unsub: 0 },
  );
  const sentToday = todayCounts.reduce((n, c) => n + c.total, 0);
  const capToday = inboxes.reduce((n, i) => n + dailyCap(i, today, settings), 0);

  return (
    <>
      <h1>Dashboard</h1>
      <Flash msg={msg} />
      {warnings.map((w) => <Flash key={w} msg={w} kind="warn" />)}
      {!!newQuotes.count && (
        <div className="notice">
          <strong>{newQuotes.count} new {newQuotes.count === 1 ? "reply is" : "replies are"} waiting for a quote.</strong>{" "}
          <Link href="/quotes?status=new">Open quotes</Link>
        </div>
      )}

      <div className="panel">
        <div className="row" style={{ alignItems: "center" }}>
          <div>
            <strong>Sending is {settings.sending_enabled ? "on" : "off"}.</strong>{" "}
            <span className="muted">
              {settings.sending_enabled
                ? "Emails go out every few minutes within each recipient's business hours."
                : "No email leaves any inbox until this is on."}
            </span>
          </div>
          <div style={{ flex: "0 0 auto" }} className="actions">
            <form action={setSending}>
              <input type="hidden" name="on" value={settings.sending_enabled ? "0" : "1"} />
              <button type="submit" className={settings.sending_enabled ? "danger" : ""}>{settings.sending_enabled ? "Stop all sending" : "Turn sending on"}</button>
            </form>
            <form action={runNow}>
              <button type="submit" className="secondary">Check inboxes and send now</button>
            </form>
          </div>
        </div>
      </div>

      <div className="grid">
        <Stat n={`${sentToday} / ${capToday}`} label="sent today / today's safe limit" />
        <Stat n={totals.sent} label="emails sent" />
        <Stat n={pct(totals.bounced, totals.sent)} label="bounce rate (keep under 2%)" />
        <Stat n={pct(totals.replied, totals.sent)} label="reply rate" />
        <Stat n={totals.unsub} label="opt-out replies" />
      </div>

      <div className="panel">
        <h2>Inboxes</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Inbox</th><th>Status</th><th className="num">Today</th><th className="num">Sent</th><th className="num">Bounce rate</th><th className="num">Replies</th><th className="num">Out of office</th></tr></thead>
            <tbody>
              {inboxes.map((i, idx) => {
                const s = statsById.get(i.id);
                return (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td><Badge value={i.status} /></td>
                    <td className="num">{todayCounts[idx].total} / {dailyCap(i, today, settings)}</td>
                    <td className="num">{s?.sent ?? 0}</td>
                    <td className="num">{pct(Number(s?.bounced ?? 0), Number(s?.sent ?? 0))}</td>
                    <td className="num">{s?.replied ?? 0}</td>
                    <td className="num">{s?.auto_replies ?? 0}</td>
                  </tr>
                );
              })}
              {!inboxes.length && <tr><td colSpan={7} className="muted">No inboxes yet. <Link href="/inboxes">Connect one</Link>.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Sequences</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Sequence</th><th>Status</th><th className="num">Enrolled</th><th className="num">In progress</th><th className="num">Sent</th><th className="num">Bounced</th><th className="num">Replied</th><th className="num">Unsubscribed</th></tr></thead>
            <tbody>
              {((seqStats.data ?? []) as SeqStat[]).map((s) => (
                <tr key={s.sequence_id}>
                  <td><Link href={`/sequences/${s.sequence_id}`}>{s.name}</Link></td>
                  <td><Badge value={s.status} /></td>
                  <td className="num">{s.enrolled}</td>
                  <td className="num">{s.active}</td>
                  <td className="num">{s.sent}</td>
                  <td className="num">{s.bounced}</td>
                  <td className="num">{s.replied}</td>
                  <td className="num">{s.unsubscribed}</td>
                </tr>
              ))}
              {!seqStats.data?.length && <tr><td colSpan={8} className="muted">No sequences yet. <Link href="/sequences">Create one</Link>.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Latest replies</h2>
        <p className="muted small">Answer these from the inbox they arrived in. Sequences for the whole company have already stopped.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>From</th><th>Company</th><th>Type</th><th>Message</th></tr></thead>
            <tbody>
              {(replies.data ?? []).map((r) => {
                const contact = r.contact as unknown as { first_name: string; last_name: string; company: { name: string } | null } | null;
                return (
                  <tr key={r.id}>
                    <td className="small">{new Date(r.occurred_at).toLocaleString("en-US", { timeZone: settings.default_timezone, dateStyle: "medium", timeStyle: "short" })}</td>
                    <td>{r.from_email}</td>
                    <td>{contact?.company?.name ?? ""}</td>
                    <td><Badge value={r.kind === "reply" ? "reply" : "opt-out"} /></td>
                    <td className="small">{r.snippet}</td>
                  </tr>
                );
              })}
              {!replies.data?.length && <tr><td colSpan={5} className="muted">No replies yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
