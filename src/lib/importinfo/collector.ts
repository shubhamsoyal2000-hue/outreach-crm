// A bookmarklet for importinfo.com, which has no export. On a company page it
// reads the "email addresses" table, repairs the common broken forms
// ("ops expeditors.com", "nike.chb@ expeditors.com"), keeps a running list in
// that site's localStorage, and downloads the list as a CSV for the Leads page.
//
// The source is a plain string so the bundler never rewrites it. Keep it free
// of backticks, "${" and line comments: it runs as a javascript: URL.

export const COLLECTOR_SOURCE = String.raw`(function () {
  var KEY = "outreachCrmLeads";
  var FREEMAIL = ["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net"];
  var NO_REPLY = /^(no-?reply|do-?not-?reply|postmaster|mailer-daemon|abuse)$/;
  var DEPT_WORDS = ["ops", "chb", "import", "imports", "export", "exports", "sea", "air", "ocean", "ord", "order", "orders", "customs", "broker", "brokerage", "logistics", "team", "desk", "dept", "group", "admin", "info", "sales", "support", "mgr", "acct", "cs", "docs", "doc", "edi", "usa", "us"];
  var VALID = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

  function titleCase(s) {
    return s.toLowerCase().replace(/\s+/g, " ").trim().replace(/(^|[\s(&\/-])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
  }

  function basic(raw) {
    return String(raw || "").trim().toLowerCase().replace(/^mailto:/, "").replace(/\s+/g, " ").replace(/\s*@\s*/, "@");
  }

  function dominantDomain(rows) {
    var counts = {}, best = null;
    rows.forEach(function (r) {
      var s = basic(r.raw);
      if (!VALID.test(s)) return;
      var d = s.split("@")[1];
      if (FREEMAIL.indexOf(d) !== -1) return;
      counts[d] = (counts[d] || 0) + (Number(r.records) || 1);
      if (!best || counts[d] > counts[best]) best = d;
    });
    return best;
  }

  function clean(raw, hint) {
    var s = basic(raw), repaired = false;
    if (s.indexOf("@") === -1) {
      var m = s.match(/^([a-z0-9._%+'-]+) ([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/);
      if (m) { s = m[1] + "@" + m[2]; repaired = true; }
      else if (hint && s.indexOf(" ") === -1 && s.length > hint.length + 1 && s.slice(-hint.length) === hint) {
        var local = s.slice(0, -hint.length).replace(/[._-]+$/, "");
        if (!local) return null;
        s = local + "@" + hint; repaired = true;
      } else return null;
    }
    if (!VALID.test(s)) return null;
    return { email: s, repaired: repaired };
  }

  function guessName(email) {
    var m = email.split("@")[0].match(/^([a-z]{2,15})[._]([a-z]{2,15})$/);
    if (!m || DEPT_WORDS.indexOf(m[1]) !== -1 || DEPT_WORDS.indexOf(m[2]) !== -1) return ["", ""];
    return [titleCase(m[1]), titleCase(m[2])];
  }

  var FACTS = ["state", "shipments_30d", "shipments_90d", "shipments_year", "last_shipment", "top_us_port", "top_route_from", "top_route_to", "company_phone"];

  function collectFromRows(company, rows, pageUrl, facts) {
    facts = facts || {};
    var hint = dominantDomain(rows), leads = [], skipped = [], seen = {};
    rows.forEach(function (r) {
      var c = clean(r.raw, hint);
      if (!c) { skipped.push({ raw: String(r.raw || "").trim(), reason: "broken address" }); return; }
      if (NO_REPLY.test(c.email.split("@")[0])) { skipped.push({ raw: c.email, reason: "no-reply address" }); return; }
      if (seen[c.email]) return;
      seen[c.email] = true;
      var domain = c.email.split("@")[1];
      var free = FREEMAIL.indexOf(domain) !== -1;
      var name = guessName(c.email);
      var lead = {
        email: c.email,
        first_name: name[0],
        last_name: name[1],
        company: free || !hint || domain === hint ? company : "",
        website: free ? "" : domain,
        email_records: String(r.records || "").trim(),
        email_last_seen: String(r.last || "").trim(),
        email_repaired: c.repaired ? "yes" : "",
        importinfo_page: pageUrl || ""
      };
      FACTS.forEach(function (k) { lead[k] = facts[k] || ""; });
      leads.push(lead);
    });
    var junk = cutOffCopies(leads.map(function (l) { return l.email; }));
    leads = leads.filter(function (l) {
      if (!junk[l.email]) return true;
      skipped.push({ raw: l.email, reason: "cut-off copy of " + junk[l.email] });
      return false;
    });
    return { leads: leads, skipped: skipped };
  }

  /* Bills of lading often clip or prefix an address: "mazon.cgd.doc@" next to "amazon.cgd.doc@",
     "08854.david@" next to "david@". Returns { badEmail: goodEmail } for those. */
  function cutOffCopies(emails) {
    var out = {};
    emails.forEach(function (a) {
      var la = a.split("@")[0], da = a.split("@")[1];
      emails.forEach(function (b) {
        if (a === b || out[a]) return;
        var lb = b.split("@")[0], db = b.split("@")[1];
        if (da !== db) return;
        var clipped = lb.length > la.length && lb.slice(-la.length) === la && /^[a-z0-9]{1,2}$/.test(lb.slice(0, lb.length - la.length));
        var prefixed = /^\d+[._-]/.test(la) && la.replace(/^\d+[._-]/, "") === lb;
        if (clipped || prefixed) out[a] = b;
      });
    });
    return out;
  }

  var COLUMNS = ["email", "first_name", "last_name", "company", "website"].concat(FACTS, ["email_records", "email_last_seen", "email_repaired", "importinfo_page"]);
  function toCsv(leads) {
    var esc = function (v) { v = String(v == null ? "" : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [COLUMNS.join(",")].concat(leads.map(function (l) { return COLUMNS.map(function (k) { return esc(l[k]); }).join(","); })).join("\r\n") + "\r\n";
  }

  function merge(list, leads) {
    var have = {}, added = 0;
    list.forEach(function (l) { have[l.email] = true; });
    leads.forEach(function (l) { if (!have[l.email]) { have[l.email] = true; list.push(l); added++; } });
    return added;
  }

  function place(s) { return String(s || "").replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim(); }

  function stateFromAddress(addr) {
    var m = String(addr || "").toUpperCase().match(/[\s,]([A-Z]{2})[\s,]+\d{5}(?:-\d{4})?\b/);
    return m ? m[1] : "";
  }

  /* tables: [{ head: [..lowercase], rows: [[cell text..]..] }] */
  function factsFromTables(tables, address) {
    var f = { state: stateFromAddress(address) };
    var LABELS = { "records in last 30 days": "shipments_30d", "records in last 90 days": "shipments_90d", "records in the past year": "shipments_year", "most recent shipment on file": "last_shipment" };
    tables.forEach(function (t) {
      var head = t.head.join(" | ");
      t.rows.concat([t.head]).forEach(function (cells) {
        var key = LABELS[String(cells[0] || "").toLowerCase().trim()];
        if (key && cells[1] && !f[key]) f[key] = String(cells[1]).trim();
      });
      var first = t.rows[0];
      if (!first) return;
      if (head.indexOf("port of lading") !== -1 && head.indexOf("port of unlading") !== -1 && !f.top_route_from) {
        f.top_route_from = place(first[t.head.indexOf("port of lading")]);
        f.top_route_to = place(first[t.head.indexOf("port of unlading")]);
      } else if (head.indexOf("port of unlading") !== -1 && head.indexOf("port of lading") === -1 && !f.top_us_port) {
        f.top_us_port = place(first[t.head.indexOf("port of unlading")]);
      } else if (head.indexOf("phone") !== -1 && !f.company_phone) {
        f.company_phone = String(first[0] || "").trim();
      } else if (t.head.indexOf("address") !== -1 && !f.state) {
        f.state = stateFromAddress(first[t.head.indexOf("address")]);
      }
    });
    if (!f.top_us_port && f.top_route_to) f.top_us_port = f.top_route_to;
    return f;
  }

  var api = { factsFromTables: factsFromTables, stateFromAddress: stateFromAddress, clean: clean, guessName: guessName, titleCase: titleCase, dominantDomain: dominantDomain, collectFromRows: collectFromRows, toCsv: toCsv, merge: merge };
  if (typeof window !== "undefined" && window.__OUTREACH_COLLECTOR_TEST__) { window.__OUTREACH_COLLECTOR_TEST__.api = api; return; }

  function text(el) { return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : ""; }

  /* The company's name heading: the one matching "<NAME> EMAIL ADDRESSES" when there is one, else the page's h1. */
  function companyHeading() {
    var hs = Array.prototype.slice.call(document.querySelectorAll("h1, h2, h3, h4, h5")), name = "";
    hs.forEach(function (h) { var m = text(h).match(/^(.+?)\s+email addresses$/i); if (m && !name) name = m[1].toUpperCase(); });
    var exact = hs.filter(function (h) { return name && text(h).toUpperCase() === name; })[0];
    if (exact) return { name: titleCase(name), el: exact };
    if (name) return { name: titleCase(name), el: null };
    var h1 = document.querySelector("h1");
    if (h1 && text(h1) && text(h1).length < 120) return { name: titleCase(text(h1)), el: h1 };
    return { name: titleCase(String(document.title || "").split(/[|\u2013\u2014]/)[0]), el: null };
  }

  function pageTables() {
    return Array.prototype.filter.call(document.querySelectorAll("table"), function (t) { return t.rows.length; }).map(function (t) {
      var cells = function (row) { return Array.prototype.map.call(row.cells, function (c) { return text(c); }); };
      var all = Array.prototype.map.call(t.rows, cells);
      return { head: all[0].map(function (h) { return h.toLowerCase(); }), rows: all.slice(1) };
    });
  }

  function pageAddress(heading) {
    var el = heading && heading.nextElementSibling;
    return el && text(el).length < 200 ? text(el) : "";
  }

  function pageRows(tables) {
    var rows = [];
    tables.forEach(function (t) {
      var head = t.head;
      var iEmail = -1, iLast = -1, iRec = -1;
      head.forEach(function (h, i) {
        if (iEmail === -1 && h.indexOf("email") !== -1) iEmail = i;
        if (iLast === -1 && h.indexOf("last") !== -1) iLast = i;
        if (iRec === -1 && h.indexOf("record") !== -1) iRec = i;
      });
      if (iEmail === -1) return;
      t.rows.forEach(function (cells) {
        if (!cells[iEmail]) return;
        rows.push({ raw: cells[iEmail], last: iLast !== -1 ? cells[iLast] || "" : "", records: iRec !== -1 ? cells[iRec] || "" : "" });
      });
    });
    if (!rows.length) {
      var found = String(document.body.innerText || "").match(/[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+/gi) || [];
      found.forEach(function (e) { rows.push({ raw: e, last: "", records: "" }); });
    }
    return rows;
  }

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
  function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) { return false; } }

  function download(list) {
    var blob = new Blob([toCsv(list)], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "importinfo-leads-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  var heading = companyHeading();
  var company = heading.name;
  var tables = pageTables();
  var facts = factsFromTables(tables, pageAddress(heading.el));
  var result = collectFromRows(company, pageRows(tables), location.href.split("#")[0], facts);
  var list = load();
  var added = merge(list, result.leads);
  var stored = save(list);

  var old = document.getElementById("outreach-crm-panel");
  if (old) old.remove();
  var box = document.createElement("div");
  box.id = "outreach-crm-panel";
  box.setAttribute("style", "position:fixed;top:16px;right:16px;z-index:2147483647;width:320px;background:#fff;color:#111;border:1px solid #ccc;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);padding:14px 16px;font:14px/1.45 system-ui,sans-serif");
  var lines = [];
  lines.push("<strong>" + company.replace(/</g, "&lt;") + "</strong>" + (facts.state ? " (" + facts.state + ")" : ""));
  if (facts.shipments_90d || facts.top_us_port) lines.push("<span style='color:#555'>" + [facts.shipments_90d ? facts.shipments_90d + " shipments in 90 days" : "", facts.top_us_port].filter(Boolean).join(" · ").replace(/</g, "&lt;") + "</span>");
  lines.push(added + " new email" + (added === 1 ? "" : "s") + " added" + (result.leads.length > added ? " (" + (result.leads.length - added) + " already in your list)" : "") + ".");
  if (result.skipped.length) lines.push("Skipped " + result.skipped.length + ": " + result.skipped.map(function (s) { return s.reason; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", ") + ".");
  if (!result.leads.length && !result.skipped.length) lines.push("No email table found on this page. Open a company page that lists email addresses.");
  lines.push("Your list: <strong>" + list.length + "</strong> email" + (list.length === 1 ? "" : "s") + ".");
  if (!stored) lines.push("<span style='color:#b00'>This browser would not save the list. Download it now.</span>");
  box.innerHTML = lines.map(function (l) { return "<div style='margin-bottom:6px'>" + l + "</div>"; }).join("") +
    "<div style='display:flex;gap:8px;margin-top:10px'>" +
    "<button data-a='dl' style='flex:1;padding:7px;border:0;border-radius:6px;background:#111;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer'>Download CSV</button>" +
    "<button data-a='clear' style='padding:7px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#111;font:13px system-ui,sans-serif;cursor:pointer'>Clear list</button>" +
    "<button data-a='close' style='padding:7px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#111;font:13px system-ui,sans-serif;cursor:pointer'>Close</button></div>";
  box.addEventListener("click", function (e) {
    var a = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
    if (a === "dl") download(load().length ? load() : list);
    if (a === "clear" && confirm("Clear the " + load().length + " saved emails? Download them first if you have not.")) { save([]); box.remove(); }
    if (a === "close") box.remove();
  });
  document.body.appendChild(box);
})();`;

/** The bookmark URL. encodeURIComponent leaves no quotes or angle brackets, so it is safe in an href. */
export function collectorBookmarklet(): string {
  return "javascript:" + encodeURIComponent(COLLECTOR_SOURCE);
}
