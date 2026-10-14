// Shared rules used by both the browser and the server function.
// No AI here: matching, duplicate checks, the grounding check and the daily-list sort are plain rules.
(function (root) {
  const GENERIC_DOMAINS = new Set(["gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "atliq.com"]);
  const NAME_NOISE = /\b(llc|ltd|inc|group|labs|industries|solutions|technologies|pvt|private|limited|the)\b/g;

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/[*_`>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normCompany(name) {
    return norm(name).replace(/&/g, "and").replace(NAME_NOISE, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  }

  function domainOf(email) {
    const m = String(email || "").toLowerCase().match(/@([a-z0-9.-]+)$/);
    return m ? m[1] : "";
  }

  function emailsIn(text) {
    return Array.from(new Set((String(text).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [])));
  }

  // Grounding check: the quoted line must appear word for word in the source.
  function quoteIsInSource(quote, sourceText) {
    const q = norm(quote);
    if (q.length < 8) return false;
    return norm(sourceText).includes(q);
  }

  // Link an email or note to CRM records: lead ID first, then contact email, then email domain, then company name.
  function matchRecords(item, crm) {
    const text = item.text;
    const lower = norm(text);
    const ids = new Set(text.match(/L-\d{4}/g) || []);
    const emails = emailsIn(text);
    const domains = new Set(emails.map(domainOf).filter((d) => d && !GENERIC_DOMAINS.has(d)));
    const out = [];
    for (const r of crm) {
      let why = "";
      if (ids.has(r.lead_id)) why = "lead ID in the text";
      else if (r.contact_email && emails.includes(r.contact_email.toLowerCase())) why = "contact email";
      else if (r.contact_email && domains.has(domainOf(r.contact_email))) why = "same email domain";
      else {
        const nc = normCompany(r.company);
        const first = nc.split(" ")[0];
        if (nc.length >= 4 && lower.replace(/&/g, "and").replace(/[^a-z0-9 ]/g, "").includes(nc)) why = "company name";
        else if (first.length >= 6 && (item.id.toLowerCase().includes(first) || new RegExp("\\b" + first + "\\b").test(lower))) why = "company name";
      }
      if (why) out.push({ lead_id: r.lead_id, why });
    }
    return out;
  }

  // Likely duplicates: same normalised company name, or same non-generic email domain.
  function findDuplicates(crm) {
    const groups = new Map();
    const add = (key, r) => {
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r.lead_id);
    };
    for (const r of crm) {
      add("name:" + normCompany(r.company), r);
      const d = domainOf(r.contact_email);
      if (d && !GENERIC_DOMAINS.has(d)) add("domain:" + d, r);
    }
    const pairs = new Map();
    for (const [key, ids] of groups) {
      if (ids.length < 2) continue;
      const sorted = Array.from(new Set(ids)).sort();
      if (sorted.length < 2) continue;
      pairs.set(sorted.join("+"), { lead_ids: sorted, why: key.startsWith("name:") ? "same company name" : "same email domain" });
    }
    return Array.from(pairs.values());
  }

  function daysBetween(fromIso, toIso) {
    const a = Date.parse(fromIso + "T00:00:00Z");
    const b = Date.parse(toIso + "T00:00:00Z");
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  // Rule-based record checks (no AI).
  function recordIssues(record, crm, today) {
    const issues = [];
    if (!record.owner) issues.push("No owner");
    if (!record.status) issues.push("No status");
    const open = !["Won", "Lost"].includes(record.status);
    if (open && !record.next_followup_date) issues.push("No follow-up date");
    if (open && record.est_value_usd == null) issues.push("No deal value");
    if (!record.contact_email) issues.push("No contact email");
    if (open && record.last_contact_date) {
      const d = daysBetween(record.last_contact_date, today);
      if (d != null && d > 30) issues.push("No contact for " + d + " days");
    }
    return issues;
  }

  // Daily list order: overdue first, then nearest due date, then biggest deal, then longest wait. Items with no date go last.
  function sortNextSteps(steps, today) {
    const key = (s) => {
      const due = s.due_date ? daysBetween(today, s.due_date) : null;
      return { due, value: s.value || 0, waited: s.source_date ? daysBetween(s.source_date, today) || 0 : 0 };
    };
    return steps
      .map((s) => ({ s, k: key(s) }))
      .sort((a, b) => {
        const ad = a.k.due == null ? 99999 : a.k.due;
        const bd = b.k.due == null ? 99999 : b.k.due;
        if (ad !== bd) return ad - bd;
        if (a.k.value !== b.k.value) return b.k.value - a.k.value;
        return b.k.waited - a.k.waited;
      })
      .map((x) => Object.assign({}, x.s, { days_to_due: x.k.due, days_waiting: x.k.waited }));
  }

  root.AtliqCore = { norm, normCompany, domainOf, emailsIn, quoteIsInSource, matchRecords, findDuplicates, daysBetween, recordIssues, sortNextSteps };
})(typeof globalThis !== "undefined" ? globalThis : this);
