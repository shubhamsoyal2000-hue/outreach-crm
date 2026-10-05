import { notFound } from "next/navigation";
import { Badge, Flash } from "@/components/ui";
import { composeEmail } from "@/lib/compose";
import { db, SupabaseStore } from "@/lib/store/supabase";
import type { Company, Contact, SequenceStep } from "@/lib/types";
import { addStep, deleteLastStep, enrollBatch, saveStep, setSequenceStatus } from "../../../actions";

export const dynamic = "force-dynamic";

const SAMPLE_CONTACT: Contact = {
  id: "sample", company_id: null, email: "jane@example.com", first_name: "Jane", last_name: "Doe", title: "Logistics Manager",
  timezone: null, fields: { top_us_port: "Savannah, Georgia", top_route_from: "Yantian China", top_route_to: "Savannah, Georgia", shipments_90d: "1,200" }, verification_status: "valid", verified_at: null,
};
const SAMPLE_COMPANY: Company = { id: "sample", name: "Acme Imports", domain: "example.com", state: "GA", status: "active", facts: {} };

export default async function SequencePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  const { id } = await params;
  const { msg } = await searchParams;
  const seq = await db().from("sequences").select("*").eq("id", id).maybeSingle();
  if (!seq.data) notFound();
  const store = new SupabaseStore();
  const [steps, settings, inboxes, sample, byStatus] = await Promise.all([
    db().from("sequence_steps").select("*").eq("sequence_id", id).order("step_number"),
    store.getSettings(),
    store.listInboxes(),
    db().from("contacts").select("*, company:companies(*)").eq("verification_status", "valid").limit(1),
    db().from("enrollments").select("status, stop_reason").eq("sequence_id", id),
  ]);

  const sampleRow = sample.data?.[0] as (Contact & { company: Company | null }) | undefined;
  const previewContact = sampleRow ? { ...sampleRow } : SAMPLE_CONTACT;
  const previewCompany = sampleRow ? sampleRow.company : SAMPLE_COMPANY;
  const inbox = inboxes[0] ?? { email: "you@outreach-domain.com", sender_name: "Your Name", signature: "" };
  const firstSubject = (steps.data?.[0] as SequenceStep | undefined)?.subject_a ?? "";

  const summary: Record<string, number> = {};
  for (const e of byStatus.data ?? []) {
    const key = e.status === "stopped" ? `stopped: ${(e.stop_reason ?? "").split(":")[0].replace(/_/g, " ")}` : e.status;
    summary[key] = (summary[key] ?? 0) + 1;
  }

  return (
    <>
      <h1>{seq.data.name} <Badge value={seq.data.status} /></h1>
      <Flash msg={msg} />

      <div className="panel">
        <div className="row" style={{ alignItems: "center" }}>
          <div className="small">
            {Object.entries(summary).map(([k, n]) => <span key={k} style={{ marginRight: 14 }}><strong>{n}</strong> {k}</span>)}
            {!Object.keys(summary).length && <span className="muted">Nobody enrolled yet.</span>}
          </div>
          <div style={{ flex: "0 0 auto" }} className="actions">
            {(seq.data.status === "active" ? ["paused"] : ["active"]).map((s) => (
              <form key={s} action={setSequenceStatus}>
                <input type="hidden" name="sequence_id" value={id} />
                <input type="hidden" name="status" value={s} />
                <button type="submit" className={s === "paused" ? "secondary" : ""}>{s === "active" ? "Activate" : "Pause"}</button>
              </form>
            ))}
          </div>
        </div>
        <form action={enrollBatch} className="row" style={{ marginTop: 14 }}>
          <input type="hidden" name="sequence_id" value={id} />
          <div><label>Add the oldest leads not yet in this sequence</label><input type="number" name="count" min={1} max={1000} defaultValue={50} /></div>
          <div style={{ flex: "0 0 auto" }}><button type="submit" className="secondary">Enroll</button></div>
        </form>
        <p className="small muted" style={{ marginTop: 8 }}>
          Enrolling only queues people. Each inbox still sends no more than its daily limit, so a big batch simply takes more days.
        </p>
      </div>

      {(steps.data ?? []).map((step: SequenceStep & { id: string }) => {
        const preview = composeEmail({
          settings,
          inbox,
          contact: previewContact,
          company: previewCompany,
          enrollment: { subject_variant: "a", thread_subject: firstSubject, gmail_thread_id: "x" },
          step,
          unsubscribeUrl: "https://your-app/unsubscribe?t=...",
        });
        return (
          <div className="panel" key={step.id}>
            <h2>Email {step.step_number}{step.step_number > 1 ? `, ${step.delay_business_days} business days after email ${step.step_number - 1}` : ""}</h2>
            <form action={saveStep}>
              <input type="hidden" name="sequence_id" value={id} />
              <input type="hidden" name="step_number" value={step.step_number} />
              <div className="row">
                <div><label>Subject A{step.step_number > 1 ? " (leave empty to reply in the same thread)" : ""}</label><input type="text" name="subject_a" defaultValue={step.subject_a ?? ""} /></div>
                <div><label>Subject B (optional A/B test)</label><input type="text" name="subject_b" defaultValue={step.subject_b ?? ""} /></div>
                {step.step_number > 1 && <div style={{ flex: "0 0 140px" }}><label>Wait (business days)</label><input type="number" name="delay_business_days" min={1} defaultValue={step.delay_business_days} /></div>}
              </div>
              <label>Body (plain text; {"{{first_name}}"}, {"{{company}}"} and any lead column work)</label>
              <textarea name="body" defaultValue={step.body} />
              <div className="actions"><button type="submit" className="secondary">Save email {step.step_number}</button></div>
            </form>
            <label>Preview{sampleRow ? ` for ${sampleRow.email}` : " with sample data"}</label>
            {preview.ok ? (
              <pre className="preview">{`Subject: ${preview.subject}\n\n${preview.body}`}</pre>
            ) : (
              <div className="notice warn">This lead is missing {preview.missing.join(", ")}, so they would be skipped. Add a fallback like {"{{port|your port}}"} or fill the column.</div>
            )}
          </div>
        );
      })}

      <div className="actions">
        <form action={addStep}><input type="hidden" name="sequence_id" value={id} /><button type="submit" className="secondary">Add a follow-up</button></form>
        <form action={deleteLastStep}><input type="hidden" name="sequence_id" value={id} /><button type="submit" className="secondary">Remove the last email</button></form>
      </div>
    </>
  );
}
