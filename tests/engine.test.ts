import { describe, expect, it } from "vitest";
import { runSendPass } from "@/lib/engine/send";
import { runSyncPass } from "@/lib/engine/sync";
import { enrollContacts } from "@/lib/engine/enroll";
import { MailerError } from "@/lib/engine/ports";
import { localParts } from "@/lib/time";
import { addCompany, addContact, bodyOf, enroll, FakeMailer, header, makeDeps, seed } from "./helpers";

// Tuesday 13 October 2026, 10:00 in New York.
const TUE_10AM_ET = new Date("2026-10-13T14:00:00Z");

function setup(opts?: Parameters<typeof seed>[0]) {
  const { store, seqId } = seed(opts);
  const mailer = new FakeMailer();
  const clock = { now: TUE_10AM_ET };
  const deps = makeDeps(mailer, clock);
  return { store, seqId, mailer, clock, deps };
}

describe("send pass", () => {
  it("sends nothing while sending is off or the postal address is missing", async () => {
    for (const settings of [{ sending_enabled: false }, { postal_address: "" }]) {
      const { store, seqId, mailer, deps } = setup({ settings });
      await enroll(store, seqId, addContact(store, addCompany(store)));
      const [out] = await runSendPass(store, deps);
      expect(out.result).toBe("skipped");
      expect(mailer.sent).toHaveLength(0);
    }
  });

  it("sends a compliant, personalised first email and schedules the follow-up", async () => {
    const { store, seqId, mailer, deps } = setup();
    const contact = addContact(store, addCompany(store));
    const e = await enroll(store, seqId, contact);

    const [out] = await runSendPass(store, deps);
    expect(out.result).toBe("sent");
    const raw = mailer.sent[0].raw;
    expect(header(raw, "Subject")).toBe("furniture into Savannah");
    expect(header(raw, "List-Unsubscribe")).toContain(`https://crm.example.com/unsubscribe?t=${contact.id}`);
    expect(header(raw, "List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
    const body = bodyOf(raw);
    expect(body).toContain("Hi Jane,"); // name tidied from JANE
    expect(body).toContain("Acme Imports bringing furniture into Savannah");
    expect(body).toContain("123 Main St, Suite 4, Newark, NJ 07102");
    expect(body).toContain("won't email again: https://crm.example.com/unsubscribe");

    // Follow-up waits 3 business days and lands inside the 9-16 window.
    expect(e.next_step).toBe(2);
    const next = new Date(e.next_send_at);
    const p = localParts(next, "America/New_York");
    expect(`${p.y}-${p.m}-${p.d}`).toBe("2026-10-16");
    expect(p.hour).toBeGreaterThanOrEqual(9);
    expect(p.hour).toBeLessThan(16);
    expect(e.thread_subject).toBe("furniture into Savannah");
  });

  it("replies to its own thread for follow-ups", async () => {
    const { store, seqId, mailer, deps, clock } = setup();
    const e = await enroll(store, seqId, addContact(store, addCompany(store)));
    await runSendPass(store, deps);
    clock.now = new Date(new Date(e.next_send_at).getTime() + 60_000);
    store.inboxes[0].next_send_after = null;
    const [out] = await runSendPass(store, deps);
    expect(out.result).toBe("sent");
    const raw = mailer.sent[1].raw;
    expect(mailer.sent[1].threadId).toBe("thread-1");
    expect(header(raw, "Subject")).toBe("Re: furniture into Savannah");
    expect(header(raw, "In-Reply-To")).toBe("<msg-1@mail.gmail.com>");
  });

  it("spaces sends out instead of bursting", async () => {
    const { store, seqId, mailer, deps } = setup();
    for (let i = 0; i < 3; i++) await enroll(store, seqId, addContact(store, addCompany(store, { domain: `co${i}.com` })));
    await runSendPass(store, deps);
    const second = await runSendPass(store, deps);
    expect(mailer.sent).toHaveLength(1);
    expect(second[0]).toMatchObject({ result: "skipped", reason: "spacing between sends" });
    expect(new Date(store.inboxes[0].next_send_after!).getTime() - TUE_10AM_ET.getTime()).toBeGreaterThanOrEqual(3 * 60_000);
  });

  it("stops at the warm-up cap for the day", async () => {
    const { store, seqId, mailer, deps } = setup();
    store.inboxes[0].cold_start_date = "2026-10-13"; // first day: cap 10
    for (let i = 0; i < 12; i++) await enroll(store, seqId, addContact(store, addCompany(store, { domain: `co${i}.com` })));
    for (let i = 0; i < 12; i++) {
      store.inboxes[0].next_send_after = null;
      await runSendPass(store, deps);
    }
    expect(mailer.sent).toHaveLength(10);
    store.inboxes[0].next_send_after = null;
    const [out] = await runSendPass(store, deps);
    expect(out).toMatchObject({ result: "skipped", reason: "daily cap of 10 reached" });
  });

  it("sends only one first email per company per day", async () => {
    const { store, seqId, mailer, deps } = setup();
    const company = addCompany(store);
    await enroll(store, seqId, addContact(store, company));
    const second = await enroll(store, seqId, addContact(store, company));
    await runSendPass(store, deps);
    store.inboxes[0].next_send_after = null;
    await runSendPass(store, deps);
    expect(mailer.sent).toHaveLength(1);
    expect(localParts(new Date(second.next_send_at), "America/New_York").d).toBe(14);
  });

  it("waits for the recipient's own business hours", async () => {
    const { store, seqId, mailer, deps } = setup();
    // 10:00 in New York is 07:00 in California.
    const e = await enroll(store, seqId, addContact(store, addCompany(store, { state: "CA", domain: "west.com" })));
    await runSendPass(store, deps);
    expect(mailer.sent).toHaveLength(0);
    expect(localParts(new Date(e.next_send_at), "America/Los_Angeles").hour).toBe(9);
  });

  it("never emails suppressed addresses or domains", async () => {
    const { store, seqId, mailer, deps } = setup();
    const e = await enroll(store, seqId, addContact(store, addCompany(store)));
    store.suppressions.push({ domain: "acme.com", reason: "manual" });
    await runSendPass(store, deps);
    expect(mailer.sent).toHaveLength(0);
    expect(e).toMatchObject({ status: "stopped", stop_reason: "suppressed" });
  });

  it("verifies stale addresses before the first email and blocks bad ones", async () => {
    const { store, seqId, mailer, clock } = setup();
    const verified: string[] = [];
    const deps = makeDeps(mailer, clock, {
      verify: async (email) => {
        verified.push(email);
        return { status: email.startsWith("bad") ? "invalid" : "valid", detail: null };
      },
    });
    const good = addContact(store, addCompany(store), { verification_status: "unverified", verified_at: null, email: "good@acme.com" });
    const bad = addContact(store, addCompany(store, { domain: "b.com" }), { verification_status: "valid", verified_at: "2026-01-01T00:00:00Z", email: "bad@b.com" });
    const eBad = await enroll(store, seqId, bad, 0, "2026-10-12T00:00:00Z");
    await enroll(store, seqId, good);
    await runSendPass(store, deps);
    expect(verified).toEqual(["bad@b.com", "good@acme.com"]);
    expect(eBad).toMatchObject({ status: "stopped", stop_reason: "verification_failed" });
    expect(mailer.sent).toHaveLength(1);
    expect(header(mailer.sent[0].raw, "To")).toBe("good@acme.com");
  });

  it("holds unverified contacts when no verification API is set up", async () => {
    const { store, seqId, mailer, deps } = setup();
    const e = await enroll(store, seqId, addContact(store, addCompany(store), { verification_status: "unverified", verified_at: null }));
    await runSendPass(store, deps);
    expect(mailer.sent).toHaveLength(0);
    expect(e.status).toBe("active");
  });

  it("caps catch-all addresses at a share of the day's sends", async () => {
    const { store, seqId, mailer, deps } = setup(); // cap 24 on this day, 10% -> 2 catch-alls
    for (let i = 0; i < 4; i++) {
      await enroll(store, seqId, addContact(store, addCompany(store, { domain: `c${i}.com` }), { verification_status: "catch_all" }));
    }
    for (let i = 0; i < 4; i++) {
      store.inboxes[0].next_send_after = null;
      await runSendPass(store, deps);
    }
    expect(mailer.sent).toHaveLength(2);
  });

  it("stops instead of sending an email with a blank field", async () => {
    const { store, seqId, mailer, deps } = setup();
    const e = await enroll(store, seqId, addContact(store, addCompany(store), { fields: { commodity: "toys" } }));
    await runSendPass(store, deps);
    expect(mailer.sent).toHaveLength(0);
    expect(e.stop_reason).toBe("missing_field:port");
  });

  it("pauses an inbox whose bounce rate is too high", async () => {
    const { store, deps, mailer, seqId } = setup();
    const inbox = store.inboxes[0];
    for (let i = 0; i < 30; i++) {
      const c = addContact(store, null, { email: `x${i}@ex.com` });
      store.messages.push({ id: `s${i}`, inbox_id: inbox.id, enrollment_id: null, contact_id: c.id, direction: "outbound", kind: "sent", send_day: "2026-10-09", gmail_message_id: `s${i}`, gmail_thread_id: null, occurred_at: "" });
      if (i < 2) store.messages.push({ id: `b${i}`, inbox_id: inbox.id, enrollment_id: null, contact_id: c.id, direction: "inbound", kind: "bounce", gmail_message_id: `b${i}`, gmail_thread_id: null, occurred_at: "" });
    }
    await enroll(store, seqId, addContact(store, addCompany(store)));
    const [out] = await runSendPass(store, deps);
    expect(out.result).toBe("paused");
    expect(store.inboxes[0].status).toBe("paused");
    expect(mailer.sent).toHaveLength(0);
  });

  it("marks the inbox disconnected when Gmail rejects its token", async () => {
    const { store, seqId, mailer, deps } = setup();
    await enroll(store, seqId, addContact(store, addCompany(store)));
    mailer.failWith = new MailerError("auth", "invalid_grant");
    const [out] = await runSendPass(store, deps);
    expect(out.result).toBe("paused");
    expect(store.inboxes[0].status).toBe("disconnected");
  });
});

describe("sync pass", () => {
  async function sentOnce() {
    const ctx = setup();
    const company = addCompany(ctx.store);
    const jane = addContact(ctx.store, company, { email: "jane@acme.com" });
    const bob = addContact(ctx.store, company, { email: "bob@acme.com" });
    const eJane = await enroll(ctx.store, ctx.seqId, jane);
    const eBob = await enroll(ctx.store, ctx.seqId, bob);
    await runSendPass(ctx.store, ctx.deps); // Jane gets the first email
    return { ...ctx, company, jane, bob, eJane, eBob };
  }

  const inbound = (over: Partial<import("@/lib/engine/ports").FetchedMessage>) => ({
    id: `in-${Math.random()}`,
    threadId: "thread-1",
    from: "Jane Doe <jane@acme.com>",
    subject: "Re: furniture into Savannah",
    snippet: "Sure, send me a rate for Savannah to Atlanta.",
    headers: {},
    internalDate: TUE_10AM_ET,
    ...over,
  });

  it("a reply stops the sequence for everyone at the company", async () => {
    const { store, deps, mailer, company, eJane, eBob } = await sentOnce();
    mailer.inbound["sender0@getabccargo.com"] = [inbound({})];
    const [out] = await runSyncPass(store, deps);
    expect(out.replies).toBe(1);
    expect(eJane).toMatchObject({ status: "stopped", stop_reason: "replied" });
    expect(eBob).toMatchObject({ status: "stopped", stop_reason: "company_replied" });
    expect(store.companies.find((c) => c.id === company.id)!.status).toBe("replied");
  });

  it("a colleague replying from another address also stops the company", async () => {
    const { store, deps, mailer, eBob } = await sentOnce();
    mailer.inbound["sender0@getabccargo.com"] = [inbound({ threadId: "other", from: "mike@acme.com", subject: "Re: hello" })];
    await runSyncPass(store, deps);
    expect(eBob.status).toBe("stopped");
  });

  it("a hard bounce suppresses the address", async () => {
    const { store, deps, mailer, jane, eJane } = await sentOnce();
    mailer.inbound["sender0@getabccargo.com"] = [
      inbound({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", snippet: "Address not found. Your message wasn't delivered to jane@acme.com", headers: { "x-failed-recipients": "jane@acme.com" } }),
    ];
    const [out] = await runSyncPass(store, deps);
    expect(out.bounces).toBe(1);
    expect(eJane.stop_reason).toBe("bounced");
    expect(await store.isSuppressed(jane.email)).toBe(true);
  });

  it("an out-of-office reply holds the sequence instead of stopping it", async () => {
    const { store, deps, mailer, eJane } = await sentOnce();
    const before = eJane.next_send_at;
    mailer.inbound["sender0@getabccargo.com"] = [inbound({ subject: "Automatic reply: furniture into Savannah", snippet: "I am out of the office until Monday.", headers: { "auto-submitted": "auto-replied" } })];
    const [out] = await runSyncPass(store, deps);
    expect(out.autoReplies).toBe(1);
    expect(eJane.status).toBe("active");
    expect(new Date(eJane.next_send_at) > new Date(before)).toBe(true);
  });

  it("a 'no longer monitored' auto-reply blocks that address and adds the colleagues it names", async () => {
    const { store, deps, mailer, jane, eJane, eBob, seqId } = await sentOnce();
    mailer.getText = async () =>
      "Good Morning/Afternoon:\nThis email address is no longer monitored.\nPurchasing Department: Purchasing@acme.com\nQuality Control: qualitycontrol@acme.com\nOur forwarder: ops@otherco.com\nnoreply@acme.com";
    mailer.inbound["sender0@getabccargo.com"] = [
      inbound({ subject: "Automatic reply: drayage and FTL for Acme", snippet: "Good Morning/Afternoon: This email address is no longer monitored. If your matter requires immediate assistance", headers: { "auto-submitted": "auto-replied" } }),
    ];
    const [out] = await runSyncPass(store, deps);
    expect(out).toMatchObject({ autoReplies: 1, notMonitored: 1, referred: 2, replies: 0 });
    expect(eJane).toMatchObject({ status: "stopped", stop_reason: "not_monitored" });
    expect(await store.isSuppressed(jane.email)).toBe(true);
    expect(eBob.status).toBe("active"); // the company is not stopped
    const added = store.contacts.filter((c) => c.fields.referred_by === jane.email).map((c) => c.email).sort();
    expect(added).toEqual(["purchasing@acme.com", "qualitycontrol@acme.com"]);
    const newEnrollments = store.enrollments.filter((e) => e.sequence_id === seqId && store.contacts.find((c) => c.id === e.contact_id)?.fields.referred_by);
    expect(newEnrollments).toHaveLength(2);
    expect(store.quotes).toHaveLength(0);
  });

  it("a 'no longer monitored' note without auto-reply headers is still not treated as a reply", async () => {
    const { store, deps, mailer, eBob } = await sentOnce();
    mailer.inbound["sender0@getabccargo.com"] = [inbound({ subject: "Undeliverable mailbox", snippet: "Jane Doe is no longer with the company. Please contact sales@acme.com." })];
    const [out] = await runSyncPass(store, deps);
    expect(out).toMatchObject({ replies: 0, notMonitored: 1, referred: 1 });
    expect(eBob.status).toBe("active");
  });

  it("an opt-out reply suppresses the address", async () => {
    const { store, deps, mailer, jane, eBob } = await sentOnce();
    mailer.inbound["sender0@getabccargo.com"] = [inbound({ snippet: "Please remove me from your list." })];
    const [out] = await runSyncPass(store, deps);
    expect(out.optOuts).toBe(1);
    expect(await store.isSuppressed(jane.email)).toBe(true);
    expect(eBob.status).toBe("stopped");
  });

  it("ignores mail that has nothing to do with outreach, like warm-up traffic", async () => {
    const { store, deps, mailer } = await sentOnce();
    mailer.inbound["sender0@getabccargo.com"] = [inbound({ threadId: "warm", from: "someone@warmup-network.com", subject: "Quick question about lunch" })];
    const [out] = await runSyncPass(store, deps);
    expect(out.replies).toBe(0);
    expect(store.messages.filter((m) => m.direction === "inbound")).toHaveLength(0);
  });

  it("does not process the same message twice", async () => {
    const { store, deps, mailer } = await sentOnce();
    mailer.inbound["sender0@getabccargo.com"] = [inbound({ id: "same" })];
    await runSyncPass(store, deps);
    const [out] = await runSyncPass(store, deps);
    expect(out.replies).toBe(0);
  });
});

describe("enrollment", () => {
  it("balances contacts across inboxes and skips blocked ones", async () => {
    const { store, seqId } = setup({ inboxes: 2 });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(addContact(store, addCompany(store, { domain: `e${i}.com` })).id);
    ids.push(addContact(store, null, { verification_status: "invalid", email: "x@nowhere.com" }).id);
    const replied = addCompany(store, { status: "replied", domain: "r.com" });
    ids.push(addContact(store, replied).id);
    const summary = await enrollContacts(store, seqId, store.candidates(seqId, ids), TUE_10AM_ET);
    expect(summary.enrolled).toBe(4);
    expect(summary.skipped).toEqual({ "failed verification": 1, "company replied or do-not-contact": 1 });
    const perInbox = store.enrollments.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.inbox_id]: (acc[e.inbox_id] ?? 0) + 1 }), {});
    expect(Object.values(perInbox)).toEqual([2, 2]);
    const again = await enrollContacts(store, seqId, store.candidates(seqId, ids.slice(0, 1)), TUE_10AM_ET);
    expect(again.skipped).toEqual({ "already in this sequence": 1 });
  });
});

describe("enrolling people we emailed by hand", () => {
  it("waits 5 days after the last manual email before the first sequence email", async () => {
    const { firstSendAt } = await import("@/lib/engine/enroll");
    const now = new Date("2026-10-08T14:00:00Z");
    expect(firstSendAt({ fields: {} }, now)).toEqual(now);
    expect(firstSendAt({ fields: { last_emailed: "2026-10-06" } }, now).toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(firstSendAt({ fields: { last_emailed: "2026-10-01" } }, now)).toEqual(now);
    expect(firstSendAt({ fields: { last_emailed: "2026-08-01" } }, now)).toEqual(now);
    expect(firstSendAt({ fields: { last_emailed: "not a date" } }, now)).toEqual(now);
  });
});
