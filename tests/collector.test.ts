import { describe, expect, it } from "vitest";
import { COLLECTOR_SOURCE, collectorBookmarklet } from "../src/lib/importinfo/collector";
import { parseLeadsCsv } from "../src/lib/csv-import";

type Row = { raw: string; last?: string; records?: string };
type Lead = Record<string, string>;
interface Api {
  clean(raw: string, hint: string | null): { email: string; repaired: boolean } | null;
  guessName(email: string): [string, string];
  titleCase(s: string): string;
  factsFromTables(tables: { head: string[]; rows: string[][] }[], address: string): Record<string, string>;
  collectFromRows(company: string, rows: Row[], url?: string, facts?: Record<string, string>): { leads: Lead[]; skipped: { raw: string; reason: string }[] };
  toCsv(leads: Lead[]): string;
  merge(list: Lead[], leads: Lead[]): number;
}

function api(): Api {
  const win: { __OUTREACH_COLLECTOR_TEST__: { api?: Api } } = { __OUTREACH_COLLECTOR_TEST__: {} };
  new Function("window", COLLECTOR_SOURCE)(win);
  return win.__OUTREACH_COLLECTOR_TEST__.api!;
}

// The Expeditors page Shubham showed, as ImportInfo prints it.
const EXPEDITORS: Row[] = [
  { raw: "LAX-NISSAN-OPS EXPEDITORS.COM", last: "2026-10-03", records: "904" },
  { raw: "DOLGEN-SEAEXPEDITORS.COM", last: "2026-10-03", records: "514" },
  { raw: "TJX-BOS EXPEDITORS.COM", last: "2026-10-03", records: "299" },
  { raw: "GIOVANNI.NAVAS@EXPEDITORS.COM", last: "2026-10-03", records: "158" },
  { raw: "JOSE.VALLEJO@EXPEDITORS.COM", last: "2026-10-03", records: "156" },
  { raw: "JCASTRO@MGAE.COM", last: "2026-10-03", records: "106" },
  { raw: "HOBBYLOBBY-CHB@EXPEDITORS.COM", last: "2026-10-03", records: "97" },
  { raw: "NIKE.CHB@ EXPEDITORS.COM", last: "2026-10-03", records: "77" },
  { raw: "MDL-ORD@EXPEDITORS.COM", last: "2026-10-03", records: "24" },
  { raw: "IMPORT HYH-CARGO.COM", last: "2026-10-03", records: "1" },
];

describe("ImportInfo collector", () => {
  it("repairs the broken forms ImportInfo prints and keeps the rest", () => {
    const { leads, skipped } = api().collectFromRows("Expeditors International", EXPEDITORS, "https://www.importinfo.com/expeditors-international");
    expect(skipped).toEqual([]);
    expect(leads.map((l) => l.email)).toEqual([
      "lax-nissan-ops@expeditors.com",
      "dolgen-sea@expeditors.com",
      "tjx-bos@expeditors.com",
      "giovanni.navas@expeditors.com",
      "jose.vallejo@expeditors.com",
      "jcastro@mgae.com",
      "hobbylobby-chb@expeditors.com",
      "nike.chb@expeditors.com",
      "mdl-ord@expeditors.com",
      "import@hyh-cargo.com",
    ]);
    expect(leads.filter((l) => l.email_repaired === "yes").map((l) => l.email)).toEqual([
      "lax-nissan-ops@expeditors.com", "dolgen-sea@expeditors.com", "tjx-bos@expeditors.com", "import@hyh-cargo.com",
    ]);
  });

  it("names the page's company only for its own domain, and guesses names only from first.last", () => {
    const { leads } = api().collectFromRows("Expeditors International", EXPEDITORS);
    const by = Object.fromEntries(leads.map((l) => [l.email, l]));
    expect(by["giovanni.navas@expeditors.com"]).toMatchObject({ first_name: "Giovanni", last_name: "Navas", company: "Expeditors International", website: "expeditors.com", email_records: "158" });
    expect(by["jcastro@mgae.com"]).toMatchObject({ first_name: "", company: "", website: "mgae.com" });
    expect(by["nike.chb@expeditors.com"]).toMatchObject({ first_name: "", last_name: "" });
  });

  it("skips what cannot be repaired and no-reply addresses", () => {
    const { leads, skipped } = api().collectFromRows("Acme", [{ raw: "N/A" }, { raw: "noreply@acme.com" }, { raw: "ann.lee@acme.com" }]);
    expect(leads.map((l) => l.email)).toEqual(["ann.lee@acme.com"]);
    expect(skipped.map((s) => s.reason)).toEqual(["broken address", "no-reply address"]);
  });

  it("merges without duplicates across pages", () => {
    const a = api();
    const list = a.collectFromRows("Acme", [{ raw: "ann.lee@acme.com" }]).leads;
    expect(a.merge(list, a.collectFromRows("Acme", [{ raw: "ANN.LEE@acme.com" }, { raw: "bo.kim@acme.com" }]).leads)).toBe(1);
    expect(list).toHaveLength(2);
  });

  it("writes a CSV the Leads import reads as is", () => {
    const a = api();
    const csv = a.toCsv(a.collectFromRows("Expeditors International, Inc.", EXPEDITORS).leads);
    const { rows, rejected } = parseLeadsCsv(csv);
    expect(rejected).toEqual([]);
    expect(rows).toHaveLength(10);
    const giovanni = rows.find((r) => r.email === "giovanni.navas@expeditors.com")!;
    expect(giovanni).toMatchObject({ first_name: "Giovanni", company: "Expeditors International, Inc.", company_domain: "expeditors.com" });
    expect(giovanni.fields).toMatchObject({ email_records: "158", email_last_seen: "2026-10-03" });
    expect(rows.find((r) => r.email === "jcastro@mgae.com")).toMatchObject({ company: "mgae.com", company_domain: "mgae.com" });
  });

  it("reads shipment facts from the page's tables, as ImportInfo lays them out", () => {
    const a = api();
    const facts = a.factsFromTables(
      [
        { head: ["total records", "10,320,181"], rows: [["Shipper Records", "507,855"], ["Most Recent Shipment on File", "Oct 2nd, 2026"], ["Records in Last 30 Days", "12,088"], ["Records in Last 90 Days", "32,490"], ["Records in the Past Year", "143,036"]] },
        { head: ["run date", "master bol", "house bol", "us port"], rows: [["2026-10-05", "MEDUAAX23496", "", "LONG BEACH, CALIFORNIA"]] },
        { head: ["port of lading", "port of unlading", "total records", "recent shipment"], rows: [["Vung Tau Vietnam (55206)", "Los Angeles, California (2704)", "383,723", "2026-10-03"], ["Yantian China (Mainland) (57078)", "Savannah, Georgia (1703)", "324,309", "2026-10-02"]] },
        { head: ["port of unlading", "total records", "recent shipment"], rows: [["Los Angeles, California", "2,540,084", "2026-10-03"]] },
        { head: ["company name", "address", "last record", "records"], rows: [["EXPEDITORS INTERNATIONAL", "795 JUBILEE DRIVE PEABODY, MA 01960", "2025-12-05", "14,021"]] },
        { head: ["phone number", "last appeared", "records"], rows: [["(310) 343-6200", "2026-10-03", "364,592"]] },
      ],
      "849 THOMAS DRIVE BENSENVILLE, IL 60106 USA",
    );
    expect(facts).toEqual({
      state: "IL", shipments_30d: "12,088", shipments_90d: "32,490", shipments_year: "143,036", last_shipment: "Oct 2nd, 2026",
      top_route_from: "Vung Tau Vietnam", top_route_to: "Los Angeles, California", top_us_port: "Los Angeles, California", company_phone: "(310) 343-6200",
    });
    const csv = a.toCsv(a.collectFromRows("Expeditors International", [{ raw: "ann.lee@expeditors.com" }], "", facts).leads);
    const row = parseLeadsCsv(csv).rows[0];
    expect(row.state).toBe("IL");
    expect(row.timezone).toBe("America/Chicago");
    expect(row.fields).toMatchObject({ top_us_port: "Los Angeles, California", top_route_from: "Vung Tau Vietnam", shipments_90d: "32,490" });
  });

  it("builds a bookmark URL that is safe inside an href", () => {
    const url = collectorBookmarklet();
    expect(url.startsWith("javascript:")).toBe(true);
    expect(url).not.toMatch(/["<>\s]/);
    expect(decodeURIComponent(url.slice("javascript:".length))).toBe(COLLECTOR_SOURCE);
  });
});
