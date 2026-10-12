// A bookmarklet for importinfo.com, which has no export. On a company page it
// reads the "email addresses" table, repairs the common broken forms
// ("ops expeditors.com", "nike.chb@ expeditors.com"), keeps a running list in
// that site's localStorage, and downloads the list as a CSV for the Leads page.
// On a page that lists companies instead, it offers to visit each one in turn,
// slowly and with a daily cap, and collect them all the same way.
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

  function text(el) { return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : ""; }

  var NAV_WORDS = /^(login|log-in|logout|signin|sign-in|signup|sign-up|register|subscribe|subscription|pricing|plans|account|settings|contact|contact-us|about|about-us|privacy|terms|help|faq|blog|news|search|home|dashboard|profile|cart|checkout)$/i;
  var NOT_A_NAME = /^(next|prev|previous|more|first|last|show more|view|view all|details|\d+|[«»‹›<>]+)$/i;

  /* The company links on a list page: same-site links outside the header, menu and footer, grouped by
     URL shape ("/acme-inc" and "/zeta-co" share one); the biggest group of 3+ is the list. */
  function companyLinks(doc, pageUrl) {
    var here = new URL(pageUrl), groups = {}, seen = {}, best = [];
    Array.prototype.forEach.call(doc.querySelectorAll("a[href]"), function (a) {
      if (a.closest && a.closest("nav, header, footer")) return;
      var u;
      try { u = new URL(a.getAttribute("href"), here.href); } catch (e) { return; }
      if (u.host !== here.host || !/^https?:$/.test(u.protocol)) return;
      var parts = u.pathname.split("/").filter(Boolean);
      var last = parts[parts.length - 1] || "";
      if (!/[a-z]/i.test(last) || /\.(pdf|png|jpe?g|gif|svg|css|js|xml|csv|xlsx?)$/i.test(last) || NAV_WORDS.test(last)) return;
      var name = text(a);
      if (!name || name.length > 120 || NOT_A_NAME.test(name)) return;
      u.hash = "";
      if (u.href === here.href.split("#")[0] || seen[u.href]) return;
      seen[u.href] = true;
      var shape = parts.length + ":" + parts.slice(0, -1).join("/") + (u.search ? "?" : "");
      (groups[shape] = groups[shape] || []).push({ url: u.href, name: name });
    });
    Object.keys(groups).forEach(function (k) { if (groups[k].length > best.length) best = groups[k]; });
    return best.length >= 3 ? best : [];
  }

  function hasEmailTable(tables) {
    return tables.some(function (t) { return t.head.some(function (h) { return h.indexOf("email") !== -1; }); });
  }

  var api = { factsFromTables: factsFromTables, stateFromAddress: stateFromAddress, clean: clean, guessName: guessName, titleCase: titleCase, dominantDomain: dominantDomain, collectFromRows: collectFromRows, toCsv: toCsv, merge: merge, companyLinks: companyLinks, hasEmailTable: hasEmailTable };
  if (typeof window !== "undefined" && window.__OUTREACH_COLLECTOR_TEST__) { window.__OUTREACH_COLLECTOR_TEST__.api = api; return; }

  /* The company's name heading: the one matching "<NAME> EMAIL ADDRESSES" when there is one, else the page's h1. */
  function companyHeading(doc) {
    var hs = Array.prototype.slice.call(doc.querySelectorAll("h1, h2, h3, h4, h5")), name = "";
    hs.forEach(function (h) { var m = text(h).match(/^(.+?)\s+email addresses$/i); if (m && !name) name = m[1].toUpperCase(); });
    var exact = hs.filter(function (h) { return name && text(h).toUpperCase() === name; })[0];
    if (exact) return { name: titleCase(name), el: exact };
    if (name) return { name: titleCase(name), el: null };
    var h1 = doc.querySelector("h1");
    if (h1 && text(h1) && text(h1).length < 120) return { name: titleCase(text(h1)), el: h1 };
    return { name: titleCase(String(doc.title || "").split(/[|–—]/)[0]), el: null };
  }

  function pageTables(doc) {
    return Array.prototype.filter.call(doc.querySelectorAll("table"), function (t) { return t.rows.length; }).map(function (t) {
      var cells = function (row) { return Array.prototype.map.call(row.cells, function (c) { return text(c); }); };
      var all = Array.prototype.map.call(t.rows, cells);
      return { head: all[0].map(function (h) { return h.toLowerCase(); }), rows: all.slice(1) };
    });
  }

  function pageAddress(heading) {
    var el = heading && heading.nextElementSibling;
    return el && text(el).length < 200 ? text(el) : "";
  }

  function pageRows(doc, tables) {
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
    if (!rows.length && doc.body) {
      var found = String(doc.body.innerText || doc.body.textContent || "").match(/[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+/gi) || [];
      found.forEach(function (e) { if (!/@importinfo\.com$/i.test(e)) rows.push({ raw: e, last: "", records: "" }); });
    }
    return rows;
  }

  function collectDoc(doc, url) {
    var heading = companyHeading(doc);
    var tables = pageTables(doc);
    var facts = factsFromTables(tables, pageAddress(heading.el));
    return { company: heading.name, facts: facts, hasTable: hasEmailTable(tables), result: collectFromRows(heading.name, pageRows(doc, tables), url, facts) };
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

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  var BTN = "padding:7px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#111;font:13px system-ui,sans-serif;cursor:pointer";
  var BTN_MAIN = "flex:1;padding:7px;border:0;border-radius:6px;background:#111;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer";

  /* buttons: [[action, label, main?]]; onAction(action) handles anything other than dl, clear and close. */
  function panel(lines, buttons, onAction) {
    var old = document.getElementById("outreach-crm-panel");
    if (old) old.remove();
    var box = document.createElement("div");
    box.id = "outreach-crm-panel";
    box.setAttribute("style", "position:fixed;top:16px;right:16px;z-index:2147483647;width:340px;background:#fff;color:#111;border:1px solid #ccc;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);padding:14px 16px;font:14px/1.45 system-ui,sans-serif");
    box.innerHTML = lines.map(function (l) { return "<div style='margin-bottom:6px'>" + l + "</div>"; }).join("") +
      "<div style='display:flex;gap:8px;margin-top:10px;flex-wrap:wrap'>" +
      buttons.map(function (b) { return "<button data-a='" + b[0] + "' style='" + (b[2] ? BTN_MAIN : BTN) + "'>" + b[1] + "</button>"; }).join("") + "</div>";
    box.addEventListener("click", function (e) {
      var a = e.target && e.target.getAttribute && e.target.getAttribute("data-a");
      if (!a) return;
      if (a === "dl") download(load());
      else if (a === "clear") { if (confirm("Clear the " + load().length + " saved emails? Download them first if you have not.")) { save([]); box.remove(); } }
      else if (a === "close") box.remove();
      else if (onAction) onAction(a);
    });
    document.body.appendChild(box);
    return box;
  }

  var LIST_BUTTONS = [["dl", "Download CSV", true], ["clear", "Clear list"], ["close", "Close"]];

  function showSingle(got) {
    var list = load();
    var added = merge(list, got.result.leads);
    var stored = save(list);
    var r = got.result, f = got.facts, lines = [];
    lines.push("<strong>" + esc(got.company) + "</strong>" + (f.state ? " (" + f.state + ")" : ""));
    if (f.shipments_90d || f.top_us_port) lines.push("<span style='color:#555'>" + esc([f.shipments_90d ? f.shipments_90d + " shipments in 90 days" : "", f.top_us_port].filter(Boolean).join(" · ")) + "</span>");
    lines.push(added + " new email" + (added === 1 ? "" : "s") + " added" + (r.leads.length > added ? " (" + (r.leads.length - added) + " already in your list)" : "") + ".");
    if (r.skipped.length) lines.push("Skipped " + r.skipped.length + ": " + esc(r.skipped.map(function (s) { return s.reason; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", ")) + ".");
    lines.push("Your list: <strong>" + list.length + "</strong> email" + (list.length === 1 ? "" : "s") + ".");
    if (!stored) lines.push("<span style='color:#b00'>This browser would not save the list. Download it now.</span>");
    panel(lines, LIST_BUTTONS);
  }

  /* Auto-collect: visits each company on a list page, slowly, in this logged-in tab. The pace and the
     daily cap keep the account's traffic close to a person clicking through. */
  var DAY_KEY = "outreachCrmAutoDay", SEEN_KEY = "outreachCrmAutoSeen";
  var DAILY_CAP = 150, MIN_WAIT = 20, MAX_WAIT = 40;

  function today() { return new Date().toISOString().slice(0, 10); }
  function usedToday() { try { var d = JSON.parse(localStorage.getItem(DAY_KEY) || "{}"); return d.date === today() ? d.count || 0 : 0; } catch (e) { return 0; } }
  function countToday() { try { localStorage.setItem(DAY_KEY, JSON.stringify({ date: today(), count: usedToday() + 1 })); } catch (e) {} }
  function seenPages() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch (e) { return {}; } }
  function markSeen(url) { var s = seenPages(); s[url] = today(); try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch (e) {} }

  /* Reads the page as plain HTML first; if the email table is drawn by the page's scripts, opens it in a hidden frame. */
  function fetchCompany(url, done) {
    fetch(url, { credentials: "same-origin" }).then(function (res) {
      if (res.status === 429 || res.status === 403) throw { stop: "ImportInfo answered " + res.status + " (too many requests or blocked)." };
      if (!res.ok) throw { skip: "page error " + res.status };
      return res.text();
    }).then(function (html) {
      var got = collectDoc(new DOMParser().parseFromString(html, "text/html"), url);
      if (got.hasTable) done(null, got); else frameCompany(url, done);
    }).catch(function (err) { done(err && (err.stop || err.skip) ? err : { skip: "could not load" }); });
  }

  function frameCompany(url, done) {
    var f = document.createElement("iframe"), tries = 0;
    f.setAttribute("style", "position:fixed;left:-10000px;top:0;width:1200px;height:900px;visibility:hidden");
    f.src = url;
    document.body.appendChild(f);
    var timer = setInterval(function () {
      tries++;
      var doc = null;
      try { doc = f.contentDocument; } catch (e) {}
      var got = doc && doc.body && doc.readyState !== "loading" ? collectDoc(doc, url) : null;
      if ((got && got.hasTable) || tries >= 20) {
        clearInterval(timer);
        f.remove();
        if (got && got.hasTable) done(null, got); else done({ skip: "no email table" });
      }
    }, 1000);
  }

  function autoCollect(links) {
    var seen = seenPages();
    var todo = links.filter(function (l) { return !seen[l.url]; });
    var already = links.length - todo.length;
    var room = Math.max(0, DAILY_CAP - usedToday());
    var lines = ["<strong>Found " + links.length + " companies on this page.</strong>"];
    lines.push("<span style='color:#555'>For example: " + esc(links.slice(0, 3).map(function (l) { return l.name; }).join(", ")) + "</span>");
    if (already) lines.push(already + " were collected before and will be skipped.");
    if (!todo.length) { lines.push("Nothing new here. Go to the next page of results and click the bookmark again."); panel(lines, LIST_BUTTONS); return; }
    if (!room) { lines.push("<span style='color:#b00'>You reached today's limit of " + DAILY_CAP + " companies. This protects your ImportInfo account. Try again tomorrow.</span>"); panel(lines, LIST_BUTTONS); return; }
    todo = todo.slice(0, room);
    lines.push("It will open " + todo.length + " of them one by one, " + MIN_WAIT + " to " + MAX_WAIT + " seconds apart (about " + Math.ceil(todo.length * (MIN_WAIT + MAX_WAIT) / 2 / 60) + " minutes). Keep this tab open; you can use other tabs meanwhile.");
    panel(lines, [["start", "Start collecting", true], ["close", "Close"]], function (a) { if (a === "start") run(todo); });
  }

  function run(todo) {
    var i = 0, emails = 0, companies = 0, skipped = 0, failsInRow = 0, stopped = false, timer = null, wait = 0;
    window.__outreachCrmAuto = { stop: function () { finish("Stopped."); } };
    function finish(why) {
      stopped = true;
      clearTimeout(timer);
      window.__outreachCrmAuto = null;
      var lines = ["<strong>" + esc(why) + "</strong>", "Visited " + companies + " compan" + (companies === 1 ? "y" : "ies") + ", added <strong>" + emails + "</strong> new emails" + (skipped ? " (" + skipped + " pages had no emails)" : "") + ".", "Your list: <strong>" + load().length + "</strong> emails. Today: " + usedToday() + " of " + DAILY_CAP + " companies."];
      if (i >= todo.length && usedToday() < DAILY_CAP) lines.push("For more, go to the next page of results and click the bookmark again.");
      lines.push("When you are done, click Download CSV and import the file on the CRM Leads page.");
      panel(lines, LIST_BUTTONS);
    }
    var box = null;
    function progress(note) {
      if (stopped) return;
      if (!box || !box.parentNode) box = panel(["<span data-s='1'></span>"], [["stop", "Stop", true], ["dl", "Download CSV"]], function (a) { if (a === "stop") finish("Stopped."); });
      box.querySelector("[data-s]").innerHTML = "<strong>Collecting " + Math.min(i + 1, todo.length) + " of " + todo.length + "</strong><br>" + esc(note) + "<br>" + emails + " new emails so far. Your list: " + load().length + ".";
    }
    function tick() {
      if (stopped) return;
      if (i >= todo.length) return finish("Done.");
      if (usedToday() >= DAILY_CAP) return finish("Reached today's limit of " + DAILY_CAP + " companies.");
      var l = todo[i];
      progress("Reading " + l.name + "...");
      fetchCompany(l.url, function (err, got) {
        if (stopped) return;
        countToday();
        companies++;
        if (err && err.stop) return finish(err.stop + " Stopped to protect your account. Wait a few hours before trying again.");
        if (err) {
          skipped++;
          failsInRow++;
          if (failsInRow >= 3) return finish("3 companies in a row showed no emails. Are you still logged in to ImportInfo? Stopped.");
        } else {
          failsInRow = got.result.leads.length ? 0 : failsInRow + 1;
          markSeen(l.url);
          var list = load();
          emails += merge(list, got.result.leads);
          if (!save(list)) return finish("This browser would not save the list. Download it now.");
          if (failsInRow >= 3) return finish("3 companies in a row showed no emails. Are you still logged in to ImportInfo? Stopped.");
        }
        i++;
        if (i >= todo.length) return finish("Done.");
        wait = MIN_WAIT + Math.floor(Math.random() * (MAX_WAIT - MIN_WAIT + 1));
        countdown(err ? "Skipped " + l.name + " (" + err.skip + ")." : l.name + ": " + got.result.leads.length + " emails.");
      });
    }
    function countdown(note) {
      if (stopped) return;
      if (wait <= 0) return tick();
      progress(note + " Next in " + wait + "s.");
      wait--;
      timer = setTimeout(function () { countdown(note); }, 1000);
    }
    tick();
  }

  if (window.__outreachCrmAuto) {
    panel(["<strong>Already collecting in this tab.</strong>"], [["stop", "Stop", true], ["close", "Close"]], function (a) { if (a === "stop" && window.__outreachCrmAuto) window.__outreachCrmAuto.stop(); });
    return;
  }

  var here = collectDoc(document, location.href.split("#")[0]);
  if (here.hasTable) { showSingle(here); return; }
  var links = companyLinks(document, location.href);
  if (links.length) { autoCollect(links); return; }
  if (here.result.leads.length) { showSingle(here); return; }
  panel(["No email table or company list found on this page.", "Open a company page that lists email addresses, or a search results page that lists companies, and click the bookmark again."], LIST_BUTTONS);
})();`;

/** The bookmark URL. encodeURIComponent leaves no quotes or angle brackets, so it is safe in an href. */
export function collectorBookmarklet(): string {
  return "javascript:" + encodeURIComponent(COLLECTOR_SOURCE);
}
