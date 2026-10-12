import { describe, expect, it } from "vitest";
import { decodeCfEmail, directorySites, extractEmails, pagesWorthReading, robotsAllows, robotsDisallows, siteName } from "../src/lib/finder/extract";

function cf(email: string, key = 0x5a): string {
  return key.toString(16).padStart(2, "0") + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
}

describe("website email finder", () => {
  it("finds plain, mailto, Cloudflare-protected and [at] emails at the company's own domain only", () => {
    const html = `
      <p>Call or email <a href="mailto:John.Smith@AcmeImports.com?subject=Hi">John Smith</a></p>
      <p>Sales: sales@acmeimports.com.</p>
      <a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${cf("ops@acmeimports.com")}">[email&#160;protected]</a>
      <span>imports [at] acmeimports [dot] com</span>
      <p>la&#64;us.acmeimports.com</p>
      <p>Site by hello@webdesigner.com, photo logo@2x.png, someone@gmail.com</p>
      <img src="x@acmeimports.com.png">
      <script>var a = "tracking@acmeimports.com";</script>`;
    const found = extractEmails(html, ["acmeimports.com"]);
    expect(found.map((f) => f.email).sort()).toEqual(
      ["imports@acmeimports.com", "john.smith@acmeimports.com", "la@us.acmeimports.com", "ops@acmeimports.com", "sales@acmeimports.com"],
    );
    expect(found.find((f) => f.email === "john.smith@acmeimports.com")).toMatchObject({ first_name: "John", last_name: "Smith" });
    expect(found.find((f) => f.email === "sales@acmeimports.com")).toMatchObject({ first_name: "", last_name: "" });
  });

  it("decodes Cloudflare email protection", () => {
    expect(decodeCfEmail(cf("a.b@c.com", 0x13))).toBe("a.b@c.com");
    expect(decodeCfEmail("zz")).toBe("");
  });

  it("picks contact, team and about pages on the same site", () => {
    const html = `
      <a href="/blog/news">Blog</a><a href="/about-us">About Us</a><a href="https://www.acme.com/contact">Contact</a>
      <a href="/our-team">Leadership</a><a href="https://facebook.com/acme">Facebook</a><a href="/careers/contact">Jobs</a>
      <a href="/brochure.pdf">Contact sheet</a><a href="/products">Products</a>`;
    expect(pagesWorthReading(html, "https://acme.com/", ["acme.com"])).toEqual([
      "https://www.acme.com/contact", "https://acme.com/our-team", "https://acme.com/about-us",
    ]);
  });

  it("names the site from og:site_name or the title", () => {
    expect(siteName(`<meta property="og:site_name" content="Acme &amp; Sons">`)).toBe("Acme & Sons");
    expect(siteName(`<title>Home | Blue River Foods</title>`)).toBe("Blue River Foods");
    expect(siteName(`<title>Seaborne International - Freight Forwarding</title>`)).toBe("Seaborne International");
  });

  it("reads company websites off a directory page and skips the directory's own and social links", () => {
    const html = `
      <h3><a href="/profile/9580.htm">Logical Solution Services, Inc</a></h3>
      Website: <a href="http://www.solutionservices.us" target="_blank">http://www.solutionservices.us</a>
      <a href="https://allisterlines.com">Allister Lines Inc</a>
      <a href="https://www.freightnet.com/directory/p2/cUS/s30.htm">Next</a>
      <a href="https://cdn.freightnet.com/x.css">css</a>
      <a href="https://www.facebook.com/freightnet">Facebook</a><a href="https://twitter.com/x">t</a>
      <a href="https://www.cbp.gov">CBP</a>`;
    expect(directorySites(html, "https://www.freightnet.com/directory/p1/cUS/s30.htm")).toEqual([
      { domain: "solutionservices.us", name: "" },
      { domain: "allisterlines.com", name: "Allister Lines Inc" },
    ]);
  });

  it("follows robots.txt rules for every crawler", () => {
    const rules = robotsDisallows("User-agent: Googlebot\nDisallow: /private\n\nUser-agent: *\nDisallow: /admin\nDisallow: /*?print=\n");
    expect(rules).toEqual(["/admin", "/*?print="]);
    expect(robotsAllows(rules, "/contact")).toBe(true);
    expect(robotsAllows(rules, "/admin/x")).toBe(false);
    expect(robotsAllows(rules, "/page?print=1")).toBe(false);
    expect(robotsAllows(robotsDisallows("User-agent: *\nDisallow: /"), "/")).toBe(false);
    expect(robotsAllows(robotsDisallows("User-agent: *\nDisallow:"), "/")).toBe(true);
  });
});

describe("directory profile pages", () => {
  it("reads page URLs and child sitemaps from a sitemap", async () => {
    const { sitemapLocs } = await import("../src/lib/finder/extract");
    expect(sitemapLocs(`<urlset><url><loc>https://x.com/exhibitors/a/</loc><lastmod>2026</lastmod></url><url><loc> https://x.com/exhibitors/b/ </loc></url></urlset>`))
      .toEqual({ pages: ["https://x.com/exhibitors/a/", "https://x.com/exhibitors/b/"], sitemaps: [] });
    expect(sitemapLocs(`<sitemapindex><sitemap><loc>https://x.com/exhibitor-sitemap.xml</loc></sitemap></sitemapindex>`).sitemaps)
      .toEqual(["https://x.com/exhibitor-sitemap.xml"]);
  });

  it("finds profile links on a listing page", async () => {
    const { detailLinks } = await import("../src/lib/finder/extract");
    const html = `<a href="/exhibitors/">All</a><a href="/exhibitors/merci/">& Merci</a><a href="https://www.x.com/exhibitors/merci/#top">More</a><a href="/about">About</a><a href="https://y.com/exhibitors/z">Other</a>`;
    expect(detailLinks(html, "https://s1.x.com/search/", "/exhibitors/")).toEqual(["https://s1.x.com/exhibitors/merci/"]);
  });

  it("takes the website shown as an address on a profile page and ignores partner and social links", async () => {
    const { profileWebsite } = await import("../src/lib/finder/extract");
    const html = `<h1>Designers Fountain</h1>
      <a href="https://www.lasvegasmarket.com">Las Vegas Market</a>
      <a href="https://facebook.com/dmc">http://facebook.com/dmc</a>
      <p>Website: <a href="http://www.designersftn.com/">http://www.designersftn.com/</a></p>`;
    expect(profileWebsite(html, "https://www.dallasmarketcenter.com/exhibitors/designers-fountain/")).toEqual({ domain: "designersftn.com", name: "Designers Fountain" });
    expect(profileWebsite(`<a href="https://partner.com">Partner</a>`, "https://www.dallasmarketcenter.com/exhibitors/x/")).toBeNull();
  });
});
