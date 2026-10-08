import { describe, expect, it } from "vitest";
import { buildAlert } from "@/lib/engine/alerts";
import { MailerError } from "@/lib/engine/ports";
import { runTick } from "@/lib/engine/tick";
import { addCompany, addContact, bodyOf, enroll, FakeMailer, header, makeDeps, seed } from "./helpers";

// Tuesday 13 October 2026, 10:00 in New York.
const TUE_10AM_ET = new Date("2026-10-13T14:00:00Z");
const APP = "https://crm.example.com";

async function sentOnce(alert_email = "owner@example.com") {
  const { store, seqId } = seed({ inboxes: 2, settings: { alert_email } });
  const mailer = new FakeMailer();
  const deps = makeDeps(mailer, { now: TUE_10AM_ET });
  const jane = addContact(store, addCompany(store), { email: "jane@acme.com" });
  await enroll(store, seqId, jane);
  await runTick(store, deps, APP);
  const first = mailer.sent[0];
  mailer.sent = [];
  return { store, deps, mailer, first };
}

const reply = (threadId: string) => ({
  id: `in-${Math.random()}`,
  threadId,
  from: "Jane Doe <jane@acme.com>",
  subject: "Re: furniture into Savannah",
  snippet: "Sure, send me a rate for Savannah to Atlanta.",
  headers: {},
  internalDate: TUE_10AM_ET,
});

describe("alerts", () => {
  it("emails the owner once about a new reply, without unsubscribe headers", async () => {
    const { store, deps, mailer, first } = await sentOnce();
    const threadId = store.enrollments[0].gmail_thread_id!;
    mailer.inbound[first.inbox] = [reply(threadId)];

    const out = await runTick(store, deps, APP);
    expect(out.alert.sent).toBe(true);
    const alert = mailer.sent.find((m) => header(m.raw, "To") === "owner@example.com")!;
    expect(header(alert.raw, "Subject")).toBe("[Outreach CRM] Reply from jane@acme.com");
    expect(header(alert.raw, "List-Unsubscribe")).toBeUndefined();
    expect(bodyOf(alert.raw)).toContain("send me a rate for Savannah");

    // The same message seen again on the next pass is not alerted twice.
    mailer.sent = [];
    const again = await runTick(store, deps, APP);
    expect(again.alert.sent).toBe(false);
    expect(mailer.sent.filter((m) => header(m.raw, "To") === "owner@example.com")).toHaveLength(0);
  });

  it("alerts when an inbox loses its connection, sending from another inbox", async () => {
    const { store, deps, mailer } = await sentOnce();
    const broken = store.inboxes[0];
    const realList = mailer.listInbound.bind(mailer);
    mailer.listInbound = async (inbox) => {
      if (inbox.id === broken.id) throw new MailerError("auth", "invalid_grant");
      return realList(inbox);
    };

    const out = await runTick(store, deps, APP);
    expect(broken.status).toBe("disconnected");
    expect(out.alert).toMatchObject({ sent: true, from: store.inboxes[1].email });
    const alert = mailer.sent.find((m) => header(m.raw, "To") === "owner@example.com")!;
    expect(header(alert.raw, "Subject")).toBe(`[Outreach CRM] ${broken.email} is disconnected`);
    expect(bodyOf(alert.raw)).toContain(`${APP}/inboxes`);

    // Still disconnected on the next pass: no repeat alert.
    expect((await runTick(store, deps, APP)).alert.sent).toBe(false);
  });

  it("sends nothing when no alert address is set", async () => {
    const { store, deps, mailer, first } = await sentOnce("");
    mailer.inbound[first.inbox] = [reply(store.enrollments[0].gmail_thread_id!)];
    expect((await runTick(store, deps, APP)).alert.sent).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it("summarises several replies and problems in one email", () => {
    const r = { inbox: "a@x.com", from: "p@q.com", subject: "Re: hi", snippet: "yes" };
    const a = buildAlert([r, { ...r, from: "z@q.com" }], [{ inbox: "a@x.com", status: "paused", reason: "Bounce rate too high" }], APP)!;
    expect(a.subject).toBe("[Outreach CRM] 2 new replies, a@x.com is paused");
    expect(a.body).toContain("2 prospects replied");
    expect(a.body).toContain("a@x.com is paused. Bounce rate too high");
    expect(buildAlert([], [], APP)).toBeNull();
  });
});
