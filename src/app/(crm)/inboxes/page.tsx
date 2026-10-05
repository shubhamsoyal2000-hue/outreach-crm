import { Badge, Flash } from "@/components/ui";
import { redirectUri } from "@/lib/gmail";
import { SupabaseStore } from "@/lib/store/supabase";
import { localDay } from "@/lib/time";
import { dailyCap } from "@/lib/warmup";
import { saveInbox, setInboxStatus } from "../../actions";

export const dynamic = "force-dynamic";

export default async function InboxesPage({ searchParams }: { searchParams: Promise<{ msg?: string; error?: string; connected?: string }> }) {
  const { msg, error, connected } = await searchParams;
  const store = new SupabaseStore();
  const settings = await store.getSettings();
  const inboxes = await store.listInboxes();
  const today = localDay(new Date(), settings.default_timezone);

  return (
    <>
      <h1>Inboxes</h1>
      <Flash msg={msg} />
      <Flash msg={error} kind="bad" />
      <Flash msg={connected ? `${connected} is connected. Fill in its details below, then resume it.` : undefined} />

      <div className="panel">
        <h2>Connect a Gmail or Google Workspace inbox</h2>
        <p className="muted small">
          Sign in as the inbox you want to send from. The CRM gets permission to send and read that mailbox; no password is stored.
          In Google Cloud, the OAuth client must list this redirect URL: <code>{redirectUri()}</code>
        </p>
        <a className="button" href="/api/oauth/google/start">Connect inbox</a>
      </div>

      {inboxes.map((i) => (
        <div className="panel" key={i.id}>
          <div className="row" style={{ alignItems: "center" }}>
            <div>
              <h2 style={{ margin: 0 }}>{i.email} <Badge value={i.status} /></h2>
              {i.paused_reason && <div className="small muted">{i.paused_reason}</div>}
              <div className="small muted">Today&apos;s safe limit: {dailyCap({ ...i, status: "active" }, today, settings)} cold emails (warm-up ramp, max {i.max_daily})</div>
            </div>
            <div style={{ flex: "0 0 auto" }} className="actions">
              {i.status === "disconnected" ? (
                <a className="button" href={`/api/oauth/google/start?hint=${encodeURIComponent(i.email)}`}>Reconnect</a>
              ) : (
                <form action={setInboxStatus}>
                  <input type="hidden" name="id" value={i.id} />
                  <input type="hidden" name="status" value={i.status === "active" ? "paused" : "active"} />
                  <button type="submit" className={i.status === "active" ? "secondary" : ""}>{i.status === "active" ? "Pause" : "Resume"}</button>
                </form>
              )}
            </div>
          </div>
          <form action={saveInbox}>
            <input type="hidden" name="id" value={i.id} />
            <div className="row">
              <div><label>Sender name (a real person)</label><input type="text" name="sender_name" defaultValue={i.sender_name} placeholder="Rahul Sharma" /></div>
              <div>
                <label>Cold start date (first day of cold email, after 2+ weeks of warm-up)</label>
                <input type="date" name="cold_start_date" defaultValue={i.cold_start_date ?? ""} />
              </div>
              <div><label>Ceiling per day (40 is the safe default)</label><input type="number" name="max_daily" min={0} max={60} defaultValue={i.max_daily} /></div>
            </div>
            <label>Signature (plain text, added under every email)</label>
            <textarea name="signature" defaultValue={i.signature} style={{ minHeight: 90 }} placeholder={"Rahul Sharma\nSales Manager, ABC Cargo\n+1 555 010 0000 · abccargo.com"} />
            <div className="actions"><button type="submit" className="secondary">Save</button></div>
          </form>
        </div>
      ))}
    </>
  );
}
