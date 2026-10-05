import { describe, expect, it } from "vitest";
import { classifyInbound } from "@/lib/classify";
import { decrypt, encrypt, sign, unsign } from "@/lib/crypto";
import { companyNameKey, domainFromWebsite, precheck } from "@/lib/email-rules";
import { buildRawMessage, quotedPrintable } from "@/lib/mime";
import { render } from "@/lib/template";
import { addBusinessDays, isBusinessDay, localParts, nextWindowStart, parseYmd, usHolidays, ymdToString, zonedTimeToUtc } from "@/lib/time";
import { dailyCap, nextGapMinutes } from "@/lib/warmup";
import { parseLeadsCsv } from "@/lib/csv-import";
import { isValidSession, newSessionToken } from "@/lib/session";
import { bodyOf } from "./helpers";

describe("time", () => {
  it("converts New York wall-clock time across daylight saving", () => {
    expect(zonedTimeToUtc({ y: 2026, m: 7, d: 1 }, 9, 0, "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedTimeToUtc({ y: 2026, m: 12, d: 1 }, 9, 0, "America/New_York").toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(zonedTimeToUtc({ y: 2026, m: 11, d: 2 }, 9, 30, "America/Los_Angeles").toISOString()).toBe("2026-11-02T17:30:00.000Z");
  });

  it("knows US holidays and weekends", () => {
    const h = usHolidays(2026);
    for (const d of ["2026-01-01", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]) expect(h.has(d)).toBe(true);
    expect(isBusinessDay(parseYmd("2026-10-17"))).toBe(false); // Saturday
    expect(isBusinessDay(parseYmd("2026-10-13"))).toBe(true);
  });

  it("adds business days skipping weekends and holidays", () => {
    // Friday 9 Oct + 1 business day skips the weekend and Columbus Day.
    expect(ymdToString(addBusinessDays(parseYmd("2026-10-09"), 1))).toBe("2026-10-13");
    expect(ymdToString(addBusinessDays(parseYmd("2026-11-24"), 3))).toBe("2026-12-01"); // Thanksgiving Thursday and Friday skipped
  });

  it("finds the next sending window", () => {
    const w = { startHour: 9, endHour: 16 };
    const fridayEvening = new Date("2026-10-16T22:00:00Z");
    const next = localParts(nextWindowStart(fridayEvening, "America/New_York", w), "America/New_York");
    expect([next.d, next.hour]).toEqual([19, 9]);
  });
});

describe("warm-up", () => {
  const settings = { ramp_start_per_day: 10, ramp_step_per_business_day: 2 };
  const inbox = { status: "active" as const, cold_start_date: "2026-10-05", max_daily: 40 };
  it("ramps from 10 a day to the inbox ceiling", () => {
    expect(dailyCap(inbox, parseYmd("2026-10-02"), settings)).toBe(0);
    expect(dailyCap(inbox, parseYmd("2026-10-05"), settings)).toBe(10);
    expect(dailyCap(inbox, parseYmd("2026-10-06"), settings)).toBe(12);
    expect(dailyCap(inbox, parseYmd("2026-10-10"), settings)).toBe(0); // Saturday
    expect(dailyCap(inbox, parseYmd("2026-11-30"), settings)).toBe(40);
    expect(dailyCap({ ...inbox, status: "paused" }, parseYmd("2026-10-06"), settings)).toBe(0);
  });
  it("spreads gaps across the window", () => {
    const gap = nextGapMinutes(420, 40, () => 0.5);
    expect(gap).toBeGreaterThanOrEqual(4);
    expect(gap).toBeLessThanOrEqual(30);
  });
});

describe("email rules", () => {
  it("blocks bad syntax, role and disposable addresses", () => {
    expect(precheck("jane.doe@acme.com")).toEqual({ ok: true });
    expect(precheck("info@acme.com")).toEqual({ ok: false, reason: "role" });
    expect(precheck("jane@mailinator.com")).toEqual({ ok: false, reason: "disposable" });
    expect(precheck("jane@@acme")).toEqual({ ok: false, reason: "syntax" });
  });
  it("normalises domains and company names", () => {
    expect(domainFromWebsite("https://www.Acme-Imports.com/about")).toBe("acme-imports.com");
    expect(companyNameKey("ACME Imports, Inc.")).toBe(companyNameKey("Acme Imports Inc"));
  });
});

describe("templates", () => {
  it("fills fields, uses fallbacks and reports missing ones", () => {
    expect(render("Hi {{ First Name }}", { first_name: "Jane" })).toEqual({ text: "Hi Jane", missing: [] });
    expect(render("Hi {{first_name|there}}", {})).toEqual({ text: "Hi there", missing: [] });
    expect(render("{{port}} lane", {}).missing).toEqual(["port"]);
  });
});

describe("classification", () => {
  const base = { from: "jane@acme.com", subject: "Re: hello", snippet: "Sounds good", headers: {} };
  it("tells replies, auto-replies, bounces and opt-outs apart", () => {
    expect(classifyInbound(base).kind).toBe("reply");
    expect(classifyInbound({ ...base, subject: "Out of Office: hello" }).kind).toBe("auto_reply");
    expect(classifyInbound({ ...base, headers: { "auto-submitted": "auto-replied" } }).kind).toBe("auto_reply");
    expect(classifyInbound({ ...base, snippet: "Please unsubscribe me" }).kind).toBe("unsubscribe_reply");
    const bounce = classifyInbound({ ...base, from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", snippet: "Address not found" });
    expect(bounce).toMatchObject({ kind: "bounce", hardBounce: true });
    const delay = classifyInbound({ ...base, from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Delay)", snippet: "Message delayed, will retry" });
    expect(delay).toMatchObject({ kind: "bounce", hardBounce: false });
  });
});

describe("mime", () => {
  it("round-trips long and non-ASCII bodies through quoted-printable", () => {
    const text = "Café — " + "x".repeat(200) + "\nline two = ok ";
    const raw = buildRawMessage({ fromName: "Rahul", fromEmail: "r@a.com", to: "j@b.com", subject: "Hi", body: text, listUnsubscribeUrl: "https://u", listUnsubscribeMailto: "mailto:r@a.com" });
    expect(bodyOf(raw)).toBe(text);
    for (const line of quotedPrintable(text).split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
  });
});

describe("crypto", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  it("signs and encrypts", () => {
    expect(unsign("s", sign("s", "abc"))).toBe("abc");
    expect(unsign("s", sign("s", "abc") + "x")).toBeNull();
    expect(decrypt(key, encrypt(key, "refresh-token"))).toBe("refresh-token");
  });
});


describe("CSV import", () => {
  it("maps common column names, keeps extra columns as fields and rejects bad rows", () => {
    const csv = [
      "Contact Name,Work Email,Job Title,Consignee,Website,State,Commodity,Port",
      "Jane Doe,Jane.Doe@Acme.com,Logistics Manager,ACME IMPORTS INC,www.acme.com,TX,furniture,Houston",
      "Info Desk,info@acme.com,,ACME,,TX,,",
      "Dup,jane.doe@acme.com,,,,,,",
      "Bob,bob@gmail.com,,Bob's Rugs,,CA,rugs,Long Beach",
    ].join("\n");
    const { rows, rejected } = parseLeadsCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ email: "jane.doe@acme.com", first_name: "Jane", last_name: "Doe", company_domain: "acme.com", timezone: "America/Chicago", fields: { commodity: "furniture", port: "Houston" } });
    expect(rows[1].company_domain).toBeNull(); // gmail.com says nothing about the company
    expect(rejected.map((r) => r.reason)).toEqual(["shared mailbox (info@, sales@...)", "duplicate in this file"]);
  });
});


describe("session", () => {
  it("accepts fresh signed sessions only", () => {
    const t = newSessionToken("secret", 0);
    expect(isValidSession("secret", t, 1000)).toBe(true);
    expect(isValidSession("other", t, 1000)).toBe(false);
    expect(isValidSession("secret", t, 15 * 86_400_000)).toBe(false);
  });
});
