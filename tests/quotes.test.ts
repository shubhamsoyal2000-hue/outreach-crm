import { describe, expect, it } from "vitest";
import { runSyncPass } from "@/lib/engine/sync";
import { runSendPass } from "@/lib/engine/send";
import { addCompany, addContact, enroll, FakeMailer, makeDeps, seed } from "./helpers";

const TUE_10AM_ET = new Date("2026-10-13T14:00:00Z");

async function sentToTwo() {
  const { store, seqId } = seed();
  const mailer = new FakeMailer();
  const clock = { now: TUE_10AM_ET };
  const deps = makeDeps(mailer, clock);
  const company = addCompany(store);
  const jane = addContact(store, company, { email: "jane@acme.com" });
  const e = await enroll(store, seqId, jane);
  await runSendPass(store, deps);
  return { store, deps, mailer, clock, company, jane, inbox: store.inboxes[0], threadId: e.gmail_thread_id! };
}

const msg = (threadId: string, over: Record<string, unknown> = {}) => ({
  id: `in-${Math.random()}`,
  threadId,
  from: "Jane Doe <jane@acme.com>",
  subject: "Re: furniture into Savannah",
  snippet: "Send me a rate for Savannah to Atlanta, 40' container.",
  headers: {},
  internalDate: TUE_10AM_ET,
  ...over,
});

describe("quotes", () => {
  it("opens a quote on the first reply and adds later replies from the company to it", async () => {
    const { store, deps, mailer, clock, company, jane, inbox, threadId } = await sentToTwo();
    mailer.inbound[inbox.email] = [msg(threadId)];
    await runSyncPass(store, deps);
    expect(store.quotes).toHaveLength(1);
    expect(store.quotes[0]).toMatchObject({ company_id: company.id, contact_id: jane.id, inbox_id: inbox.id, status: "new", reply_count: 1, from_email: "jane@acme.com" });

    // A colleague answers an hour later: same open quote, newest snippet.
    clock.now = new Date(TUE_10AM_ET.getTime() + 3_600_000);
    mailer.inbound[inbox.email] = [msg(threadId, { from: "bob@acme.com", snippet: "Also need Charleston.", internalDate: clock.now })];
    await runSyncPass(store, deps);
    expect(store.quotes).toHaveLength(1);
    expect(store.quotes[0]).toMatchObject({ reply_count: 2, last_reply_snippet: "Also need Charleston." });
  });

  it("starts a new quote after the last one was won or lost", async () => {
    const { store, deps, mailer, inbox, threadId } = await sentToTwo();
    mailer.inbound[inbox.email] = [msg(threadId)];
    await runSyncPass(store, deps);
    store.quotes[0].status = "won";
    mailer.inbound[inbox.email] = [msg(threadId, { snippet: "Another load next week?" })];
    await runSyncPass(store, deps);
    expect(store.quotes.map((q) => q.status)).toEqual(["won", "new"]);
  });

  it("does not open quotes for opt-outs, out-of-office or bounces", async () => {
    const { store, deps, mailer, inbox, threadId } = await sentToTwo();
    mailer.inbound[inbox.email] = [
      msg(threadId, { snippet: "Please remove me from your list", subject: "Re: unsubscribe" }),
      msg(threadId, { subject: "Automatic reply: out of office", headers: { "auto-submitted": "auto-replied" } }),
    ];
    await runSyncPass(store, deps);
    expect(store.quotes).toHaveLength(0);
  });
});
