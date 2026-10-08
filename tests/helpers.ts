import { randomUUID } from "node:crypto";
import { MailerError, type EngineDeps, type FetchedMessage, type Mailer, type SentMessage } from "@/lib/engine/ports";
import { MemoryStore } from "@/lib/store/memory";
import type { Company, Contact, Inbox, SequenceStep } from "@/lib/types";

export class FakeMailer implements Mailer {
  sent: { inbox: string; raw: string; threadId: string | null }[] = [];
  inbound: Record<string, FetchedMessage[]> = {};
  failWith: MailerError | null = null;
  getText?: (inbox: Inbox, messageId: string) => Promise<string>;

  async send(inbox: Inbox, raw: string, threadId: string | null): Promise<SentMessage> {
    if (this.failWith) throw this.failWith;
    this.sent.push({ inbox: inbox.email, raw, threadId });
    const n = this.sent.length;
    return { messageId: `gm-${n}`, threadId: threadId ?? `thread-${n}`, rfcMessageId: `<msg-${n}@mail.gmail.com>` };
  }

  async listInbound(inbox: Inbox): Promise<FetchedMessage[]> {
    return this.inbound[inbox.email] ?? [];
  }
}

export function makeDeps(mailer: Mailer, clock: { now: Date }, verifier: EngineDeps["verifier"] = null): EngineDeps {
  let seed = 42;
  return {
    mailer,
    verifier,
    unsubscribeUrl: (id) => `https://crm.example.com/unsubscribe?t=${id}`,
    now: () => clock.now,
    // Deterministic pseudo-random numbers so tests are repeatable.
    rng: () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    },
  };
}

export const STEPS: SequenceStep[] = [
  { step_number: 1, delay_business_days: 0, subject_a: "{{commodity}} into {{port}}", subject_b: "question about your {{port}} freight", body: "Hi {{first_name}},\n\nI saw {{company}} bringing {{commodity}} into {{port}}." },
  { step_number: 2, delay_business_days: 3, subject_a: null, subject_b: null, body: "Hi {{first_name}}, just bringing this back up." },
  { step_number: 3, delay_business_days: 4, subject_a: null, subject_b: null, body: "{{first_name}}, is freight from {{port}} something you handle?" },
];

export function seed(opts: { inboxes?: number; settings?: Partial<MemoryStore["settings"]> } = {}) {
  const store = new MemoryStore();
  Object.assign(store.settings, {
    sending_enabled: true,
    company_name: "ABC Cargo",
    postal_address: "123 Main St, Suite 4, Newark, NJ 07102",
    ...opts.settings,
  });
  for (let i = 0; i < (opts.inboxes ?? 1); i++) {
    store.inboxes.push({
      id: randomUUID(),
      email: `sender${i}@getabccargo.com`,
      sender_name: `Sender ${i}`,
      signature: `Sender ${i}\nABC Cargo`,
      status: "active",
      paused_reason: null,
      cold_start_date: "2026-10-01",
      max_daily: 40,
      refresh_token_enc: "enc",
      last_synced_at: null,
      last_sent_at: null,
      next_send_after: null,
    });
  }
  const seqId = randomUUID();
  store.sequences.push({ id: seqId, status: "active", steps: STEPS });
  return { store, seqId };
}

export function addCompany(store: MemoryStore, over: Partial<Company> = {}): Company {
  const c: Company = { id: randomUUID(), name: "Acme Imports", domain: "acme.com", state: "NJ", status: "active", facts: {}, ...over };
  store.companies.push(c);
  return c;
}

export function addContact(store: MemoryStore, company: Company | null, over: Partial<Contact> = {}): Contact {
  const c: Contact = {
    id: randomUUID(),
    company_id: company?.id ?? null,
    email: `jane${store.contacts.length}@${company?.domain ?? "example.com"}`,
    first_name: "JANE",
    last_name: "DOE",
    title: "Logistics Manager",
    timezone: null,
    fields: { commodity: "furniture", port: "Savannah" },
    verification_status: "valid",
    verified_at: "2026-10-10T00:00:00Z",
    ...over,
  };
  store.contacts.push(c);
  return c;
}

export async function enroll(store: MemoryStore, seqId: string, contact: Contact, inboxIndex = 0, at = "2026-10-13T00:00:00Z") {
  await store.createEnrollments([
    { sequence_id: seqId, contact_id: contact.id, inbox_id: store.inboxes[inboxIndex].id, subject_variant: "a", next_send_at: at },
  ]);
  return store.enrollments[store.enrollments.length - 1];
}

/** Decodes the quoted-printable body of a raw message back to text. */
export function bodyOf(raw: string): string {
  const body = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  const joined = body.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && /^[0-9A-F]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(joined.charCodeAt(i));
  }
  return Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
}

export function header(raw: string, name: string): string | undefined {
  const head = raw.split("\r\n\r\n")[0];
  const line = head.split("\r\n").find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return line?.slice(name.length + 1).trim();
}
