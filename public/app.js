// Browser app. All AI calls go through /api/analyze. Everything a person approves is kept in this browser (localStorage).
(function () {
  "use strict";
  const DATA = window.ATLIQ_DATA;
  const Core = window.AtliqCore;
  const TODAY = DATA.today;
  const KEY = "atliq-assistant-v1";
  const STATUSES = ["New", "Contacted", "Proposal Sent", "Won", "Lost"];
  const SOURCES = ["Referral", "LinkedIn", "Conference", "Website", "Cold Outreach"];
  const TYPE_LABEL = { new_lead: "New lead", crm_update: "CRM update", next_step: "Next step", opportunity: "Possible opportunity" };
  const KIND_LABEL = { new_work: "New work", referral: "Referral", renewal: "Renewal", revisit: "Come back later" };

  const view = document.getElementById("view");
  let tab = "today";
  let ai = { connected: false, model: "", note: "Checking AI…" };
  let run = { active: false, done: 0, total: 0, stop: false, note: "" };
  let ownerFilter = "All";
  const openSources = new Set();

  // ---------- state ----------
  function freshState() {
    return { analyses: {}, errors: {}, decisions: {}, crm: JSON.parse(JSON.stringify(DATA.crm)), steps: [], opps: [], log: [], changed: {} };
  }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.crm && s.analyses) return s;
    } catch (e) { /* storage unavailable or empty */ }
    return freshState();
  }
  let state = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable: keep working in memory */ }
  }

  // ---------- helpers ----------
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v) => (v == null || v === "" ? "value unknown" : "$" + Number(v).toLocaleString("en-US"));
  const item = (id) => DATA.items.find((i) => i.id === id);
  const record = (id) => state.crm.find((r) => r.lead_id === id);
  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00Z");
    return isNaN(d) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  };

  function allSuggestions() {
    const out = [];
    for (const id of Object.keys(state.analyses)) {
      (state.analyses[id].suggestions || []).forEach((s, i) => out.push({ sid: id + "#" + i, itemId: id, s }));
    }
    return out;
  }
  const pending = () => allSuggestions().filter((x) => !state.decisions[x.sid]);
  const flagged = () => allSuggestions().filter((x) => state.decisions[x.sid] === "review");
  const approvedFrom = (id) => Object.keys(state.decisions).some((k) => k.startsWith(id + "#") && state.decisions[k] === "approved");

  function logAction(text) {
    state.log.unshift({ at: new Date().toISOString(), text, before: state._snapshot });
    delete state._snapshot;
  }
  function snapshot() {
    state._snapshot = JSON.stringify({ decisions: state.decisions, crm: state.crm, steps: state.steps, opps: state.opps, changed: state.changed });
  }
  function markChanged(leadId, field) {
    state.changed[leadId] = state.changed[leadId] || {};
    state.changed[leadId][field] = true;
  }

  // ---------- AI calls ----------
  async function checkAi() {
    try {
      const r = await fetch("/api/status");
      if (!r.ok) throw new Error("status " + r.status);
      const j = await r.json();
      ai = { connected: !!j.aiConnected, model: j.model, note: j.aiConnected ? "AI connected · " + j.model : "AI not connected: " + (j.error ? "this is the local preview" : "add GROQ_API_KEY in Vercel") };
    } catch (e) {
      ai = { connected: false, model: "", note: "AI not connected: open the deployed site (this page is running without its server)" };
    }
    const el = document.getElementById("ai-status");
    el.textContent = ai.note;
    el.className = "chip " + (ai.connected ? "chip-green" : "chip-amber");
    render();
  }

  async function analyse(id) {
    delete state.errors[id];
    try {
      let r, j;
      // The free AI tier allows only a few requests a minute. When it says "slow down", wait and try again.
      for (let attempt = 0; attempt < 5; attempt++) {
        r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        j = await r.json().catch(() => ({ error: "The server returned an unreadable answer." }));
        if (r.status !== 429 || run.stop) break;
        const wait = j.retry_after || 20;
        run.note = "The AI service asked us to slow down. Waiting " + wait + " seconds…";
        render();
        await new Promise((done) => setTimeout(done, wait * 1000));
        run.note = "";
      }
      if (!r.ok) throw new Error(j.error || "Request failed (" + r.status + ")");
      // Second grounding check in the browser: never show a suggestion whose quote is not in the source.
      const src = item(id).text;
      j.suggestions = (j.suggestions || []).filter((s) => Core.quoteIsInSource(s.quote, src));
      // Re-analysing replaces the old suggestions, so earlier rejections on this item are cleared.
      // (Re-analyse is switched off once something from the item has been approved.)
      Object.keys(state.decisions).forEach((k) => { if (k.startsWith(id + "#")) delete state.decisions[k]; });
      state.analyses[id] = j;
    } catch (e) {
      state.errors[id] = e.message;
    }
    save();
  }

  async function analyseAll() {
    const todo = DATA.items.filter((i) => !state.analyses[i.id]);
    run = { active: true, done: 0, total: todo.length, stop: false };
    render();
    for (const it of todo) {
      if (run.stop) break;
      await analyse(it.id);
      run.done++;
      if (state.errors[it.id] && /not connected|API key|Rate limited/i.test(state.errors[it.id])) break;
      render();
    }
    run.active = false;
    render();
  }

  // ---------- approve / reject ----------
  function readEdits(card, s) {
    const out = Object.assign({}, s);
    card.querySelectorAll("[data-field]").forEach((el) => {
      const k = el.getAttribute("data-field");
      let v = el.value.trim();
      if (v === "") v = null;
      else if (k === "est_value_usd") v = isNaN(Number(v)) ? null : Number(v);
      out[k] = v;
    });
    return out;
  }

  function approve(sid, card) {
    const found = allSuggestions().find((x) => x.sid === sid);
    if (!found) return;
    const original = found.s;
    const s = readEdits(card, original);
    const it = item(found.itemId);
    const edited = JSON.stringify(s) !== JSON.stringify(original);
    if (s.type !== "new_lead" && !s.lead_id && s.type === "crm_update") {
      alert("Pick the CRM record this update belongs to before approving.");
      return;
    }
    snapshot();
    const rec = s.lead_id ? record(s.lead_id) : null;

    if (s.type === "new_lead") {
      const n = 1001 + state.crm.length;
      const id = "L-" + (state.crm.some((r) => r.lead_id === "L-" + n) ? n + 100 : n);
      state.crm.push({ lead_id: id, company: s.company, contact_name: s.contact_name || "", contact_email: s.contact_email || "", source: s.lead_source || "", service_interest: s.service_interest || "", status: s.status || "New", est_value_usd: s.est_value_usd, owner: s.owner || "", created_date: TODAY, last_contact_date: it.date, next_followup_date: "", notes: "Added from " + it.id + ": “" + s.quote + "”" });
      ["company", "contact_name", "contact_email", "source", "service_interest", "status", "est_value_usd", "owner"].forEach((f) => markChanged(id, f));
    } else if (s.type === "crm_update" && rec) {
      [["status", "status"], ["est_value_usd", "est_value_usd"], ["owner", "owner"], ["contact_name", "contact_name"], ["contact_email", "contact_email"], ["service_interest", "service_interest"]].forEach(([from, to]) => {
        if (s[from] != null && s[from] !== rec[to]) { rec[to] = s[from]; markChanged(rec.lead_id, to); }
      });
      if (!rec.last_contact_date || rec.last_contact_date < it.date) { rec.last_contact_date = it.date; markChanged(rec.lead_id, "last_contact_date"); }
    } else if (s.type === "next_step") {
      state.steps.push({ id: sid, lead_id: s.lead_id, company: s.company, next_step: s.next_step || s.title, due_date: s.due_date, due_text: s.due_text, owner: s.owner || (rec && rec.owner) || "", value: s.est_value_usd != null ? s.est_value_usd : rec ? rec.est_value_usd : null, promised_by: s.promised_by, quote: s.quote, source: it.id, source_date: it.date, done: false });
      if (rec && s.due_date && (!rec.next_followup_date || rec.next_followup_date > s.due_date)) { rec.next_followup_date = s.due_date; markChanged(rec.lead_id, "next_followup_date"); }
    } else if (s.type === "opportunity") {
      state.opps.push({ id: sid, lead_id: s.lead_id, company: s.company, kind: s.opportunity_kind, title: s.title, service_interest: s.service_interest, value: s.est_value_usd, owner: s.owner || (rec && rec.owner) || "", quote: s.quote, source: it.id, source_date: it.date });
    }
    state.decisions[sid] = "approved";
    logAction("Approved" + (edited ? " (after editing)" : "") + ": " + TYPE_LABEL[s.type] + " · " + s.company + " · " + s.title);
    save();
    render();
  }

  function reject(sid) {
    const found = allSuggestions().find((x) => x.sid === sid);
    if (!found) return;
    snapshot();
    state.decisions[sid] = "rejected";
    logAction("Rejected: " + TYPE_LABEL[found.s.type] + " · " + found.s.company + " · " + found.s.title);
    save();
    render();
  }

  // "Needs further review": park a suggestion without approving or rejecting it. Nothing changes in the CRM.
  function flagForReview(sid, on) {
    const found = allSuggestions().find((x) => x.sid === sid);
    if (!found) return;
    snapshot();
    if (on) state.decisions[sid] = "review";
    else delete state.decisions[sid];
    logAction((on ? "Marked as needing further review: " : "Moved back to the review queue: ") + TYPE_LABEL[found.s.type] + " · " + found.s.company + " · " + found.s.title);
    save();
    render();
  }

  function markDone(stepId) {
    const st = state.steps.find((x) => x.id === stepId);
    if (!st) return;
    snapshot();
    st.done = true;
    st.done_at = TODAY;
    logAction("Marked done: " + st.company + " · " + st.next_step);
    save();
    render();
  }

  function undoLast() {
    const last = state.log[0];
    if (!last || !last.before) return;
    const b = JSON.parse(last.before);
    state.decisions = b.decisions; state.crm = b.crm; state.steps = b.steps; state.opps = b.opps; state.changed = b.changed;
    state.log.shift();
    save();
    render();
  }

  // ---------- views ----------
  function sourceBlock(it, quote) {
    let html = esc(it.text);
    if (quote) {
      const q = esc(quote);
      const idx = html.indexOf(q);
      if (idx >= 0) html = html.slice(0, idx) + "<mark>" + q + "</mark>" + html.slice(idx + q.length);
    }
    return '<pre class="source">' + html + "</pre>";
  }

  function fieldInput(s, key, label, kind) {
    const v = s[key];
    if (kind === "status" || kind === "owner" || kind === "lead_source") {
      const opts = kind === "status" ? STATUSES : kind === "owner" ? DATA.team : SOURCES;
      return '<div><label>' + esc(label) + '</label><select data-field="' + key + '"><option value="">not stated</option>' + opts.map((o) => '<option' + (o === v ? " selected" : "") + ">" + esc(o) + "</option>").join("") + "</select></div>";
    }
    const type = kind === "date" ? "date" : kind === "number" ? "number" : "text";
    return '<div><label>' + esc(label) + '</label><input type="' + type + '" data-field="' + key + '" value="' + esc(v == null ? "" : v) + '" placeholder="not stated"></div>';
  }

  function suggestionCard(x) {
    const s = x.s;
    const it = item(x.itemId);
    const rec = s.lead_id ? record(s.lead_id) : null;
    const f = [];
    if (s.type === "new_lead") f.push(fieldInput(s, "company", "Company", "text"), fieldInput(s, "contact_name", "Contact", "text"), fieldInput(s, "contact_email", "Contact email", "text"), fieldInput(s, "lead_source", "Source", "lead_source"), fieldInput(s, "service_interest", "Service interest", "text"), fieldInput(s, "est_value_usd", "Deal value (USD)", "number"), fieldInput(s, "owner", "Owner", "owner"));
    if (s.type === "crm_update") f.push(fieldInput(s, "status", "Status", "status"), fieldInput(s, "est_value_usd", "Deal value (USD)", "number"), fieldInput(s, "owner", "Owner", "owner"), fieldInput(s, "contact_name", "Contact", "text"), fieldInput(s, "contact_email", "Contact email", "text"), fieldInput(s, "service_interest", "Service interest", "text"));
    if (s.type === "next_step") f.push(fieldInput(s, "next_step", "Next step", "text"), fieldInput(s, "due_date", "Due date" + (s.due_text ? " (source says: " + s.due_text + ")" : ""), "date"), fieldInput(s, "owner", "Owner" + (rec && rec.owner && !s.owner ? " (record owner: " + rec.owner + ")" : ""), "owner"));
    if (s.type === "opportunity") f.push(fieldInput(s, "service_interest", "Service interest", "text"), fieldInput(s, "est_value_usd", "Deal value (USD)", "number"), fieldInput(s, "owner", "Owner", "owner"));
    let pick = "";
    if (s.type !== "new_lead" && !rec) {
      pick = '<div><label>CRM record (none linked)</label><select data-field="lead_id"><option value="">no record</option>' + state.crm.map((r) => '<option value="' + r.lead_id + '">' + esc(r.lead_id + " · " + r.company) + "</option>").join("") + "</select></div>";
    }
    const isFlagged = state.decisions[x.sid] === "review";
    const conf = (s.confidence === "clear" ? '<span class="chip chip-green">Clear</span>' : '<span class="chip chip-amber">Please confirm</span>') + (isFlagged ? '<span class="chip chip-flag">Needs further review</span>' : "");
    const extra = [];
    if (s.promised_by) extra.push(s.promised_by === "atliq" ? "AtliQ promised this" : "The client set this deadline");
    if (s.opportunity_kind) extra.push(KIND_LABEL[s.opportunity_kind]);
    const compare = s.crm_says || s.source_says ? '<div class="compare"><div><b>CRM says</b>' + esc(s.crm_says || "not stated") + '</div><div><b>Source says</b>' + esc(s.source_says || "not stated") + "</div></div>" : "";
    const open = openSources.has(x.sid);
    return '<div class="card" data-sid="' + esc(x.sid) + '">' +
      '<div class="row spread"><div class="row"><span class="chip chip-blue">' + TYPE_LABEL[s.type] + "</span>" + conf + (extra.length ? '<span class="chip chip-grey">' + esc(extra.join(" · ")) + "</span>" : "") + '</div><span class="small muted">' + esc(s.company) + (rec ? " · " + esc(rec.lead_id) : s.type === "new_lead" ? " · not in the CRM" : "") + "</span></div>" +
      "<h3 style=\"margin-top:8px\">" + esc(s.title) + "</h3>" +
      (s.confidence !== "clear" && s.confidence_reason ? '<div class="small" style="color:var(--amber)">Check: ' + esc(s.confidence_reason) + "</div>" : "") +
      "<blockquote>“" + esc(s.quote) + '”</blockquote><div class="small muted">Source: ' + esc(it.title) + " · " + fmtDate(it.date) + ' · <a class="link" data-act="toggle-source">' + (open ? "hide source" : "show source") + "</a></div>" +
      (open ? sourceBlock(it, s.quote) : "") + compare +
      '<div class="fields">' + f.join("") + pick + "</div>" +
      '<div class="row"><button class="btn primary" data-act="approve">Approve</button><button class="btn danger" data-act="reject">Reject</button>' +
      (isFlagged ? '<button class="btn" data-act="unflag">Back to the queue</button>' : '<button class="btn flag" data-act="flag">Needs further review</button>') +
      '<span class="small muted">Empty fields stay “not stated”. Edit before approving if needed.</span></div></div>';
  }

  function viewToday() {
    const allOpen = state.steps.filter((s) => !s.done);
    const matchesOwner = (s, o) => o === "All" || (o === "No owner" ? !s.owner : s.owner === o);
    const open = allOpen.filter((s) => matchesOwner(s, ownerFilter));
    const sorted = Core.sortNextSteps(open, TODAY);
    const p = pending().length;
    const options = ["All"].concat(DATA.team, ["No owner"]).map((o) => '<option value="' + esc(o) + '"' + (o === ownerFilter ? " selected" : "") + ">" + esc(o) + " (" + allOpen.filter((s) => matchesOwner(s, o)).length + ")</option>").join("");
    let html = '<div class="row spread" style="margin-bottom:10px"><div><h2>Today\'s list</h2><div class="small muted">Approved next steps only. Order: overdue first, then nearest due date, then biggest deal, then longest wait.</div></div>' +
      '<div><label class="small muted" for="owner-filter">Owner </label><select class="pick" id="owner-filter" style="width:auto">' + options + "</select></div></div>";
    const f = flagged().length;
    if (p || f) html += '<div class="banner">' + [p ? p + " suggestion" + (p === 1 ? "" : "s") + " waiting for your review" : "", f ? f + " marked as needing further review" : ""].filter(Boolean).join(" · ") + '. <a class="link" data-goto="review">Review now</a></div>';
    if (allOpen.length && ownerFilter !== "All") html += '<div class="small muted" style="margin-bottom:10px">Showing ' + sorted.length + " of " + allOpen.length + " open next steps · " + (ownerFilter === "No owner" ? "with no owner" : "owner " + esc(ownerFilter)) + ' · <a class="link" data-owner="All">show all</a></div>';
    if (!allOpen.length) {
      html += '<div class="card muted">No approved next steps yet. Go to <a class="link" data-goto="sources">Sources</a> to analyse emails and notes, then approve suggestions in <a class="link" data-goto="review">Review</a>.</div>';
    } else if (!sorted.length) {
      html += '<div class="card muted">Nothing due for ' + (ownerFilter === "No owner" ? "unowned items" : esc(ownerFilter)) + ". " + allOpen.length + " open next step" + (allOpen.length === 1 ? " belongs" : "s belong") + ' to other owners. <a class="link" data-owner="All">Show all</a></div>';
    }
    sorted.forEach((s, i) => {
      const due = s.days_to_due == null ? '<span class="chip chip-amber">No date: please set one</span>' : s.days_to_due < 0 ? '<span class="chip chip-red">Overdue by ' + -s.days_to_due + " day" + (s.days_to_due === -1 ? "" : "s") + "</span>" : s.days_to_due === 0 ? '<span class="chip chip-red">Due today</span>' : '<span class="chip chip-' + (s.days_to_due <= 7 ? "amber" : "grey") + '">Due in ' + s.days_to_due + " day" + (s.days_to_due === 1 ? "" : "s") + " · " + fmtDate(s.due_date) + "</span>";
      const why = [money(s.value), "raised " + s.days_waiting + " day" + (s.days_waiting === 1 ? "" : "s") + " ago", s.promised_by === "atliq" ? "AtliQ promised" : s.promised_by === "client" ? "client deadline" : null, s.owner ? "owner " + s.owner : "no owner"].filter(Boolean).join(" · ");
      html += '<div class="card"><div class="step"><span class="rank">' + (i + 1) + '</span><div class="body"><div class="row spread"><b>' + esc(s.company) + (s.lead_id ? ' <span class="muted small">' + esc(s.lead_id) + "</span>" : "") + "</b>" + due + "</div><div>" + esc(s.next_step) + '</div><div class="small muted">' + esc(why) + '</div><blockquote class="small">“' + esc(s.quote) + '”</blockquote><div class="row"><button class="btn" data-done="' + esc(s.id) + '">Mark done</button><span class="small muted">Source: ' + esc(item(s.source).title) + "</span></div></div></div></div>";
    });
    const done = state.steps.filter((s) => s.done).length;
    if (done) html += '<div class="small muted">' + done + " next step" + (done === 1 ? "" : "s") + " marked done.</div>";
    return html;
  }

  function viewReview() {
    const p = pending();
    const fl = flagged();
    let html = '<h2>Review suggestions</h2><div class="small muted" style="margin-bottom:10px">Nothing changes in the CRM until you approve it. Every suggestion quotes the line it came from. Not sure yet? Mark it “Needs further review” and come back to it.</div>';
    if (!p.length && !fl.length) return html + '<div class="card muted">Nothing waiting. Analyse more emails and notes in <a class="link" data-goto="sources">Sources</a>.</div>';
    html += p.length ? p.map(suggestionCard).join("") : '<div class="card muted">The queue is empty. Only items marked for further review are left.</div>';
    if (fl.length) html += '<h3 class="section-title">Needs further review <span class="chip chip-flag">' + fl.length + "</span></h3>" + fl.map(suggestionCard).join("");
    return html;
  }

  function viewSources() {
    const analysed = Object.keys(state.analyses).length;
    let html = '<div class="row spread" style="margin-bottom:10px"><div><h2>Emails and meeting notes</h2><div class="small muted">' + analysed + " of " + DATA.items.length + ' analysed. Each one is read once by the AI model.</div></div><div class="row">' +
      (run.active ? '<button class="btn" id="stop-all">Stop</button>' : '<button class="btn primary" id="analyse-all"' + (ai.connected ? "" : " disabled") + ">Analyse all remaining</button>") + "</div></div>";
    if (!ai.connected) html += '<div class="banner">' + esc(ai.note) + ". The rule-based parts (CRM checks, duplicates, record matching) still work.</div>";
    if (!run.active && run.note) html += '<div class="banner info">' + esc(run.note) + "</div>";
    if (run.active) html += '<div class="card">Analysing ' + run.done + " of " + run.total + "…" + (run.note ? ' <span class="muted">' + esc(run.note) + "</span>" : "") + '<div class="progress"><div style="width:' + (run.total ? Math.round((100 * run.done) / run.total) : 0) + '%"></div></div></div>';
    html += '<div class="card tablewrap"><table><thead><tr><th>Date</th><th>Type</th><th>Source</th><th>Matched CRM records</th><th>Result</th><th></th></tr></thead><tbody>';
    DATA.items.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((it) => {
      const m = Core.matchRecords(it, state.crm);
      const a = state.analyses[it.id];
      const err = state.errors[it.id];
      let result = '<span class="muted">not analysed</span>';
      if (a) result = a.suggestions.length + " suggestion" + (a.suggestions.length === 1 ? "" : "s") + (a.dropped && a.dropped.length ? ' <span class="chip chip-red" title="Dropped because the quote was not found in the source">' + a.dropped.length + " dropped</span>" : "") + '<div class="small muted">' + esc(a.summary || "") + "</div>";
      if (err) result = '<span class="chip chip-red">Error</span><div class="small">' + esc(err) + "</div>";
      const open = openSources.has(it.id);
      html += "<tr><td>" + fmtDate(it.date) + "</td><td>" + (it.kind === "email" ? "Email" : "Note") + '</td><td><a class="link" data-src="' + esc(it.id) + '">' + esc(it.title) + "</a></td><td>" + (m.length ? m.map((x) => '<span class="chip chip-grey" title="' + esc(x.why) + '">' + esc(x.lead_id) + "</span>").join(" ") : '<span class="chip chip-amber">none: not in the CRM</span>') + "</td><td>" + result + '</td><td><button class="btn" data-analyse="' + esc(it.id) + '"' + (ai.connected && !run.active && !approvedFrom(it.id) ? "" : " disabled") + (approvedFrom(it.id) ? ' title="Already approved from this source"' : "") + ">" + (a ? "Re-analyse" : "Analyse") + "</button></td></tr>";
      if (open) html += '<tr><td colspan="6">' + sourceBlock(it) + "</td></tr>";
    });
    return html + "</tbody></table></div>";
  }

  function viewCrm() {
    const dups = Core.findDuplicates(state.crm);
    const dupIds = new Set(dups.flatMap((d) => d.lead_ids));
    let flagged = 0;
    let rows = "";
    state.crm.forEach((r) => {
      const issues = Core.recordIssues(r, state.crm, TODAY);
      if (dupIds.has(r.lead_id)) issues.unshift("Possible duplicate");
      if (issues.length) flagged++;
      const ch = state.changed[r.lead_id] || {};
      const td = (f, v) => '<td class="' + (ch[f] ? "changed" : "") + '">' + (v === "" || v == null ? '<span class="muted">not stated</span>' : esc(v)) + "</td>";
      rows += "<tr><td>" + esc(r.lead_id) + "</td>" + td("company", r.company) + td("contact_name", r.contact_name) + td("status", r.status) + td("est_value_usd", r.est_value_usd == null ? "" : "$" + Number(r.est_value_usd).toLocaleString("en-US")) + td("owner", r.owner) + td("last_contact_date", r.last_contact_date) + td("next_followup_date", r.next_followup_date) + "<td>" + issues.map((i) => '<span class="chip chip-' + (i === "Possible duplicate" || i === "No owner" ? "red" : "amber") + '">' + esc(i) + "</span>").join(" ") + "</td></tr>";
    });
    let html = '<h2>CRM health check</h2><div class="small muted" style="margin-bottom:10px">' + flagged + " of " + state.crm.length + " records have something to check. These checks are plain rules, not AI. Green cells were changed by a suggestion you approved.</div>";
    if (dups.length) html += '<div class="card"><h3>Possible duplicates (flag only: nothing is merged automatically)</h3><ul class="plain">' + dups.map((d) => "<li>" + d.lead_ids.map((id) => esc(id + " " + record(id).company + " (owner: " + (record(id).owner || "none") + ")")).join(" &nbsp;↔&nbsp; ") + ' <span class="muted small">· ' + esc(d.why) + "</span></li>").join("") + "</ul></div>";
    if (state.opps.length) html += '<div class="card"><h3>Approved opportunities</h3><ul class="plain">' + state.opps.map((o) => "<li><b>" + esc(o.company) + "</b> · " + esc(KIND_LABEL[o.kind] || "Opportunity") + " · " + esc(o.title) + ' <span class="muted small">· owner ' + esc(o.owner || "none") + " · " + esc(money(o.value)) + "</span></li>").join("") + "</ul></div>";
    return html + '<div class="card tablewrap"><table><thead><tr><th>ID</th><th>Company</th><th>Contact</th><th>Status</th><th>Value</th><th>Owner</th><th>Last contact</th><th>Follow-up</th><th>To check</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  }

  function viewActivity() {
    let html = '<div class="row spread" style="margin-bottom:10px"><div><h2>Activity record</h2><div class="small muted">Every approval, rejection and completed step. The latest action can be undone.</div></div><button class="btn danger" id="reset">Reset the demo</button></div>';
    if (!state.log.length) return html + '<div class="card muted">Nothing yet.</div>';
    return html + '<div class="card"><table><thead><tr><th>When</th><th>What</th><th></th></tr></thead><tbody>' + state.log.map((l, i) => "<tr><td>" + esc(new Date(l.at).toLocaleString()) + "</td><td>" + esc(l.text) + "</td><td>" + (i === 0 && l.before ? '<button class="btn" id="undo">Undo</button>' : "") + "</td></tr>").join("") + "</tbody></table></div>";
  }

  function viewGuardrails() {
    const g = [
      ["People stay in charge", "The CRM copy in this app changes only when you press Approve. There is no send button anywhere: the assistant cannot email a client."],
      ["Every suggestion shows its source", "The model must quote the line it relied on. The server checks that the quote appears word for word in the email or note, and drops the suggestion if it does not. The browser checks again."],
      ["No guessing", "If a value, date, contact or owner is not in the source, the field is left empty and shown as “not stated”. Lead IDs, owners, dates and contact emails returned by the model are checked against the data and removed if they do not match."],
      ["Unsure means “please confirm”", "Vague dates such as “next week” get no date. The wording is shown and the suggestion is marked for you to confirm."],
      ["Only the dataset", "The server accepts an item ID from the bundled capstone dataset, not free text, so it cannot be used on anything else. Text inside an email is treated as data, never as instructions."],
      ["Flags, not fixes", "Duplicates and incomplete records are pointed out by plain rules. Nothing is merged or deleted automatically."],
      ["Everything is recorded", "The Activity tab lists each approval, rejection and completed step, and the latest one can be undone."],
      ["No judging people", "The assistant does not score or rank sellers."],
    ];
    return '<h2>Guardrails in this prototype</h2><div class="small muted" style="margin-bottom:10px">How the PRD\'s safety rules are enforced in code.</div>' + g.map((x) => '<div class="card"><h3>' + esc(x[0]) + "</h3><div>" + esc(x[1]) + "</div></div>").join("");
  }

  function render() {
    document.getElementById("today").textContent = fmtDate(TODAY);
    document.body.dataset.tab = tab;
    document.querySelectorAll("#tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
      if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.getElementById("c-today").textContent = state.steps.filter((s) => !s.done).length || "";
    document.getElementById("c-review").textContent = pending().length + flagged().length || "";
    document.getElementById("c-sources").textContent = Object.keys(state.analyses).length + "/" + DATA.items.length;
    document.getElementById("c-crm").textContent = state.crm.length;
    document.getElementById("c-activity").textContent = state.log.length || "";
    view.innerHTML = { today: viewToday, review: viewReview, sources: viewSources, crm: viewCrm, activity: viewActivity, guardrails: viewGuardrails }[tab]();
  }

  // ---------- events ----------
  document.getElementById("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) { tab = b.dataset.tab; render(); }
  });
  view.addEventListener("change", (e) => {
    if (e.target.id === "owner-filter") { ownerFilter = e.target.value; render(); }
  });
  view.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.dataset.goto) { tab = t.dataset.goto; render(); return; }
    if (t.dataset.owner) { ownerFilter = t.dataset.owner; render(); return; }
    const card = t.closest("[data-sid]");
    if (card && t.dataset.act === "approve") return approve(card.dataset.sid, card);
    if (card && t.dataset.act === "reject") return reject(card.dataset.sid);
    if (card && t.dataset.act === "flag") return flagForReview(card.dataset.sid, true);
    if (card && t.dataset.act === "unflag") return flagForReview(card.dataset.sid, false);
    if (card && t.dataset.act === "toggle-source") { const k = card.dataset.sid; openSources.has(k) ? openSources.delete(k) : openSources.add(k); return render(); }
    if (t.dataset.src) { const k = t.dataset.src; openSources.has(k) ? openSources.delete(k) : openSources.add(k); return render(); }
    if (t.dataset.done) return markDone(t.dataset.done);
    if (t.dataset.analyse) { t.disabled = true; t.textContent = "Analysing…"; await analyse(t.dataset.analyse); return render(); }
    if (t.id === "analyse-all") return analyseAll();
    if (t.id === "stop-all") { run.stop = true; return; }
    if (t.id === "undo") return undoLast();
    if (t.id === "reset" && confirm("Clear all analyses, approvals and the activity record in this browser?")) { state = freshState(); save(); render(); }
  });

  const chip = document.getElementById("ai-status");
  chip.title = "Click to check the AI connection again";
  chip.style.cursor = "pointer";
  chip.addEventListener("click", checkAi);

  render();
  checkAi();
})();
