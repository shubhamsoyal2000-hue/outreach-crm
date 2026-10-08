import { describe, expect, it } from "vitest";
import { composeEmail } from "@/lib/compose";
import { approveLine, cleanLine, lineStatus, skipLine } from "@/lib/opening-lines";
import type { Company, Contact, SequenceStep } from "@/lib/types";

const contact = {
  id: "c1", company_id: "co1", email: "jane@acme.com", first_name: "Jane", last_name: "Doe", title: "", timezone: null,
  fields: {}, verification_status: "valid", verified_at: null,
} as Contact;
const step: SequenceStep = {
  step_number: 1, delay_business_days: 0, subject_a: "trucking for {{company|your team}}", subject_b: null,
  body: "Hi {{first_name|there}},\n\n{{custom_line}} We handle drayage and FTL from the port.",
};
function compose(facts: Record<string, string>) {
  const company: Company = { id: "co1", name: "Acme", domain: "acme.com", state: null, status: "active", facts };
  return composeEmail({
    settings: { company_name: "Cargo Solution", postal_address: "1 Main St", opt_out_line: "Reply stop to opt out." },
    inbox: { email: "a@b.com", sender_name: "Marcus Jones", signature: "Marcus" },
    contact, company, enrollment: { subject_variant: "a", thread_subject: null, gmail_thread_id: null }, step, unsubscribeUrl: "https://x/u",
  });
}

describe("opening lines", () => {
  it("only an approved line reaches the email; a draft alone stops the enrollment", () => {
    const draft = { line_draft: "I saw Acme opened a DC in Dallas.", line_confidence: "high" };
    expect(lineStatus(draft)).toBe("pending");
    const pending = compose(draft);
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.missing).toContain("custom_line");

    const approved = approveLine(draft, "I saw Acme opened a DC in Dallas");
    expect(lineStatus(approved)).toBe("approved");
    const sent = compose(approved);
    expect(sent.ok && sent.body).toContain("Hi Jane,\n\nI saw Acme opened a DC in Dallas. We handle drayage");
  });

  it("skipping removes an approved line, and an emptied box counts as a skip", () => {
    const approved = approveLine({}, "Line one.");
    expect(lineStatus(skipLine(approved))).toBe("skipped");
    expect(skipLine(approved).custom_line).toBeUndefined();
    expect(lineStatus(approveLine(approved, "   "))).toBe("skipped");
  });

  it("cleans edited lines so they can't inject template fields", () => {
    expect(cleanLine("  Saw your {{first_name}} plant\n in Ohio ")).toBe("Saw your first_name plant in Ohio.");
    expect(cleanLine("Is that right?")).toBe("Is that right?");
  });
});
