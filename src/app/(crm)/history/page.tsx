import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { Flash, Stat } from "@/components/ui";
import { classifiedHistory } from "@/lib/history/classified";
import type { ClassifiedAddress, HistoryGroup } from "@/lib/history/parse";
import { listScans } from "@/lib/history/supabase";
import { SupabaseStore } from "@/lib/store/supabase";
import { importHistoryGroup, startHistoryScan } from "../../history-actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PHASE: Record<string, string> = {
  sent: "reading sent mail",
  inbound: "reading replies",
  bounces: "reading bounce notices",
  done: "finished",
};

const GROUPS: { key: HistoryGroup; title: string; what: string; button?: string; pickMode?: boolean }[] = [
  { key: "bounced", title: "Bounced", what: "These addresses bounced. Adding them to Do not email means no inbox ever tries them again.", button: "Add all to Do not email" },
  { key: "opted_out", title: "Asked you to stop", what: "They replied asking not to be emailed.", button: "Add all to Do not email" },
  {
    key: "replied",
    title: "Replied before (existing contacts)",
    what: "They, or a colleague at the same company, replied to you. They're added to Leads but kept out of cold sequences, so you can write to them personally.",
    button: "Import as existing contacts",
  },
  { key: "recent", title: "Delivered in the last 3 months", what: "Emailed recently with no bounce. They're imported as verified, so no verifier credit is spent.", button: "Import as verified leads" },
  { key: "older", title: "Delivered before that", what: "Delivered, but long enough ago that people may have moved on. They're imported as leads and checked by the verifier before their first email.", button: "Import as leads" },
  {
    key: "carrier",
    title: "Personal addresses and possible carriers",
    what: "Trucking-style names, and personal Gmail, Yahoo or QQ addresses. Nothing here is imported unless you tick it, so tick only the shippers, forwarders and agents you want to email.",
    button: "Import ticked as leads",
    pickMode: true,
  },
  { key: "internal", title: "Your team, blocked companies and system addresses", what: "Your own inboxes and colleagues, companies on your Do not email list, and no-reply or system addresses. These are never imported." },
];

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

function GroupTable({ rows, pickMode, actionable }: { rows: ClassifiedAddress[]; pickMode?: boolean; actionable: boolean }) {
  const shown = rows.slice(0, 1500);
  return (
    <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
      <table>
        <thead>
          <tr>
            {actionable && <th>{pickMode ? "Import" : "Skip"}</th>}
            <th>Email</th><th>Name</th><th className="num">Emails sent</th><th>Last emailed</th><th>From inbox</th><th>Why</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.email}>
              {actionable && (
                <td><input type="checkbox" name={pickMode ? "pick" : "skip"} value={r.email} style={{ width: "auto" }} /></td>
              )}
              <td>{r.email}{r.in_crm && <span className="muted small"> · in Leads</span>}{r.suppressed && <span className="muted small"> · on Do not email</span>}</td>
              <td>{r.name ?? ""}</td>
              <td className="num">{r.sent_count}</td>
              <td>{day(r.last_sent)}</td>
              <td className="small">{r.inboxes.join(", ")}</td>
              <td className="small muted">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <p className="muted small">Showing the first {shown.length} of {rows.length}. The button applies to all {rows.length}.</p>}
    </div>
  );
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const [scans, inboxes] = await Promise.all([listScans(), new SupabaseStore().listInboxes()]);
  const running = scans.some((s) => s.status === "queued" || s.status === "running");
  const rows = scans.length ? await classifiedHistory() : [];
  const byGroup = new Map<HistoryGroup, ClassifiedAddress[]>();
  for (const r of rows) byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);

  return (
    <>
      {running && <meta httpEquiv="refresh" content="20" />}
      <h1>Gmail history</h1>
      <Flash msg={msg} />
      <p className="muted small">
        Reads who your inboxes emailed, and who bounced, replied or asked to stop. It only reads headers, never changes or sends anything, and nothing goes into
        Leads until you click a button below. <Link href="/contacts">Back to Leads</Link>
      </p>

      <div className="panel">
        <h2>Scan</h2>
        {!!scans.length && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Inbox</th><th>Progress</th><th className="num">Emails read</th><th>Since</th></tr></thead>
              <tbody>
                {scans.map((s) => (
                  <tr key={s.inbox_id}>
                    <td>{inboxes.find((i) => i.id === s.inbox_id)?.email ?? "removed inbox"}</td>
                    <td>
                      {s.status === "error" ? <span style={{ color: "var(--bad)" }}>{s.error}</span> : s.status === "queued" ? "waiting to start" : PHASE[s.phase]}
                      {s.stats && (s.phase === "bounces" || s.phase === "done") && (
                        <span className="muted small">
                          {" "}· {s.stats.inbound_reply ?? 0} replies, {(s.stats.inbound_bounce ?? 0) + (s.stats.bounces_bounce ?? 0)} bounces found
                        </span>
                      )}
                    </td>
                    <td className="num">{s.messages_read}</td>
                    <td>{s.since}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {running ? (
          <p className="muted small">Scanning in the background. This page refreshes every 20 seconds, and you can leave it and come back.</p>
        ) : (
          <form action={startHistoryScan}>
            <div className="row">
              <div style={{ flex: "0 0 200px" }}><label>Read mail since</label><input type="date" name="since" defaultValue="2026-01-01" /></div>
              <div><button type="submit">{scans.length ? "Scan again" : "Scan all connected inboxes"}</button></div>
            </div>
          </form>
        )}
      </div>

      {!!rows.length && (
        <>
          <div className="grid">
            {GROUPS.map((g) => <Stat key={g.key} n={byGroup.get(g.key)?.length ?? 0} label={g.title.toLowerCase()} />)}
          </div>
          {running && <Flash kind="warn" msg="The scan is still running, so these numbers will change. Wait for it to finish before importing." />}

          {GROUPS.map((g) => {
            const list = byGroup.get(g.key) ?? [];
            if (!list.length) return null;
            const done = list.filter((r) => (g.key === "bounced" || g.key === "opted_out" ? r.suppressed : r.in_crm)).length;
            return (
              <div className="panel" key={g.key}>
                <h2>{g.title} ({list.length})</h2>
                <p className="muted small">{g.what}</p>
                {g.button ? (
                  <form action={importHistoryGroup}>
                    <input type="hidden" name="group" value={g.key} />
                    <details>
                      <summary className="small" style={{ cursor: "pointer", marginBottom: 8 }}>
                        {g.pickMode ? "Show the list and tick the ones to import" : "Show the list (tick any you want to skip)"}
                      </summary>
                      <GroupTable rows={list} pickMode={g.pickMode} actionable />
                    </details>
                    <div className="actions" style={{ alignItems: "center" }}>
                      {done === list.length ? (
                        <span className="badge good">Done: all {list.length} are in {g.key === "bounced" || g.key === "opted_out" ? "Do not email" : "Leads"}</span>
                      ) : (
                        <>
                          <SubmitButton disabled={running}>{g.button}</SubmitButton>
                          {done > 0 && <span className="muted small">{done} of {list.length} already done</span>}
                        </>
                      )}
                    </div>
                  </form>
                ) : (
                  <details>
                    <summary className="small" style={{ cursor: "pointer" }}>Show the list</summary>
                    <GroupTable rows={list} actionable={false} />
                  </details>
                )}
              </div>
            );
          })}
        </>
      )}
      {!running && !!scans.length && !rows.length && <p className="muted">The scan finished but found no sent emails in that period.</p>}
    </>
  );
}
