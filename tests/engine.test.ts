import { describe, expect, it } from "vitest";
import { runSendPass } from "@/lib/engine/send";
import { runSyncPass, syncInbox } from "@/lib/engine/sync";
import { enrollContacts } from "@/lib/engine/enroll";
import { runAutoEnroll } from "@/lib/engine/auto-enroll";
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
    expect(body).toContain('Just reply "no" and I won\'t email again.');
    expect(body).not.toContain("http"); // links in cold mail push it toward Spam

    // Follow-up waits 3 business days and lands inside the 9-16 window.
    expect(e.next_step).toBe(2);
    const next = new Date(e.next_send_at);
    const p = localParts(next, "America/New_York");
    expect(`${p.y}-${p.m}-${p.d}`).toBe("2026-10-16");
    expect(p.hour).toBeGreaterThanOrEqual(9);
    expect(p.hour).toBeLessThan(16);
    expect(e.thread_subject).toBe("furniture into Savannah");
  });

  it("replies to its own thread for follow-ups, reusing the earlier check", async () => {
    const { store, seqId, mailer, clock } = setup();
    const checked: string[] = [];
    const deps = makeDeps(mailer, clock, { verify: async (email) => (checked.push(email), { status: "valid", detail: "ok / ok" }) });
    const e = await enroll(store, seqId, addContact(store, addCompany(store)));
    await runSendPass(store, deps);
    expect(checked).toHaveLength(0); // already checked by the service
    clock.now = new Date(new Date(e.next_send_at).getTime() + 60_000);
    store.inboxes[0].next_send_after = null;
    const [out] = await runSendPass(store, deps);
    expect(out.result).toBe("sent");
    expect(checked).toHaveLength(0); // already checked by the service, so no credit is spent again
    const raw = mailer.sent[1].raw;
    expect(mailer.sent[1].threadId).toBe("thread-1");
    expect(header(raw, "Subject")).toBe("Re: furniture into Savannah");
    expect(header(raw, "In-Reply-To")).toBe("<msg-1@mail.gmail.com>");
  });

  it("spaces sends out instead of bursting", async () => {
    const { store, seqId, mailer, deps } = setup();
    for (let i = 0; i < 3; i++) await enroll(store, seqId, addContact(store, addCompany(store, { domain: `co${i}.com`, name: `Company ${i}` })));
    await runSendPass(store, deps);
    const second = await runSendPass(store, deps);
    expect(mailer.sent).toHaveLength(1);
    expect(second[0]).toMatchObject({ result: "skipped", reason: "spacing between sends" });
    expect(new Date(store.inboxes[0].next_send_after!).getTime() - TUE_10AM_ET.getTime()).toBeGreaterThanOrEqual(3 * 60_000);
  });

  it("reaches the daily cap when the scheduler ticks every 5 minutes", async () => {
    const { store, seqId, mailer, clock, deps } = setup({ settings: { ramp_start_per_day: 50, ramp_step_per_business_day: 0 } });
    store.inboxes[0].max_daily = 50;
    for (let i = 0; i < 60; i++) {
      await enroll(store, seqId, addContact(store, addCompany(store, { domain: `t${i}.com`, name: `Tick Co ${i}` })), 0, "2026-10-13T12:00:00Z");
    }
    // 9:00 to 16:00 New York, one tick every 5 minutes, each a couple of seconds late like the real scheduler.
    for (let t = 0; t < 84; t++) {
      clock.now = new Date(Date.parse("2026-10-13T13:00:02Z") + t * 5 * 60_000);
      await runSendPass(store, deps);
    }
    expect(mailer.sent).toHaveLength(50);
  });

  it("alternates follow-ups with first emails when both are waiting", async () => {
    const { store, seqId, mailer, deps } = setup();
    for (let i = 0; i < 6; i++) {
      await enroll(store, seqId, addContact(store, addCompany(store, { domain: `old${i}.com`, name: `Old Co ${i}` })), 0, "2026-10-01T12:00:00Z");
    }
    for (let i = 0; i < 3; i++) {
      const contact = addContact(store, addCompany(store, { domain: `fu${i}.com`, name: `Follow Co ${i}` }), { first_name: ["Ann", "Bo", "Cy"][i] });
      const e = await enroll(store, seqId, contact, 0, "2026-10-13T13:00:00Z");
      Object.assign(e, { next_step: 2, gmail_thread_id: `t${i}`, thread_subject: "furniture into Savannah", last_rfc_message_id: `<m${i}@x>` });
    }
    for (let i = 0; i < 4; i++) {
      store.inboxes[0].next_send_after = null;
      await runSendPass(store, deps);
    }
    const replies = mailer.sent.filter((m) => m.threadId !== null).length;
    expect(mailer.sent).toHaveLength(4);
    expect(replies).toBe(2);
  });

  it("stops at the warm-up cap for the day", async () => {
    const { store, seqId, mailer, deps } = setup();
    store.inboxes[0].cold_start_date = "2026-10-13"; // first day: cap 10
    for (let i = 0; i < 12; i++) await enroll(store, seqId, addContact(store, addCompany(store, { domain: `co${i}.com`, name: `Company ${i}` })));
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

  it("checks addresses marked good by Gmail history, not only unchecked ones", async () => {
    const { store, seqId, mailer, clock } = setup();
    const checked: string[] = [];
    const deps = makeDeps(mailer, clock, { verify: async (email) => (checked.push(email), { status: "valid", detail: "ok / ok" }) });
    const contact = addContact(store, addCompany(store), {
      verified_at: "2026-10-13T13:30:00Z",
      verification_detail: "delivered without a bounce on 2026-10-05 (Gmail history)",
    });
    await enroll(store, seqId, contact);
    await runSendPass(store, deps);
    expect(checked).toEqual([contact.email]);
    expect(mailer.sent).toHaveLength(1);
  });

  it("never re-checks an address already found bad", async () => {
    const { store, seqId, mailer, clock } = setup();
    const checked: string[] = [];
    const deps = makeDeps(mailer, clock, { verify: async (email) => (checked.push(email), { status: "valid", detail: "ok / ok" }) });
    const e = await enroll(store, seqId, addContact(store, addCompany(store), { verification_status: "invalid", verified_at: "2026-01-01T00:00:00Z", verification_detail: "hard bounce" }));
    await runSendPass(store, deps);
    expect(checked).toHaveLength(0);
    expect(e).toMatchObject({ status: "stopped", stop_reason: "verification_failed" });
  });

  it("verifies unchecked addresses before a follow-up too", async () => {
    const { store, seqId, mailer, clock } = setup();
    const deps = makeDeps(mailer, clock, { verify: async () => ({ status: "invalid", detail: "invalid / ok" }) });
    const contact = addContact(store, addCompany(store), { verification_status: "unverified", verified_at: null });
    const e = await enroll(store, seqId, contact);
    Object.assign(e, { next_step: 2, gmail_thread_id: "t1", thread_subject: "furniture into Savannah" });
    await runSendPass(store, deps);
    expect(mailer.sent).toHaveLength(0);
    expect(e).toMatchObject({ status: "stopped", stop_reason: "verification_failed" });
  });

  it("never sends the same wording twice", async () => {
    for (const [body, expectSent] of [["Hi {{first_name}}, one lane is all I need.", 1], ["[[Hi|Hello]] {{first_name}}, one lane is all I need.", 2]] as const) {
      const { store, seqId, mailer, clock } = setup({ inboxes: 2 });
      store.sequences[0].steps = [{ ...store.sequences[0].steps[0], body }];
      const deps = makeDeps(mailer, clock);
      for (let i = 0; i < 2; i++) {
        await enroll(store, seqId, addContact(store, addCompany(store, { domain: `d${i}.com` })), i);
        await runSendPass(store, deps);
      }
      expect(mailer.sent).toHaveLength(expectSent);
      if (expectSent === 2) expect(new Set(mailer.sent.map((m) => bodyOf(m.raw).split("\n")[0])).size).toBe(2);
    }
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
      await enroll(store, seqId, addContact(store, addCompany(store, { domain: `c${i}.com`, name: `Company ${i}` }), { verification_status: "catch_all" }));
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

  it("only counts bounces after the inbox was resumed", async () => {
    const { store, deps, mailer, seqId } = setup();
    const inbox = store.inboxes[0];
    for (let i = 0; i < 30; i++) {
      const c = addContact(store, null, { email: `x${i}@ex.com` });
      store.messages.push({ id: `s${i}`, inbox_id: inbox.id, enrollment_id: null, contact_id: c.id, direction: "outbound", kind: "sent", send_day: "2026-10-08", gmail_message_id: `s${i}`, gmail_thread_id: null, occurred_at: "2026-10-08T15:00:00.000Z" });
      if (i < 2) store.messages.push({ id: `b${i}`, inbox_id: inbox.id, enrollment_id: null, contact_id: c.id, direction: "inbound", kind: "bounce", gmail_message_id: `b${i}`, gmail_thread_id: null, occurred_at: "2026-10-08T15:01:00.000Z" });
    }
    inbox.bounce_reset_at = "2026-10-09T00:00:00.000Z";
    await enroll(store, seqId, addContact(store, addCompany(store)));
    const [out] = await runSendPass(store, deps);
    expect(out.result).toBe("sent");
    expect(mailer.sent).toHaveLength(1);
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

  it("the old click-here opt-out line becomes the reply-no line", async () => {
    const { composeEmail } = await import("@/lib/compose");
    const ctx = setup();
    const company = addCompany(ctx.store);
    const contact = addContact(ctx.store, company, { email: "jane@acme.com" });
    const settings = { company_name: "Cargo Solution", postal_address: "1 Main St", opt_out_line: "Not the right person or not interested? Click here and I won't email again:" };
    const inbox = { email: "a@b.com", sender_name: "Marcus", signature: "" };
    const out = composeEmail({ settings, inbox, contact, company, enrollment: { subject_variant: "a", thread_subject: null, gmail_thread_id: null }, step: { step_number: 1, delay_business_days: 0, subject_a: "hi", subject_b: null, body: "Hello" }, unsubscribeUrl: "https://x/u" } as Parameters<typeof composeEmail>[0]);
    expect(out.ok && out.body).toContain('Just reply "no"');
    expect(out.ok && out.body).not.toContain("Click here");
  });

  it("a Spam-folder lookback handles a missed reply without moving the sync point", async () => {
    const { store, deps, mailer, eJane } = await sentOnce();
    const inbox = (await store.listInboxes())[0];
    await store.updateInbox(inbox.id, { last_synced_at: "2026-10-20T15:00:00.000Z" });
    mailer.inbound[inbox.email] = [inbound({})];
    const since = new Date("2026-10-05T00:00:00Z");
    const out = await syncInbox(store, deps, await store.getSettings(), (await store.listInboxes())[0], { since, spamOnly: true });
    expect(out.replies).toBe(1);
    expect(eJane.status).toBe("stopped");
    expect(mailer.listed.at(-1)).toMatchObject({ since, spamOnly: true });
    expect((await store.listInboxes())[0].last_synced_at).toBe("2026-10-20T15:00:00.000Z");
    // Running it again records nothing new.
    expect((await syncInbox(store, deps, await store.getSettings(), (await store.listInboxes())[0], { since, spamOnly: true })).replies).toBe(0);
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

  it("a recipient-side refusal stops the contact without counting as a bounce", async () => {
    const { store, deps, mailer, jane, eJane } = await sentOnce();
    mailer.inbound["sender0@getabccargo.com"] = [
      inbound({ from: "postmaster@acme.com", subject: "Undeliverable: hello", snippet: "Delivery has failed to these recipients or groups: jane@acme.com Delivery not authorized, message refused", headers: { "x-failed-recipients": "jane@acme.com" } }),
    ];
    const [out] = await runSyncPass(store, deps);
    expect(out.bounces).toBe(0);
    expect(eJane.stop_reason).toBe("bounced");
    expect(await store.isSuppressed(jane.email)).toBe(true);
    expect(store.messages.some((m) => m.kind === "bounce")).toBe(false);
  });

  it("Gmail refusing to send pauses the inbox and keeps the address", async () => {
    const { store, deps, mailer, jane, eJane } = await sentOnce();
    mailer.inbound["sender0@getabccargo.com"] = [
      inbound({
        from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        subject: "Delivery Status Notification (Failure)",
        snippet: "Message blocked Your message to jane@acme.com has been blocked. See technical details below for more information. LEARN MORE The response was: Message rejected. For more information, go to",
        headers: { "x-failed-recipients": "jane@acme.com" },
      }),
    ];
    const [out] = await runSyncPass(store, deps);
    expect(out.bounces).toBe(0);
    expect(await store.isSuppressed(jane.email)).toBe(false);
    expect(store.inboxes[0].status).toBe("paused");
    expect(eJane).toMatchObject({ status: "active", next_step: 1, gmail_thread_id: null });
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

  it("keeps a company on one inbox and can put a batch ahead of the queue", async () => {
    const { store, seqId } = setup({ inboxes: 2 });
    const co = addCompany(store, { domain: "same.com" });
    const ids = [addContact(store, co).id, addContact(store, co).id, addContact(store, co).id];
    await enrollContacts(store, seqId, store.candidates(seqId, ids), TUE_10AM_ET, { prioritize: true });
    expect(new Set(store.enrollments.map((e) => e.inbox_id)).size).toBe(1);
    for (const e of store.enrollments) expect(new Date(e.next_send_at).getTime()).toBeLessThan(TUE_10AM_ET.getTime() - 6 * 86_400_000);
  });
});

describe("email finder leads", () => {
  it("keeps real buyer inboxes at the company's own US-looking domain", async () => {
    const { isFinderLead, finderRank } = await import("@/lib/finder-leads");
    const lead = (email: string, source = "website_finder") => ({ email, source });
    expect(isFinderLead(lead("sales@acme.com"), "acme.com")).toBe(true);
    expect(isFinderLead(lead("jane@acme.com", "research"), "acme.com")).toBe(true);
    expect(isFinderLead(lead("sales@acme.com", "gmail_history"), "acme.com")).toBe(false);
    expect(isFinderLead(lead("press@acme.com"), "acme.com")).toBe(false);
    expect(isFinderLead(lead("careers@acme.com"), "acme.com")).toBe(false);
    expect(isFinderLead(lead("info@other.com"), "acme.com")).toBe(false);
    expect(isFinderLead(lead("info@acme.nl"), "acme.nl")).toBe(false);
    expect(finderRank("logistics@acme.com")).toBeLessThan(finderRank("jane@acme.com"));
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

describe("auto-enroll", () => {
  it("enrolls importers with an approved opening line who are in no sequence yet", async () => {
    const { store, seqId } = setup();
    store.sequences[0].auto_enroll = true;
    store.sequences.push({ id: "other-seq", status: "active", steps: [] });
    const researched = addCompany(store, { facts: { custom_line: "Saw your new Dallas DC." } });
    const fresh = addContact(store, researched);
    const elsewhere = addContact(store, researched);
    await store.createEnrollments([{ sequence_id: "other-seq", contact_id: elsewhere.id, inbox_id: store.inboxes[0].id, subject_variant: "a", next_send_at: TUE_10AM_ET.toISOString() }]);
    addContact(store, researched, { verification_status: "invalid" });
    addContact(store, addCompany(store, { domain: "plain.com" }));
    addContact(store, addCompany(store, { domain: "fwd.com", kind: "forwarder", facts: { custom_line: "x" } }));

    const out = await runAutoEnroll(store, TUE_10AM_ET);
    expect(out).toMatchObject({ sequence_id: seqId, enrolled: 1 });
    expect(store.enrollments.filter((e) => e.sequence_id === seqId).map((e) => e.contact_id)).toEqual([fresh.id]);

    expect(await runAutoEnroll(store, TUE_10AM_ET)).toMatchObject({ enrolled: 0 });
  });

  it("does nothing while the auto-enroll sequence is paused", async () => {
    const { store } = setup();
    store.sequences[0].auto_enroll = true;
    store.sequences[0].status = "paused";
    addContact(store, addCompany(store, { facts: { custom_line: "Saw your new Dallas DC." } }));
    expect(await runAutoEnroll(store, TUE_10AM_ET)).toEqual({ skipped: "no active auto-enroll sequence" });
    expect(store.enrollments).toHaveLength(0);
  });
});
