import { Flash } from "@/components/ui";
import { SupabaseStore } from "@/lib/store/supabase";
import { saveSettings } from "../../actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const s = await new SupabaseStore().getSettings();
  return (
    <>
      <h1>Settings</h1>
      <Flash msg={msg} />
      <form action={saveSettings} className="panel">
        <h2>Email footer (required by US law)</h2>
        <div className="row">
          <div><label>Company name</label><input type="text" name="company_name" defaultValue={s.company_name} placeholder="ABC Cargo" /></div>
          <div><label>Postal address</label><input type="text" name="postal_address" defaultValue={s.postal_address} placeholder="Street, City, State ZIP, Country" /></div>
        </div>
        <label>Opt-out line (the unsubscribe link is added after it)</label>
        <input type="text" name="opt_out_line" defaultValue={s.opt_out_line} />

        <h2 style={{ marginTop: 22 }}>Who to email</h2>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" name="allow_shared_inboxes" value="1" defaultChecked={s.allow_shared_inboxes} style={{ width: "auto" }} /> Email shared inboxes like
          info@, sales@ and orders@
        </label>
        <p className="muted small">They do reply, but get more spam reports than a named person. No-reply, abuse, HR and job inboxes are always skipped.</p>

        <h2 style={{ marginTop: 22 }}>Alerts</h2>
        <label>Email me here when a prospect replies or an inbox stops sending</label>
        <input type="email" name="alert_email" defaultValue={s.alert_email} placeholder="you@example.com" />
        <p className="muted small">Sent from one of your connected inboxes. Leave it empty to turn alerts off.</p>

        <h2 style={{ marginTop: 22 }}>Sending window</h2>
        <p className="muted small">Hours in each recipient&apos;s own time zone (taken from their state), Monday to Friday, skipping US holidays.</p>
        <div className="row">
          <div><label>Start hour</label><input type="number" name="send_window_start_hour" min={0} max={23} defaultValue={s.send_window_start_hour} /></div>
          <div><label>End hour</label><input type="number" name="send_window_end_hour" min={1} max={24} defaultValue={s.send_window_end_hour} /></div>
          <div><label>Team time zone (daily limits reset at midnight here)</label><input type="text" name="default_timezone" defaultValue={s.default_timezone} /></div>
        </div>

        <h2 style={{ marginTop: 22 }}>Safety rules</h2>
        <p className="muted small">
          Fixed on purpose: warm-up starts at {s.ramp_start_per_day} a day and adds {s.ramp_step_per_business_day} per business day; catch-all
          addresses are capped at {Math.round(s.catch_all_max_share * 100)}% of a day&apos;s sends; addresses are re-verified after{" "}
          {s.verification_max_age_days} days; an inbox pauses itself if more than {(s.bounce_pause_rate * 100).toFixed(0)}% of its last{" "}
          {s.bounce_window_sends} emails bounce. Change these only in the database, after the health numbers have been green for weeks.
        </p>
        <div className="actions"><button type="submit">Save settings</button></div>
      </form>
    </>
  );
}
