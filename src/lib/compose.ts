import { render, tidyName } from "./template";
import type { Company, Contact, Enrollment, Inbox, SequenceStep, Settings } from "./types";

export interface ComposeInput {
  settings: Pick<Settings, "company_name" | "postal_address" | "opt_out_line">;
  inbox: Pick<Inbox, "email" | "sender_name" | "signature">;
  contact: Contact;
  company: Company | null;
  enrollment: Pick<Enrollment, "subject_variant" | "thread_subject" | "gmail_thread_id">;
  step: SequenceStep;
  unsubscribeUrl: string;
}

export type Composed =
  | { ok: true; subject: string; body: string; newThread: boolean }
  | { ok: false; missing: string[] };

/** A company "name" that is only its web address (e.g. "acme.com") reads badly in an email, so the fallback is used instead. */
function displayCompanyName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(n) ? "" : n;
}

export function templateVars(contact: Contact, company: Company | null, inbox: Pick<Inbox, "sender_name">) {
  const first = tidyName(contact.first_name);
  const last = tidyName(contact.last_name);
  return {
    ...(company?.facts ?? {}),
    ...contact.fields,
    first_name: first,
    last_name: last,
    full_name: [first, last].filter(Boolean).join(" "),
    title: contact.title,
    email: contact.email,
    company: displayCompanyName(company?.name ?? contact.fields.company),
    sender_name: inbox.sender_name,
    sender_first_name: inbox.sender_name.split(" ")[0],
  } as Record<string, string>;
}

/**
 * Renders one step into the final plain-text email: the step's copy, the
 * sender's signature, the opt-out line with its link, and the postal address
 * CAN-SPAM requires. A follow-up with no subject of its own replies in the
 * same thread with "Re: <first subject>".
 */
export function composeEmail(input: ComposeInput): Composed {
  const { settings, inbox, contact, company, enrollment, step } = input;
  const vars = templateVars(contact, company, inbox);

  let subjectTemplate: string | null =
    enrollment.subject_variant === "b" && step.subject_b ? step.subject_b : step.subject_a;
  let newThread = true;
  if (!subjectTemplate?.trim()) {
    if (!enrollment.thread_subject) return { ok: false, missing: ["subject"] };
    newThread = false;
    subjectTemplate = null;
  }

  const subject = subjectTemplate ? render(subjectTemplate, vars) : { text: `Re: ${enrollment.thread_subject}`, missing: [] };
  const body = render(step.body, vars);
  const missing = [...new Set([...subject.missing, ...body.missing])];
  if (missing.length) return { ok: false, missing };

  // The inbox signature normally starts with the sender's name; without one, the name alone signs off.
  const signature = inbox.signature.trim() || inbox.sender_name;
  const footer = [
    `${settings.opt_out_line.trim()} ${input.unsubscribeUrl}`,
    [settings.company_name, settings.postal_address].filter((s) => s.trim()).join(", "),
  ].join("\n");

  const text = [body.text.trim(), signature, footer].filter(Boolean).join("\n\n");
  return { ok: true, subject: subject.text.trim(), body: text, newThread };
}
