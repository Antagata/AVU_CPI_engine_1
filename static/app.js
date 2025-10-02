  // ===== Safe campaign_index loader =====
  async function tryLoadCampaignIndex() {
    try {
      const res = await fetch('/api/campaign_index', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      window.CAMPAIGN_INDEX = data;
      console.log('📊 campaign_index loaded');
    } catch (err) {
      window.CAMPAIGN_INDEX = null;
      console.info('[campaign_index] not available; continuing…', String(err));
    }
  }
/* static/app.js – calendar UX: a11y, busy states, dedupe, week snapshots, long-press, wired filters, detach FS, gauge, leads, full-year weeks */
(() => {
  "use strict";

  // ===== Constants & State =====
  const NUM_SLOTS = 5;
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  const URLS = {
    status: "/status",
    runFull: "/run_full_engine",
    runNotebook: "/run_notebook",
    schedule: "/api/schedule",
    leads: "/api/leads",
    locked: "/api/locked",
    selectedWine: "/api/selected_wine",
    catalog: "/api/catalog",
    engineReady: "/engine_ready",
    campaignIndex: "/api/campaign_index"
  };

  // --- UI config (populated later)
  let APP_CFG = { ironDataPath: "", priceBaselineByLoyalty: undefined };

  // ===== Pricing index for the Fine-Tune gauge =====
  const PRICE_INDEX = {
    "budget": 0.20,
    "mid-range": 0.40,
    "midrange": 0.40,
    "premium": 0.60,
    "luxury": 0.80,
    "ultra luxury": 1.00,
    "ultra-luxury": 1.00,
    "ultra": 1.00
  };

  const DEFAULT_BASELINES = { all: 0.55, vip: 0.75, gold: 0.65, silver: 0.50, bronze: 0.35 };

  let GAUGE = { raf: null, startTs: 0, oscillate: false, targetAngle: 0, angle: 0, lastSettleAngle: 0, dom: { needle: null, readout: null, arc: null } };

  let CAMPAIGN_INDEX = { by_id: {}, by_name: {} };
  let engineReady = sessionStorage.getItem("engineReady") === "true";
  let selectedWineEl = null;
  let selectedWineData = safeParse(sessionStorage.getItem("selectedWine"), null);

  // Year/Week
  let currentYear;
  let currentWeek;

  // Back-compat (kept but driven by currentWeek)
  let currentActiveWeek = sessionStorage.getItem("selectedWeek") || null;

  let isWeekLoading = false;
  let runInFlight = false;
  let draggedItem = null;
  let ctxMenuEl = null;
  let tooltipEl = null;
  let filtersDirty = false;

  // ===== Tiny DOM helpers =====
  const $ = (sel, root = document) => root.querySelector(sel);
  const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const CAL = () => $("#main-calendar-grid")?.closest(".calendar-grid-container");

  // ===== Keys & snapshots (YEAR+WEEK aware) =====
  const weekSnapKey = (yr, wk) => `calendarSnapshot:${yr}-${wk}`;
  const weekLockedKey = (yr, wk) => `lockedCalendar:${yr}-${wk}`;
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const makeKey = (id, vintage, name) => `${norm(id || name)}::${norm(vintage || "NV")}`;

  // ===== ISO Year/Week Helpers =====
  function isoNowEurope() {
    const now = new Date();
    // ISO week calc
    const target = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return { year: target.getUTCFullYear(), week: Math.min(Math.max(week, 1), 53) };
  }
  function getISOWeekNumber() { return isoNowEurope().week; }
  function setPrevWeekOnSelector(week) { const sel = $("#weekSelector"); if (sel) sel.dataset.prevWeek = String(week); }

  // FULL YEAR (1..53)
  function populateWeekSelector(defaultWeek) {
    const sel = $("#weekSelector");
    if (!sel) return;
    const base = Number(defaultWeek);
    const opts = [];
    for (let w = 1; w <= 53; w++) {
      const opt = document.createElement("option");
      opt.value = String(w);
      opt.textContent = `Week ${w}`;
      opts.push(opt);
    }
    sel.replaceChildren(...opts);
    sel.value = String(base >= 1 && base <= 53 ? base : getISOWeekNumber());
    setPrevWeekOnSelector(sel.value);
  }
  function getWeekFromUI() {
    const sel = $("#weekSelector");
    return sel?.value ?? String(getISOWeekNumber());
  }

  // ===== Engine ready hydration & button/filter state =====
  async function hydrateEngineReady() {
    try {
      const r = await fetch(URLS.engineReady, { cache: "no-store" });
      let ready = false;
      if (r.ok) {
        try { ready = !!(await r.json()).ready; } catch { ready = false; }
      }
      engineReady = ready;
    } catch { engineReady = false; }
    sessionStorage.setItem("engineReady", engineReady ? "true" : "false");
    updateStartBtnState(); updateLoadBtnState(); setFiltersEnabled(engineReady);
  }

  function updateLoadBtnState() {
    const btn = $("#loadScheduleBtn");
    if (!btn) return;
    const calBusy = !!CAL()?.classList.contains("is-busy");
    const shouldDisable = !engineReady || runInFlight || calBusy;
    btn.disabled = shouldDisable;
    btn.classList.toggle("opacity-50", shouldDisable);
    btn.classList.toggle("pointer-events-none", shouldDisable);
    btn.setAttribute("aria-disabled", String(shouldDisable));
    if (!engineReady) btn.setAttribute("title", "Run Start AVU Engine first");
    else if (filtersDirty) btn.setAttribute("title", "Apply filters & rebuild the calendar");
    else if (shouldDisable) btn.setAttribute("title", "Please wait…");
    else btn.setAttribute("title", "Reload calendar for the selected week");
  }

  function updateStartBtnState() {
    const btn = $("#startEngineBtn");
    if (!btn) return;
    const disable = engineReady || runInFlight;
    btn.disabled = disable;
    btn.classList.toggle("opacity-50", disable);
    btn.classList.toggle("pointer-events-none", disable);
    btn.setAttribute("aria-disabled", String(disable));
    btn.title = disable ? "Engine already initialized" : "Start AVU Engine";
  }

  // Enable/disable all filter widgets + related buttons until engine is ready
  function setFiltersEnabled(enabled) {
    const toggle = (el) => {
      if (!el) return;
      if ("disabled" in el) el.disabled = !enabled;
      el.classList.toggle("opacity-50", !enabled);
      el.classList.toggle("pointer-events-none", !enabled);
      if (!enabled) el.setAttribute("aria-disabled", "true");
      else el.removeAttribute("aria-disabled");
    };

    // Button groups
    $all("#loyalty-group button").forEach(toggle);
    $all("#wine-type-group button").forEach(toggle);
    $all(".cruise-button-small").forEach(toggle);

    // Inputs/selects
    ["#price-tier","#bottle-size-slicer","#bigger-size-selector","#last-stock-checkbox","#seasonality-checkbox","#pb-size-filter"].forEach(sel => toggle($(sel)));

    updateLoadBtnState();
  }

  // ===== HTTP =====
  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
  }
  async function postJSON(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  // ===== Status panel & busy states =====
  function showStatusPanel() {
    const el = $("#status-panel");
    if (!el) return;
    el.classList.remove("hidden");
    el.style.display = "flex";
    setStatusBadge("running");
    setCalendarInteractivity(false);
  }
  function hideStatusPanel() {
    const el = $("#status-panel");
    if (!el) return;
    el.classList.add("hidden");
    el.style.display = "none";
    setCalendarInteractivity(true);
  }
  function setStatus({ message = "", progress = 0, state = "" }) {
    $("#status-message").textContent = message || "";
    $("#progress-bar-fill").style.width = `${Math.max(0, Math.min(100, progress))}%`;
    $("#progress-percent").textContent = `${Math.round(progress)}%`;
    if (state) setStatusBadge(state);
  }
  function setStatusBadge(state) {
    const badge = $("#status-badge"); if (!badge) return;
    const s = String(state || "idle").toLowerCase();
    badge.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    badge.className = "badge";
    badge.classList.add(
      s === "running" ? "badge-running" :
      s === "completed" ? "badge-completed" :
      s === "error" ? "badge-error" : "badge-idle"
    );
  }
  function setCalendarInteractivity(enabled) {
    const cal = CAL(); const sel = $("#weekSelector");
    if (!cal) return;
    cal.setAttribute("aria-busy", String(!enabled));
    cal.classList.toggle("is-busy", !enabled);
    try { if (!enabled) cal.setAttribute("inert", ""); else cal.removeAttribute("inert"); } catch {}
    if (sel) sel.disabled = !enabled;
    updateLoadBtnState();
  }

  async function pollStatusUntilDone({ refreshSchedule = true, onCompleted } = {}) {
    showStatusPanel();
    runInFlight = true;
    startGaugeOscillation();
    updateStartBtnState();
    updateLoadBtnState();
    setStatus({ message: "Starting…", progress: 0, state: "running" });

    let lastProgress = 0;
    let unchangedTicks = 0;
    const heartbeat = setInterval(() => {
      const bar = $("#progress-bar-fill");
      if (!bar) return;
      const width = parseFloat(bar.style.width || "0");
      const target = Math.min(94, width + 0.3);
      bar.style.width = `${target}%`;
      $("#progress-percent").textContent = `${Math.round(target)}%`;
    }, 1500);

    return new Promise((resolve) => {
      const timer = setInterval(async () => {
        try {
          const s = await getJSON(URLS.status);
          setStatus({ message: s.message, progress: s.progress, state: s.state });

          if (s.progress === lastProgress) {
            unchangedTicks += 1;
            if (s.progress === 75 && unchangedTicks >= 20) {
              $("#status-message").textContent = "Still processing… (if it stays here, check the notebook logs)";
            }
          } else {
            lastProgress = s.progress;
            unchangedTicks = 0;
          }

          const finished = (s.state === "completed") || (s.state === "error") || Number(s.progress) >= 100;
          if (!finished) return;

          clearInterval(timer);
          clearInterval(heartbeat);
          setStatusBadge(s.state);

          if (s.state === "completed") {
            if (typeof onCompleted === "function") onCompleted(s);
            if (refreshSchedule) {
              await handleWeekYearChange(currentYear, currentWeek);
            }
            hideStatusPanel();
          } else {
            setCalendarInteractivity(true);
          }
          stopGaugeOscillation();

          runInFlight = false;
          updateStartBtnState();
          updateLoadBtnState();
          recalcAndUpdateGauge({ animate: false });
          resolve(s);

        } catch (e) {
          console.error("Polling error:", e);
          clearInterval(timer);
          clearInterval(heartbeat);
          setStatus({ message: "Polling failed", progress: 0, state: "error" });
          stopGaugeOscillation();
          runInFlight = false;
          setCalendarInteractivity(true);
          updateStartBtnState();
          updateLoadBtnState();
          resolve({ state: "error", message: "Polling failed" });
        }
      }, 1200);
    });
  }

  // ===== Offer buttons enable/disable =====
  function setOfferButtonsEnabled(enabled) {
    const btns = ["#generateOfferBtn", "#generateTailorMadeOfferBtn"].map((s) => $(s));
    btns.forEach((b) => {
      if (!b) return;
      b.disabled = !enabled;
      b.classList.toggle("opacity-50", !enabled);
      b.classList.toggle("pointer-events-none", !enabled);
      b.setAttribute("aria-disabled", String(!enabled));
    });
  }

  // === Filter helpers ===
  function _tierOf(it) {
    return (it?.price_tier_bucket ?? it?.price_bucket ?? it?.price_category ?? it?.price_tier ?? it?.priceTier ?? it?.tier ?? "");
  }
  function _fullTypeOf(it) {
    const s = String(it?.full_type ?? it?.type ?? "").toLowerCase();
    const name = String(it?.wine ?? it?.name ?? "").toLowerCase();
    return { s, name };
  }
  function _stockOf(it) {
    const v = Number(it?.stock ?? it?.stock_count ?? it?.Stock ?? it?.qty ?? it?.quantity ?? NaN);
    return Number.isFinite(v) ? v : NaN;
  }
  function itemMatchesFilters(it, f) {
    if (!f) return true;
    if (f.last_stock) {
      const st = _stockOf(it);
      const thr = Number.isFinite(f.last_stock_threshold) ? f.last_stock_threshold : 10;
      if (!Number.isFinite(st) || !(st < thr)) return false;
    }
    if (f.price_tier_bucket && _tierOf(it) !== f.price_tier_bucket) return false;
    if (f.wine_type) {
      const { s, name } = _fullTypeOf(it); const want = String(f.wine_type).toLowerCase();
      const matched =
        s.includes(want) ||
        (want === "rosé" && (s.includes("rose") || s.includes("rosé"))) ||
        (want === "rose" && (s.includes("rosé") || s.includes("rose"))) ||
        (want === "red" && (s.includes("red") || name.includes("bordeaux"))) ||
        (want === "sparkling" && (s.includes("spark") || s.includes("champ") || s.includes("cava") || s.includes("prosecco")));
      if (!matched) return false;
    }
    return true;
  }
  function filterCalendarByUIFilters(calendar, f) {
    if (!calendar || !f) return calendar;
    const out = {};
    for (const day of DAYS) {
      const arr = Array.isArray(calendar?.[day]) ? calendar[day] : [];
      out[day] = arr.filter(it => itemMatchesFilters(it, f)).slice(0, NUM_SLOTS);
    }
    return out;
  }

  // ===== Filters & selections =====
  function mapUIFiltersForBackend() {
    const loyaltyActive = document.querySelector('#loyalty-group button.active');
    const loyalty = (loyaltyActive?.dataset?.value || loyaltyActive?.textContent || "all").trim().toLowerCase();
    const typeActive = document.querySelector('#wine-type-group button.active');
    const wt = (typeActive?.dataset?.value || typeActive?.textContent || "All").trim();
    const wine_type = (/^all$/i.test(wt)) ? null : wt;
    const baseVal = $("#bottle-size-slicer")?.value || "750";
    const biggerSel = $("#bigger-size-selector");
    const bottle_size = (baseVal === "bigger" && biggerSel && !biggerSel.classList.contains("hidden")) ?
      parseInt(biggerSel.value || "3000", 10) :
      parseInt(baseVal, 10);
    const priceTierSel = $("#price-tier");
    const price_tier_bucket = (priceTierSel?.value || "").trim();
    const last_stock = !!$("#last-stock-checkbox")?.checked;
    const last_stock_threshold = last_stock ? 10 : null;
    const seasonality_boost = !!$("#seasonality-checkbox")?.checked;
    const styleActive = document.querySelector('.cruise-button-small.active');
    const style = (styleActive?.dataset?.style || "default").toLowerCase();
    const calendar_day = (window.__avuSelectedCellDay || (selectedWineData?.day ?? null)) || null;

    return { loyalty, wine_type, bottle_size, price_tier_bucket, last_stock, last_stock_threshold, seasonality_boost, style, calendar_day };
  }

  function markFiltersDirty() {
    filtersDirty = true;
    setOfferButtonsEnabled(false);
    const btn = $("#loadScheduleBtn");
    if (btn) {
      if (engineReady) btn.disabled = false;
      btn.classList.toggle("opacity-50", !engineReady);
      btn.classList.toggle("pointer-events-none", !engineReady);
      btn.textContent = "🔄 Apply filters & reload";
      btn.setAttribute("aria-disabled", String(!engineReady));
      btn.setAttribute("title", engineReady ? "Apply filters & rebuild the calendar" : "Run Start AVU Engine first");
      recalcAndUpdateGauge({ animate: true });
    }
  }
  function clearFiltersDirty() {
    filtersDirty = false;
    const btn = $("#loadScheduleBtn");
    if (btn) { btn.textContent = "🔄 Load new schedule"; updateLoadBtnState(); }
    setOfferButtonsEnabled(!!selectedWineData);
  }

  function resetFiltersToDefault() {
    $all("#loyalty-group button").forEach(b => b.classList.remove("active"));
    const lAll = $('#loyalty-group button:nth-child(1)'); if (lAll) lAll.classList.add("active");
    $all("#wine-type-group button").forEach(b => b.classList.remove("active"));
    const tAll = $('#wine-type-group button:nth-child(1)'); if (tAll) tAll.classList.add("active");
    const bs = $("#bottle-size-slicer"); if (bs) bs.value = "750";
    const bigger = $("#bigger-size-selector"); bigger?.classList.add("hidden");
    const pt = $("#price-tier"); if (pt) pt.value = "";
    const ls = $("#last-stock-checkbox"); if (ls) ls.checked = false;
    const se = $("#seasonality-checkbox"); if (se) se.checked = false;
    $all(".cruise-button-small").forEach(b => b.classList.remove("active"));
    clearFiltersDirty();
  }

  // ===== Calendar skeleton & DnD =====
  function clearCalendar() {
    $all(".fill-box").forEach((b) => { b.innerHTML = ""; b.classList.remove("filled", "active", "over", "empty"); });
    $all(".overflow-drawer, .leads-drawer").forEach((drawer) => {
      $all(".wine-box", drawer).forEach((c) => c.remove());
      drawer.classList.remove("active");
    });
  }

  function buildCalendarSkeleton() {
    const grid = $("#main-calendar-grid");
    if (!grid) return;
    grid.innerHTML = "";
    const mkLeadsBox = (label, gridCol) => {
      const box = document.createElement("div");
      box.className = "fill-box leads-box";
      box.dataset.day = label;
      box.dataset.slot = "0";
      box.style.gridColumn = gridCol;
      box.style.gridRow = "1";
      box.innerHTML = `<div class="leads-label"><i class="fa-solid fa-bullhorn"></i> ${label}</div>`;
      box.addEventListener("click", () => openQuickAdd(label, 0));
      box.addEventListener("contextmenu", (e) => { e.preventDefault(); });
      return box;
    };
  grid.appendChild(mkLeadsBox("Leads (Tuesday–Wednesday)", "2 / span 2"));
  grid.appendChild(mkLeadsBox("Leads (Thursday–Friday)", "4 / span 2"));
  grid.appendChild(mkLeadsBox("Leads (Saturday–Sunday)", "6 / span 2"));
    DAYS.forEach((day) => {
      const col = document.createElement("div");
      col.className = "day-column";
      col.innerHTML = `<div class="day-name">${day}</div>`;
      const body = document.createElement("div");
      body.className = "day-body";
      for (let i = 0; i < NUM_SLOTS; i++) {
        const box = document.createElement("div");
        box.className = "fill-box empty";
        box.dataset.day = day;
        box.dataset.slot = String(i);
        box.addEventListener("click", () => openQuickAdd(day, i));
        box.addEventListener("contextmenu", (e) => { e.preventDefault(); });
        body.appendChild(box);
      }
      const overflow = document.createElement("div");
      overflow.className = "overflow-drawer";
      overflow.dataset.day = day;
      overflow.textContent = "Overflow:";
      col.appendChild(body);
      col.appendChild(overflow);
      grid.appendChild(col);
    });
    addDropZoneListeners();
  }

  function addDropZoneListeners() {
    $all(".fill-box, .overflow-drawer, .leads-drawer").forEach((zone) => {
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("over"));
      zone.addEventListener("drop", (e) => {
        zone.classList.remove("over");
        if (!draggedItem) return;
        const targetBox = e.currentTarget;
        const oldParent = draggedItem.parentNode;
        if (oldParent !== targetBox) {
          if (oldParent && oldParent.classList.contains("filled") && oldParent.children.length === 1) {
            oldParent.classList.remove("filled");
          }
          if (oldParent && (oldParent.classList.contains("overflow-drawer") || oldParent.classList.contains("leads-drawer")) && oldParent.children.length === 1) {
            oldParent.classList.remove("active");
          }
          const afterElement = getDragAfterElement(targetBox, e.clientY);
          if (afterElement == null) targetBox.appendChild(draggedItem);
          else targetBox.insertBefore(draggedItem, afterElement);
          if (targetBox.classList.contains("fill-box")) targetBox.classList.add("filled");
          else if (targetBox.classList.contains("overflow-drawer") || targetBox.classList.contains("leads-drawer")) targetBox.classList.add("active");
          draggedItem.dataset.day = targetBox.dataset.day || draggedItem.dataset.day;
          persistLockedCalendarState().catch(console.warn);
          persistFullCalendarSnapshot().catch(console.warn);
          recalcAndUpdateGauge({ animate: true });
        }
        draggedItem = null;
      });
    });
  }

  function getDragAfterElement(container, y) {
    const items = Array.from(container.querySelectorAll(".wine-box:not(.dragging)"));
    let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    for (const child of items) {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
    }
    return closest.element;
  }

  function attachWineBoxDragHandlers(el) {
    el.setAttribute("draggable", "true");
    el.addEventListener("dragstart", (e) => {
      draggedItem = el;
      el.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      draggedItem = null;
    });
  }

  // ===== Price tier helpers =====
  function derivePriceTierLabel(item) {
    return (item.price_tier_bucket || item.price_bucket || item.price_category || item.price_tier || item.priceTier || item.tier || "");
  }

  // ===== Campaign index helpers =====
  function keyNameForIndex(name, vintage) { return `${norm(name)}::${norm(vintage || "NV")}`; }
  function lookupLastCampaign(id, name, vintage) {
    if (!CAMPAIGN_INDEX) return "";
    const idKey = id ? String(id) : "";
    if (idKey && CAMPAIGN_INDEX.by_id && CAMPAIGN_INDEX.by_id[idKey]) return CAMPAIGN_INDEX.by_id[idKey] || "";
    const nk = keyNameForIndex(name || "", vintage || "");
    if (CAMPAIGN_INDEX.by_name && CAMPAIGN_INDEX.by_name[nk]) return CAMPAIGN_INDEX.by_name[nk] || "";
    return "";
  }

  // ===== Renderers (cards) =====
  function renderWineIntoBox(box, item, { locked = false } = {}) {
    const id = item.id || `${(item.wine || item.name || "Wine").replace(/\s/g, "")}_${item.vintage || "NV"}_${box.dataset.day}_${box.dataset.slot}`;
    const el = document.createElement("div");
    el.className = "wine-box";
    el.id = `wine_${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

    // datasets
    el.dataset.id = item.id || "";
    el.dataset.day = box.dataset.day;
    el.dataset.name = item.wine || item.name || "Unknown";
    el.dataset.vintage = item.vintage || "N/A";
    el.dataset.locked = locked ? "true" : String(!!item.locked);
    el.dataset.type = item.full_type || item.type || "";
    el.dataset.stock = (item.stock ?? item.stock_count ?? "").toString();
    el.dataset.priceTier = (item.price_tier || item.tier || item.priceTier || "").toString();
    el.dataset.loyalty = item.loyalty_level || "";
    el.dataset.region = item.region_group || item.region || "";
    el.dataset.matchQuality = item.match_quality || "";
    el.dataset.cpiScore = item.avg_cpi_score ?? item.cpi_score ?? "";
    el.dataset.lastCampaign = (item.last_campaign_date || item.last_campaign || item.lastCampaign || "").toString();
    
    // Custom card support
    if (item.custom_card) {
      el.dataset.customCard = "true";
    }
    
    // Card color support
    if (item.card_color || item.cardColor) {
      el.dataset.cardColor = item.card_color || item.cardColor;
    }
    
    // Reason payload support
    if (item.reason_payload) {
      el.dataset.reasonPayload = JSON.stringify(item.reason_payload);
    }
    
    // Schedule time support
    if (item.schedule_time) {
      el.dataset.scheduleTime = item.schedule_time;
    }

    const isLocked = el.dataset.locked === "true";
    const lockIcon = isLocked ? "fa-lock" : "fa-lock-open";
    const badgeText = isLocked ? "Locked" : "Auto";
    const priceText = el.dataset.priceTier ? `Price: ${el.dataset.priceTier}` : "";
    const stockText = el.dataset.stock ? `Stock: ${el.dataset.stock}` : "";
    const details = [priceText, stockText].filter(Boolean).join(" • ");
    const lastC = el.dataset.lastCampaign;
    const isCustom = el.dataset.customCard === "true";
    
    // Generate reason badges
    const reasonBadges = generateReasonBadges(item.reason_payload);
    
    // Generate tag flags display
    const tagFlags = generateTagFlags(item.reason_payload);

    // Generate schedule time display
    const scheduleTime = item.schedule_time ? formatScheduleTime(item.schedule_time) : '';
    const scheduleDisplay = scheduleTime ? `<div class="schedule-time">${scheduleTime}</div>` : '';

    el.innerHTML = `
      <div class="wine-header">
        <strong class="wine-name">${el.dataset.name}</strong>
        <span class="muted">(${el.dataset.vintage})</span>
        <span class="badge">${badgeText}</span>
        <button class="lock-icon" title="${isLocked ? "Unlock" : "Lock"}" aria-label="Toggle lock" aria-pressed="${isLocked}" type="button">
          <i class="fas ${lockIcon}"></i>
        </button>
      </div>
      <div class="wine-details">
        ${details || "&nbsp;"}
      </div>
      <div class="wine-submeta">
        <div>Last campaign: ${lastC || "-"}</div>
        ${isCustom ? '<div><small style="color: #d4af37;">✨ Custom Wine</small></div>' : ''}
      </div>
      ${reasonBadges}
      ${tagFlags}
      ${scheduleDisplay}
    `;

    const ft = (el.dataset.type || "").toLowerCase();
    const nameLc = (el.dataset.name || "").toLowerCase();
    
    // Apply custom card class if needed
    if (isCustom) {
      el.classList.add("custom-card");
    }
    
    // Apply wine type class (only if no custom color is set)
    const customColor = el.dataset.cardColor;
    if (!customColor) {
      const typeClass = (() => {
        if (ft.includes("spark") || ft.includes("champ") || ft.includes("spumante") || ft.includes("cava") || ft.includes("prosecco")) return "wine-type-sparkling";
        if (ft.includes("rose") || ft.includes("rosé")) return "wine-type-rose";
        if (ft.includes("dessert") || ft.includes("sweet") || ft.includes("sauternes") || ft.includes("port") || ft.includes("sherry") || nameLc.includes("late harvest")) return "wine-type-dessert";
        if (ft.includes("white") || ft.includes("blanc")) return "wine-type-white";
        if (ft.includes("red") || ft.includes("rouge") || nameLc.includes("bordeaux")) return "wine-type-red";
        return "";
      })();
      if (typeClass) el.classList.add(typeClass);
    } else {
      // Apply custom color class
      if (customColor !== 'green') { // green is default
        el.classList.add(`color-${customColor}`);
      }
    }

    // A11y: focusable + keyboard select
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${el.dataset.name} ${el.dataset.vintage}`);
    el.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleSelectWine(el); }
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        showWineContextMenu(el, r.left + 16, r.top + 16);
      }
    });

    el.addEventListener("click", (e) => {
      if (e.target.closest(".lock-icon")) { e.stopPropagation(); return; }
      e.stopPropagation();
      toggleSelectWine(el);
    });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); showWineContextMenu(el, e.clientX, e.clientY); });
    addLongPress(el, (touch) => { showWineContextMenu(el, touch.clientX, touch.clientY); });

    const lockBtn = el.querySelector(".lock-icon");
    lockBtn?.addEventListener("click", (e) => { e.stopPropagation(); toggleCardLock(el); });
    lockBtn?.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleCardLock(el); } });

    el.addEventListener("mouseenter", () => showWineTooltip(el));
    el.addEventListener("mouseleave", hideWineTooltip);

    attachWineBoxDragHandlers(el);

    box.appendChild(el);
    box.classList.add("filled");
    box.classList.remove("empty");

    if (selectedWineData && (selectedWineData.id && selectedWineData.id === el.dataset.id)) {
      el.classList.add("selected");
      selectedWineEl = el;
      setOfferButtonsEnabled(true);
    }

    recalcAndUpdateGauge({ animate: false });
    return el;
  }

  let delegationWired = false;
  function wireCalendarDelegation() {
    if (delegationWired) return;
    const wrap = CAL();
    if (!wrap) return;

    wrap.addEventListener("click", (e) => {
      const lockBtn = e.target.closest(".lock-icon");
      if (lockBtn) return;
      const card = e.target.closest(".wine-box");
      if (card) { e.stopPropagation(); toggleSelectWine(card); }
    });

    wrap.addEventListener("contextmenu", (e) => {
      const card = e.target.closest(".wine-box");
      if (card) { e.preventDefault(); e.stopPropagation(); showWineContextMenu(card, e.clientX, e.clientY); }
    });

    delegationWired = true;
  }

  // ===== Tooltip =====
  function showWineTooltip(el) {
    hideWineTooltip();
    tooltipEl = document.createElement("div");
    tooltipEl.className = "wine-tooltip";
    const d = extractWineData(el);
    tooltipEl.innerHTML = `
      <div><strong>${d.name}</strong> (${d.vintage})</div>
      <div>${d.full_type || "Type?"} • ${d.region_group || "Region?"}</div>
      <div>Price: ${d.price_tier || "-"} • Stock: ${d.stock || "-"}</div>
      <div>Match: ${d.match_quality || "-"} • CPI: ${d.avg_cpi_score || "-"}</div>
      <div>ID: ${d.id || "-"}</div>
      <div>Last campaign: ${d.last_campaign || "-"}</div>
    `;
    document.body.appendChild(tooltipEl);
    const r = el.getBoundingClientRect();
    let x = r.right + 8, y = r.top;
    const w = tooltipEl.offsetWidth || 220, h = tooltipEl.offsetHeight || 120;
    if (x + w > window.innerWidth - 8) x = Math.max(8, r.left - w - 8);
    if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
    tooltipEl.style.left = `${x}px`;
    tooltipEl.style.top = `${y}px`;
    tooltipEl.style.position = "fixed";
  }
  function hideWineTooltip() { if (tooltipEl?.parentNode) tooltipEl.parentNode.removeChild(tooltipEl); tooltipEl = null; }

  // ===== Context menu (Move / Delete) =====
  function destroyContextMenu() { if (ctxMenuEl?.parentNode) ctxMenuEl.parentNode.removeChild(ctxMenuEl); ctxMenuEl = null; }

  function showWineContextMenu(cardEl, x, y) {
    destroyContextMenu();
    const doc = cardEl.ownerDocument || document;
    const win = doc.defaultView || window;
    
    // Get current card data to show tag states
    const wineData = extractWineData(cardEl);
    const currentTags = wineData.reason_payload?.tags || [];
    
    ctxMenuEl = doc.createElement("div");
    ctxMenuEl.className = "context-menu";
    ctxMenuEl.innerHTML = `
      <ul role="menu" aria-label="Wine actions">
        <li role="menuitem" data-act="duplicate">Duplicate in this week</li>
        <li role="menuitem" data-act="move">Move to week…</li>
        <li role="menuitem" data-act="delete" class="danger">Remove from this week</li>
        <li class="menu-separator"></li>
        <li class="color-menu-item">
          <span>Card Color:</span>
          <div class="color-options">
            <div class="color-option gold" data-color="gold" title="Gold"></div>
            <div class="color-option green" data-color="green" title="Green (Default)"></div>
            <div class="color-option silver" data-color="silver" title="Silver"></div>
            <div class="color-option red" data-color="red" title="Red"></div>
            <div class="color-option turquoise" data-color="turquoise" title="Turquoise"></div>
          </div>
        </li>
        <li class="menu-separator"></li>
        <li class="time-menu-item">
          <span>🕒 Schedule Time:</span>
          <select class="time-select" data-act="time">
            <option value="">No time set</option>
            <option value="09:00">9:00</option>
            <option value="09:30">9:30</option>
            <option value="10:00">10:00</option>
            <option value="10:30">10:30</option>
            <option value="11:00">11:00</option>
            <option value="11:30">11:30</option>
            <option value="12:00">12:00</option>
            <option value="12:30">12:30</option>
            <option value="13:00">13:00</option>
            <option value="13:30">13:30</option>
            <option value="14:00">14:00</option>
            <option value="14:30">14:30</option>
            <option value="15:00">15:00</option>
            <option value="15:30">15:30</option>
            <option value="16:00">16:00</option>
            <option value="16:30">16:30</option>
            <option value="17:00">17:00</option>
            <option value="17:30">17:30</option>
            <option value="18:00">18:00</option>
            <option value="18:30">18:30</option>
            <option value="19:00">19:00</option>
            <option value="19:30">19:30</option>
            <option value="20:00">20:00</option>
            <option value="20:30">20:30</option>
          </select>
        </li>
        <li class="menu-separator"></li>
        <li class="tag-menu-item">
          <span>Tags:</span>
          <div class="tag-options">
            <div class="tag-option ${currentTags.includes('CH') ? 'selected' : ''}" data-tag="CH" title="Switzerland"><span class="fi fi-ch"></span></div>
            <div class="tag-option ${currentTags.includes('EU') ? 'selected' : ''}" data-tag="EU" title="European Union"><span class="fi fi-eu"></span></div>
            <div class="tag-option" data-tag="W" title="World">�</div>
            <div class="tag-option ${currentTags.includes('BDG') ? 'selected' : ''}" data-tag="BDG" title="Budget">⬇️</div>
            <div class="tag-option ${currentTags.includes('BIG') ? 'selected' : ''}" data-tag="BIG" title="Big Size">🅱️</div>
          </div>
        </li>
      </ul>
    `;
    doc.body.appendChild(ctxMenuEl);
    const vw = win.innerWidth, vh = win.innerHeight;
    const r = ctxMenuEl.getBoundingClientRect();
    const left = Math.min(Math.max(6, x), vw - r.width - 6);
    const top = Math.min(Math.max(6, y), vh - r.height - 6);
    Object.assign(ctxMenuEl.style, { left: `${left}px`, top: `${top}px`, position: "fixed" });

    ctxMenuEl.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-act]");
      const colorOption = e.target.closest(".color-option");
      
      if (colorOption) {
        // Handle color selection
        const color = colorOption.dataset.color;
        applyCardColor(cardEl, color);
        destroyContextMenu();
        return;
      }
      
      const timeSelect = e.target.closest(".time-select");
      if (timeSelect) {
        // Prevent event bubbling for time select interactions
        e.stopPropagation();
        return;
      }
      
      if (!li) return;
      const act = li.dataset.act;
      destroyContextMenu();
      if (act === "delete") deleteCardFromCalendar(cardEl);
      if (act === "move") openMoveWeekModal(cardEl);
      if (act === "duplicate") duplicateCardInWeek(cardEl);
      
      // Handle tag option clicks
      const tagOption = e.target.closest(".tag-option");
      if (tagOption) {
        const tag = tagOption.dataset.tag;
        toggleCardTag(cardEl, tag);
        destroyContextMenu();
        return;
      }
    });
    
    // Add dedicated change event listener for time selection
    const timeSelect = ctxMenuEl.querySelector(".time-select");
    if (timeSelect) {
      timeSelect.addEventListener("change", (e) => {
        e.stopPropagation();
        const selectedTime = e.target.value;
        if (selectedTime) {
          setCardScheduleTime(cardEl, selectedTime);
          destroyContextMenu();
        }
      });
    }

    setTimeout(() => {
      const off = (e) => { 
        // Don't close if clicking on time select dropdown or its options
        if (e.target.closest('.time-select') || e.target.closest('option')) return;
        if (ctxMenuEl && !ctxMenuEl.contains(e.target)) destroyContextMenu(); 
      };
      doc.addEventListener("click", off, { once: true });
      win.addEventListener("scroll", destroyContextMenu, { once: true });
      win.addEventListener("resize", destroyContextMenu, { once: true });
      doc.addEventListener("keydown", (e) => { if (e.key === "Escape") destroyContextMenu(); }, { once: true });
    }, 0);
  }

  function setCardScheduleTime(cardEl, timeValue) {
    // Update the card's schedule time
    const wineData = extractWineData(cardEl);
    wineData.schedule_time = timeValue;
    
    // Update dataset attribute for persistence
    if (timeValue) {
      cardEl.dataset.scheduleTime = timeValue;
    } else {
      delete cardEl.dataset.scheduleTime;
    }
    
    // Update the visual display
    let scheduleDisplay = cardEl.querySelector('.schedule-time');
    if (timeValue) {
      if (!scheduleDisplay) {
        scheduleDisplay = document.createElement('div');
        scheduleDisplay.className = 'schedule-time';
        cardEl.appendChild(scheduleDisplay);
      }
      scheduleDisplay.textContent = timeValue;
    } else {
      // Remove schedule time display if no time set
      if (scheduleDisplay) {
        scheduleDisplay.remove();
      }
    }
    
    // Persist the change
    persistLockedCalendarState().catch(() => {});
    persistFullCalendarSnapshot().catch(() => {});
  }

  function generateTagFlags(reasonPayload) {
    if (!reasonPayload || !reasonPayload.tags || reasonPayload.tags.length === 0) {
      return '';
    }
    
    const flagMap = {
      'CH': '<span class="fi fi-ch"></span>',
      'EU': '<span class="fi fi-eu"></span>',
      'US': '<span class="fi fi-us"></span>',
      'W': '🌍',
      'BDG': '⬇️',
      'BIG': '🅱️'
    };
    
    const flags = reasonPayload.tags.map(tag => flagMap[tag] || tag).join(' ');
    return `<div class="tag-flags">${flags}</div>`;
  }
  
  function toggleCardTag(cardEl, tag) {
    // Get current card data
    const wineData = extractWineData(cardEl);
    const reasonPayload = wineData.reason_payload || {};
    const currentTags = reasonPayload.tags || [];
    
    // Toggle the tag
    let newTags;
    if (currentTags.includes(tag)) {
      newTags = currentTags.filter(t => t !== tag);
    } else {
      newTags = [...currentTags, tag];
    }
    
    // Update reason payload
    const newReasonPayload = {
      ...reasonPayload,
      tags: newTags,
      reason: reasonPayload.reason || 'Normal'
    };
    
    // Update card dataset
    cardEl.dataset.reasonPayload = JSON.stringify(newReasonPayload);
    
    // Update visual display by re-rendering the card
    const container = cardEl.parentElement;
    const cardData = {
      ...wineData,
      reason_payload: newReasonPayload
    };
    
    cardEl.remove();
    renderWineIntoBox(container, cardData, { locked: true });
    
    // Persist changes
    persistLockedCalendarState().catch(() => {});
  }

  function openTagManagerForCard(cardEl) {
    // Get current card data
    const wineData = extractWineData(cardEl);
    const currentReasonPayload = wineData.reason_payload || {};
    const currentTags = currentReasonPayload.tags || [];
    
    // Set up the reason dialog but pre-populate with current data
    pendingCardData = wineData;
    pendingCardDay = cardEl.dataset.day || cardEl.closest('.fill-box').dataset.day;
    pendingCardSlot = cardEl.dataset.slot || cardEl.closest('.fill-box').dataset.slot;
    pendingCardLocked = cardEl.dataset.locked === 'true';
    
    // Open the reason dialog
    openReasonDialog();
    
    // Pre-populate the dialog with current values
    const reasonSelect = document.getElementById('reason-select');
    const description = document.getElementById('reason-description');
    const scheduleInput = document.getElementById('schedule-time');
    
    if (reasonSelect && currentReasonPayload.reason) {
      reasonSelect.value = currentReasonPayload.reason;
    }
    if (description && currentReasonPayload.description) {
      description.value = currentReasonPayload.description;
    }
    if (scheduleInput && wineData.schedule_time) {
      scheduleInput.value = wineData.schedule_time;
    }
    
    // Pre-select current tags
    document.querySelectorAll('.tag-btn').forEach(btn => {
      btn.classList.remove('bg-blue-500', 'text-white');
      btn.classList.add('hover:bg-gray-50');
      if (currentTags.includes(btn.dataset.tag)) {
        btn.classList.remove('hover:bg-gray-50');
        btn.classList.add('bg-blue-500', 'text-white');
      }
    });
  }

  function startSearchForThisSlot(cardEl) {
    const cell = cardEl.closest(".fill-box");
    if (!cell) return;
    const d = extractWineData(cardEl);
    openQuickAdd(cell.dataset.day, parseInt(cell.dataset.slot, 10));
    setTimeout(() => {
      if (qa?.input) {
        qa.input.value = d.name || "";
        qa.input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (qa?.vintage && d.vintage) {
        const opt = Array.from(qa.vintage.options).find(o => o.value === d.vintage);
        if (opt) qa.vintage.value = d.vintage;
      }
    }, 30);
  }

  function toggleCardLock(card) {
    const nowLocked = !(card.dataset.locked === "true");
    card.dataset.locked = nowLocked ? "true" : "false";
    const badge = card.querySelector(".badge");
    if (badge) badge.textContent = nowLocked ? "Locked" : "Auto";
    const icon = card.querySelector(".lock-icon i");
    if (icon) {
      icon.classList.toggle("fa-lock", nowLocked);
      icon.classList.toggle("fa-lock-open", !nowLocked);
      card.querySelector(".lock-icon")?.setAttribute("title", nowLocked ? "Unlock" : "Lock");
      card.querySelector(".lock-icon")?.setAttribute("aria-pressed", String(nowLocked));
    }
    persistLockedCalendarState().catch(console.warn);
    persistFullCalendarSnapshot().catch(console.warn);
    recalcAndUpdateGauge({ animate: true });
  }

  // ===== Move-to-week modal (Year + Week) =====
  function openMoveWeekModal(cardEl) {
    const d = extractWineData(cardEl);
    const thisISO = isoNowEurope();

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="mv-title">
        <h3 id="mv-title">Move to ISO week</h3>
        <p class="mb-3">Wine: <strong>${d.name}</strong> (${d.vintage})</p>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="mv-year">Select year</label>
            <select id="mv-year" class="w-full p-2 rounded-md bg-gray-700 text-white border border-gray-600 focus:outline-none focus:ring-2 focus:ring-yellow-500" aria-label="Select ISO year">
              ${[currentYear - 1, currentYear, currentYear + 1].map(y => `<option value="${y}" ${y === currentYear ? "selected" : ""}>${y}</option>`).join("")}
            </select>
          </div>
          <div>
            <label for="mv-week">Select week</label>
            <select id="mv-week" class="w-full p-2 rounded-md bg-gray-700 text-white border border-gray-600 focus:outline-none focus:ring-2 focus:ring-yellow-500" aria-label="Select ISO week">
              ${Array.from({ length: 53 }, (_, i) => i + 1).map(w => `<option value="${w}" ${w === thisISO.week ? "selected" : ""}>Week ${w}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="modal-buttons" style="margin-top:1rem">
          <button id="mv-confirm" class="confirm-btn" type="button">Move & lock</button>
          <button id="mv-cancel" class="cancel-btn" type="button">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector("#mv-cancel")?.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } });

    overlay.querySelector("#mv-confirm")?.addEventListener("click", async () => {
      const wk = parseInt(overlay.querySelector("#mv-week").value, 10);
      const yr = parseInt(overlay.querySelector("#mv-year").value, 10);
      await moveCardToWeek(cardEl, yr, wk);
      close();
    });
  }

  async function moveCardToWeek(cardEl, year, week) {
    const d = extractWineData(cardEl);
    if (!Number.isFinite(week) || week < 1 || week > 53) return;
    if (!Number.isFinite(year)) return;

    // de-dupe on target YEAR/WEEK
    const existing = await fetchLockedForWeek(week, year);
    const existsAlready = Object.values(existing || {}).some(arr =>
      (arr || []).some(x => x && makeKey(x.id || x.wine, x.vintage, x.wine) === makeKey(d.id || d.name, d.vintage, d.name))
    );
    if (existsAlready) { alert(`That wine (${d.name} ${d.vintage}) already exists in ${year}-W${week}.`); return; }

    const targetDay = d.day || "Monday";
    try {
      const normLocks = normalizeLocked(existing);
      const slots = normLocks[targetDay] || Array(NUM_SLOTS).fill(null);
      let placed = false;
      for (let i = 0; i < NUM_SLOTS; i++) {
        if (slots[i] == null) {
          slots[i] = { id: d.id || null, wine: d.name || d.wine || "", vintage: d.vintage || "", locked: true, slot: i };
          placed = true;
          break;
        }
      }
      if (!placed) { alert(`No free slots on ${targetDay} (${year}-W${week}). Try another day.`); return; }
      const payload = { ...normLocks, [targetDay]: slots };
      await postJSON(URLS.locked, { year, week, locked_calendar: payload });

      deleteCardFromCalendar(cardEl, { silent: true });
      await persistLockedCalendarState();
      await persistFullCalendarSnapshot();
      recalcAndUpdateGauge({ animate: true });

      alert(`Moved to ${year}-W${week}, ${targetDay} (locked).`);
    } catch (e) {
      console.error(e);
      alert("Move failed (see console).");
      recalcAndUpdateGauge({ animate: true });
    }
  }

  function deleteCardFromCalendar(cardEl, { silent = false } = {}) {
    const parentBox = cardEl.closest(".fill-box");
    cardEl.remove();
    if (parentBox && !parentBox.querySelector(".wine-box")) {
      parentBox.classList.remove("filled");
      parentBox.classList.add("empty");
    }
    if (selectedWineEl === cardEl) {
      selectedWineEl = null;
      selectedWineData = null;
      sessionStorage.removeItem("selectedWine");
      setOfferButtonsEnabled(false);
      notifySelectedWine(null).catch(() => {});
    }
    persistLockedCalendarState().catch(console.warn);
    persistFullCalendarSnapshot().catch(console.warn);
    recalcAndUpdateGauge({ animate: true });
  }

  function duplicateCardInWeek(cardEl) {
    const d = extractWineData(cardEl);
    const currentDay = d.day;
    
    // Find an empty slot in the current week (try all days)
    let targetBox = null;
    let targetDay = null;
    let targetSlot = null;
    
    // First, try to find an empty slot in the same day
    for (let i = 0; i < NUM_SLOTS; i++) {
      const box = document.querySelector(`.fill-box[data-day="${currentDay}"][data-slot="${i}"]`);
      if (box && !box.querySelector(".wine-box")) {
        targetBox = box;
        targetDay = currentDay;
        targetSlot = i;
        break;
      }
    }
    
    // If no empty slot in same day, try other days
    if (!targetBox) {
      for (const day of DAYS) {
        if (day === currentDay) continue; // Already checked
        for (let i = 0; i < NUM_SLOTS; i++) {
          const box = document.querySelector(`.fill-box[data-day="${day}"][data-slot="${i}"]`);
          if (box && !box.querySelector(".wine-box")) {
            targetBox = box;
            targetDay = day;
            targetSlot = i;
            break;
          }
        }
        if (targetBox) break;
      }
    }
    
    if (!targetBox) {
      alert("No empty slots available in this week to duplicate the wine.");
      return;
    }
    
    // Create a duplicate item object with the same data but generate a new unique ID
    const duplicateItem = {
      id: null, // Will be auto-generated in renderWineIntoBox
      wine: d.name,
      name: d.name,
      vintage: d.vintage,
      full_type: d.full_type || d.type,
      type: d.type,
      stock: d.stock,
      price_tier: d.price_tier,
      loyalty_level: d.loyalty_level,
      region_group: d.region_group,
      match_quality: d.match_quality,
      avg_cpi_score: d.avg_cpi_score,
      last_campaign: d.last_campaign,
      locked: false, // Start as unlocked by default
      custom_card: d.customCard === "true",
      card_color: d.cardColor, // Preserve the current color as default
      reason_payload: d.reason_payload // Preserve existing reason/tags if any
    };
    
    // Show duplicate dialog instead of directly placing the card
    showDuplicateDialog(duplicateItem, targetDay, targetSlot, targetBox);
  }

  function normalizeLocked(locks) {
    const out = {};
    DAYS.forEach((d) => {
      const arr = Array.isArray(locks?.[d]) ? locks[d].slice(0, NUM_SLOTS) : [];
      while (arr.length < NUM_SLOTS) arr.push(null);
      out[d] = arr.map((x) => (x && typeof x === "object" ? x : null));
    });
    return out;
  }

  // ===== Snapshot persistence (full calendar: locked + auto) =====
  function readDOMFullState() {
    const out = {};
    DAYS.forEach((day) => {
      const slots = [];
      for (let i = 0; i < NUM_SLOTS; i++) {
        const box = document.querySelector(`.fill-box[data-day="${day}"][data-slot="${i}"]`);
        const card = box?.querySelector(".wine-box");
        if (!card) { slots.push(null); continue; }
        slots.push({
          id: card.dataset.id || null,
          wine: card.dataset.name || "",
          vintage: card.dataset.vintage || "",
          full_type: card.dataset.type || undefined,
          region_group: card.dataset.region || undefined,
          stock: card.dataset.stock ? Number(card.dataset.stock) : undefined,
          price_tier: card.dataset.priceTier || undefined,
          match_quality: card.dataset.matchQuality || undefined,
          avg_cpi_score: card.dataset.cpiScore || undefined,
          locked: card.dataset.locked === "true",
          custom_card: card.dataset.customCard === "true" || undefined,
          card_color: card.dataset.cardColor || undefined
        });
      }
      out[day] = slots;
    });
    return out;
  }

  async function persistFullCalendarSnapshot(year = currentYear, week = currentWeek) {
    const snap = readDOMFullState();
    try { sessionStorage.setItem(weekSnapKey(year, week), JSON.stringify(snap)); } catch {}
  }

  function loadFullCalendarSnapshot(year, week) {
    try {
      const raw = sessionStorage.getItem(weekSnapKey(year, week));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  // ===== Locked calendar persistence (server + local backup) =====
  function readDOMLockedState() {
    const out = {};
    
    // Handle regular day columns
    $all(".day-column").forEach((col) => {
      const day = col.querySelector(".day-name")?.textContent?.trim();
      if (!day) return;
      const slots = [];
      $all(".fill-box", col).forEach((box, idx) => {
        const card = box.querySelector(".wine-box[data-locked='true']");
        if (!card) { slots.push(null); return; }
        slots.push({
          id: card.dataset.id || null,
          wine: card.dataset.name || "",
          vintage: card.dataset.vintage || "",
          full_type: card.dataset.type || undefined,
          region_group: card.dataset.region || undefined,
          stock: Number(card.dataset.stock || 0),
          price_tier: card.dataset.priceTier || undefined,
          locked: true,
          slot: idx,
          custom_card: card.dataset.customCard === "true" || undefined,
          card_color: card.dataset.cardColor || undefined,
          reason_payload: card.dataset.reasonPayload ? JSON.parse(card.dataset.reasonPayload) : undefined,
          schedule_time: card.dataset.scheduleTime || undefined
        });
      });
      out[day] = slots;
    });
    
    // Handle leads boxes
    $all(".leads-box").forEach((box) => {
      const day = box.dataset.day;
      if (!day) return;
      const slots = [];
      $all(".wine-box[data-locked='true']", box).forEach((card, idx) => {
        slots.push({
          id: card.dataset.id || null,
          wine: card.dataset.name || "",
          vintage: card.dataset.vintage || "",
          full_type: card.dataset.type || undefined,
          region_group: card.dataset.region || undefined,
          stock: Number(card.dataset.stock || 0),
          price_tier: card.dataset.priceTier || undefined,
          locked: true,
          slot: idx,
          custom_card: card.dataset.customCard === "true" || undefined,
          card_color: card.dataset.cardColor || undefined,
          reason_payload: card.dataset.reasonPayload ? JSON.parse(card.dataset.reasonPayload) : undefined,
          schedule_time: card.dataset.scheduleTime || undefined
        });
      });
      if (slots.length > 0) {
        out[day] = slots;
      }
    });
    
    return out;
  }

  async function persistLockedCalendarState(year = currentYear, week = currentWeek) {
    const payload = readDOMLockedState();
    try {
      await postJSON(URLS.locked, { year, week, locked_calendar: payload });
    } catch (e) {
      console.error("Failed to persist locked calendar:", e);
    } finally {
      try { sessionStorage.setItem(weekLockedKey(year, week), JSON.stringify(payload)); } catch {}
    }
  }

  async function fetchLockedForWeek(week, year = currentYear) {
    const key = weekLockedKey(year, week);
    // Try server (year+week)
    try {
      const j = await getJSON(`${URLS.locked}?year=${encodeURIComponent(year)}&week=${encodeURIComponent(week)}`);
      const data = j.locked_calendar || {};
      if (data && Object.keys(data).length) {
        try { sessionStorage.setItem(key, JSON.stringify(data)); } catch {}
        return data;
      }
    } catch {}
    // Back-compat: try week-only
    try {
      const j = await getJSON(`${URLS.locked}?week=${encodeURIComponent(week)}`);
      const data = j.locked_calendar || {};
      if (data && Object.keys(data).length) {
        try { sessionStorage.setItem(key, JSON.stringify(data)); } catch {}
        return data;
      }
    } catch {}
    // Local cache
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  async function fetchDefaultScheduleForWeek(week, year = currentYear) {
    // Try year+week
    try {
      const res = await fetch(`${URLS.schedule}?year=${encodeURIComponent(year)}&week=${encodeURIComponent(week)}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        return data.weekly_calendar || data;
      }
    } catch {}
    // Back-compat: week-only
    try {
      const res = await fetch(`${URLS.schedule}?week=${encodeURIComponent(week)}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        return data.weekly_calendar || data;
      }
    } catch {}
    return null;
  }

  async function getLeadsForWeek(week, year = currentYear) {
    // Try year+week
    try {
      const res = await fetch(`${URLS.leads}?year=${encodeURIComponent(year)}&week=${encodeURIComponent(week)}`, { cache: "no-store" });
      if (res.ok) return res.json();
    } catch {}
    // Back-compat: week-only
    try {
      const res = await fetch(`${URLS.leads}?week=${encodeURIComponent(week)}`, { cache: "no-store" });
      if (res.ok) return res.json();
    } catch {}
    return null;
  }

  async function fetchAndRenderLeads(week = currentWeek, year = currentYear) {
    try {
      const leads = await getLeadsForWeek(week, year);
      renderLeadsFromData(leads);
    } catch (e) {
      console.error("Error fetching leads:", e);
    }
  }

  function renderLeadsFromData(leads) {
    if (!leads) return;
    const leadsKeys = { "Leads (Tuesday–Wednesday)": "TueWed", "Leads (Thursday–Friday)": "ThuFri" };
    for (const label in leadsKeys) {
      const dayKey = leadsKeys[label];
      const items = leads[dayKey] || [];
      const box = $(`[data-day="${label}"]`);
      if (!box) continue;

      const overflow = box;
      overflow.innerHTML = `<div class="leads-label"><i class="fa-solid fa-bullhorn"></i> ${label}</div>`;

      items.forEach(item => {
        if (!item) return;
        const el = renderWineIntoBox(overflow, item, { locked: !!item.locked });
        if (el) attachWineBoxDragHandlers(el);
      });
      if (items.length > 0) overflow.classList.add("active", "filled");
      else overflow.classList.remove("active", "filled");
    }
  }

  function collectCurrentKeys() {
    const keys = new Set();
    $all(".wine-box").forEach((el) => { keys.add(makeKey(el.dataset.id, el.dataset.vintage, el.dataset.name)); });
    return keys;
  }

  function renderLockedOnlyFromData(locks) {
    let placed = false;
    const keys = collectCurrentKeys();
    
    // Handle regular day slots
    DAYS.forEach((day) => {
      const arr = Array.isArray(locks?.[day]) ? locks[day] : [];
      arr.slice(0, NUM_SLOTS).forEach((it, idx) => {
        if (!it) return;
        const k = makeKey(it.id || it.wine, it.vintage, it.wine);
        if (keys.has(k)) return;
        const box = document.querySelector(`.fill-box[data-day="${day}"][data-slot="${idx}"]`);
        if (!box) return;
        renderWineIntoBox(box, {
          id: it.id ?? it.wine_id ?? "",
          wine: it.wine ?? it.name ?? "Unknown",
          vintage: it.vintage ?? "NV",
          locked: true,
          full_type: it.full_type,
          region_group: it.region_group,
          stock: it.stock ?? it.stock_count,
          price_tier: it.price_tier ?? it.tier,
          match_quality: it.match_quality,
          avg_cpi_score: it.avg_cpi_score,
          reason_payload: it.reason_payload,
          schedule_time: it.schedule_time,
          custom_card: it.custom_card,
          card_color: it.card_color
        }, { locked: true });
        keys.add(k);
        placed = true;
      });
    });
    
    // Handle leads boxes
    Object.keys(locks).forEach((day) => {
      if (DAYS.includes(day)) return; // Skip regular days, already handled above
      
      const arr = Array.isArray(locks[day]) ? locks[day] : [];
      const leadsBox = document.querySelector(`.leads-box[data-day="${day}"]`);
      if (!leadsBox) return;
      
      arr.forEach((it, idx) => {
        if (!it) return;
        const k = makeKey(it.id || it.wine, it.vintage, it.wine);
        if (keys.has(k)) return;
        
        renderWineIntoBox(leadsBox, {
          id: it.id ?? it.wine_id ?? "",
          wine: it.wine ?? it.name ?? "Unknown",
          vintage: it.vintage ?? "NV",
          locked: true,
          full_type: it.full_type,
          region_group: it.region_group,
          stock: it.stock ?? it.stock_count,
          price_tier: it.price_tier ?? it.tier,
          match_quality: it.match_quality,
          avg_cpi_score: it.avg_cpi_score,
          reason_payload: it.reason_payload,
          schedule_time: it.schedule_time,
          custom_card: it.custom_card,
          card_color: it.card_color
        }, { locked: true });
        keys.add(k);
        placed = true;
      });
    });
    
    recalcAndUpdateGauge({ animate: false });
    return placed;
  }

  function renderDefaultScheduleFromData(calendar) {
    if (!calendar) return false;
    const filteredCal = filterCalendarByUIFilters(calendar, mapUIFiltersForBackend());
    let placed = false;
    const keys = collectCurrentKeys();
    DAYS.forEach((day) => {
      const arr = Array.isArray(filteredCal?.[day]) ? filteredCal[day] : [];
      arr.slice(0, NUM_SLOTS).forEach((it, idx) => {
        if (!it) return;
        const k = makeKey(it.id || it.wine || it.name, it.vintage, it.name || it.wine);
        if (keys.has(k)) return;
        const box = document.querySelector(`.fill-box[data-day="${day}"][data-slot="${idx}"]`);
        if (!box) return;
        if (box.querySelector('.wine-box[data-locked="true"]')) return;
        const prevAuto = box.querySelector('.wine-box:not([data-locked="true"])');
        if (prevAuto) prevAuto.remove();
        renderWineIntoBox(box, {
          id: it.id ?? it.wine_id ?? "",
          wine: it.name ?? it.wine ?? "Unknown",
          vintage: it.vintage ?? "NV",
          locked: !!it.locked,
          full_type: it.full_type,
          region_group: it.region_group,
          stock: it.stock ?? it.stock_count,
          price_tier: derivePriceTierLabel(it),
          match_quality: it.match_quality,
          avg_cpi_score: it.avg_cpi_score
        }, { locked: !!it.locked });
        keys.add(k);
        placed = true;
      });
    });
    recalcAndUpdateGauge({ animate: true });
    return placed;
  }

  function fillEmptySlotsFromPool(calendar) {
    if (!calendar) return;
    const filteredCal = filterCalendarByUIFilters(calendar, mapUIFiltersForBackend());
    const used = collectCurrentKeys();
    const pool = [];
    DAYS.forEach((day) => {
      const arr = Array.isArray(filteredCal?.[day]) ? filteredCal[day] : [];
      arr.forEach((it) => {
        if (!it) return;
        const k = makeKey(it.id || it.wine || it.name, it.vintage, it.name || it.wine);
        if (!used.has(k)) pool.push(it);
      });
    });
    if (!pool.length) return;
    const boxes = $all(".fill-box");
    for (const box of boxes) {
      if (box.querySelector(".wine-box")) continue;
      const next = pool.shift();
      if (!next) break;
      renderWineIntoBox(box, {
        id: next.id ?? next.wine_id ?? "",
        wine: next.name ?? next.wine ?? "Unknown",
        vintage: next.vintage ?? "NV",
        locked: !!next.locked,
        full_type: next.full_type,
        region_group: next.region_group,
        stock: next.stock ?? next.stock_count,
        price_tier: derivePriceTierLabel(next),
        match_quality: next.match_quality,
        avg_cpi_score: next.avg_cpi_score
      }, { locked: !!next.locked });
    }
    recalcAndUpdateGauge({ animate: false });
  }

  function renderFullFromData(calendar) {
    clearCalendar();
    buildCalendarSkeleton();
    fetchAndRenderLeads();
    wireCalendarDelegation();
    if (!calendar) return false;
    const keys = new Set();
    let placed = false;
    DAYS.forEach((day) => {
      const arr = Array.isArray(calendar?.[day]) ? calendar[day] : [];
      arr.slice(0, NUM_SLOTS).forEach((it, idx) => {
        if (!it) return;
        const k = makeKey(it.id || it.wine, it.vintage, it.wine);
        if (keys.has(k)) return;
        const box = document.querySelector(`.fill-box[data-day="${day}"][data-slot="${idx}"]`);
        if (!box) return;
        renderWineIntoBox(box, it, { locked: !!it.locked });
        keys.add(k);
        placed = true;
      });
    });
    recalcAndUpdateGauge({ animate: false });
    return placed;
  }

  // ===== Week switching (single, year-aware pipeline) =====
  async function handleWeekYearChange(newYear, newWeek) {
    if (isWeekLoading) return;
    isWeekLoading = true;

    const cal = CAL();
    if (cal) { cal.setAttribute("aria-busy", "true"); cal.classList.add("is-busy"); }

    try {
      const prevYear = currentYear;
      const prevWeek = currentWeek;

      // Persist locks and snapshots of the *previous* week
      if (prevYear && prevWeek && (newYear !== prevYear || newWeek !== prevWeek)) {
        await persistLockedCalendarState(prevYear, prevWeek);
        await persistFullCalendarSnapshot(prevYear, prevWeek);
      }

      currentYear = parseInt(newYear, 10);
      currentWeek = parseInt(newWeek, 10);

      sessionStorage.setItem("selectedYear", String(currentYear));
      sessionStorage.setItem("selectedWeek", String(currentWeek));
      currentActiveWeek = String(currentWeek); // keep legacy var in sync

      clearCalendar();
      buildCalendarSkeleton();
      wireCalendarDelegation();

      await loadCampaignIndex().catch(() => {});

      // First try to load from local snapshot
      const snap = loadFullCalendarSnapshot(currentYear, currentWeek);
      if (snap) {
        renderFullFromData(snap);
      } else {
        // Fallback to server fetch for locked and schedule data
        const [locked, calendar, leads] = await Promise.all([
          fetchLockedForWeek(currentWeek, currentYear),
          fetchDefaultScheduleForWeek(currentWeek, currentYear),
          getLeadsForWeek(currentWeek, currentYear)
        ]);

        if (locked && Object.keys(locked).length) renderLockedOnlyFromData(locked);
        if (calendar) { renderDefaultScheduleFromData(calendar); fillEmptySlotsFromPool(calendar); }
        if (leads) renderLeadsFromData(leads);

        // Persist newly fetched data locally
        await persistLockedCalendarState(currentYear, currentWeek);
        await persistFullCalendarSnapshot(currentYear, currentWeek);
      }

      recalcAndUpdateGauge({ animate: false });
    } catch (error) {
      console.error("Error during week change:", error);
    } finally {
      // Always clear busy state, even if there was an error
      if (cal) { cal.removeAttribute("aria-busy"); cal.classList.remove("is-busy"); }
      isWeekLoading = false;
    }
  }

  // Helper for week selector (keeps current year)
  function handleWeekChange(wk, opts = {}) {
    return handleWeekYearChange(currentYear, parseInt(wk, 10));
  }

  // ===== Quick Add Popover =====
  const qa = { 
    overlay: null, label: null, input: null, list: null, vintage: null, 
    lockBtn: null, unlockBtn: null, closeBtn: null,
    customMode: null, vintageSection: null, customFields: null,
    customVintage: null, customType: null, customRegion: null
  };
  let qaCtx = { day: null, slot: null, catalogHit: null };

  function wireQuickAdd() {
    qa.overlay = $("#qa-overlay");
    qa.label = $("#qa-slot-label");
    qa.input = $("#qa-wine");
    qa.list = $("#qa-suggestions");
    qa.vintage = $("#qa-vintage");
    qa.lockBtn = $("#qa-add-lock");
    qa.unlockBtn = $("#qa-add-unlock");
    qa.closeBtn = $("#qa-close");
    qa.customMode = $("#qa-custom-mode");
    qa.vintageSection = $("#qa-vintage-section");
    qa.customFields = $("#qa-custom-fields");
    qa.customVintage = $("#qa-custom-vintage");
    qa.customType = $("#qa-custom-type");
    qa.customRegion = $("#qa-custom-region");
    
    if (!qa.overlay) return;
    
    qa.closeBtn?.addEventListener("click", closeQuickAdd);
    
    // Custom mode toggle
    qa.customMode?.addEventListener("change", (e) => {
      const isCustom = e.target.checked;
      if (isCustom) {
        qa.vintageSection?.classList.add("hidden");
        qa.customFields?.classList.remove("hidden");
        qa.list.innerHTML = "";
        qa.input.placeholder = "Enter custom wine name...";
      } else {
        qa.vintageSection?.classList.remove("hidden");
        qa.customFields?.classList.add("hidden");
        qa.input.placeholder = "Search wine name…";
      }
    });
    
    qa.input?.addEventListener("input", () => {
      // Skip catalog search if in custom mode
      if (qa.customMode?.checked) {
        qa.list.innerHTML = "";
        qa.vintage.innerHTML = "";
        return;
      }
      const q = qa.input.value.trim();
      if (!q) { qa.list.innerHTML = ""; qa.vintage.innerHTML = ""; return; }
      clearTimeout(qa.input._t);
      qa.input._t = setTimeout(async () => {
        const res = await fetch(`${URLS.catalog}?q=${encodeURIComponent(q)}&limit=15`, { cache: "no-store" }).catch(() => null);
        const data = await res?.json()?.catch(() => null);
        const items = data?.items || [];
        qa.list.innerHTML = items.map(it => `
          <li data-wine="${encodeURIComponent(it.wine)}"
              data-vintages='${JSON.stringify(it.vintages || [])}'
              data-ids='${JSON.stringify(it.ids_by_vintage || {})}'
              data-region="${encodeURIComponent(it.region_group || 'Unknown')}"
              data-type="${encodeURIComponent(it.full_type || 'Unknown')}">
              <strong>${it.wine}</strong>
              <small> – ${it.full_type || 'Unknown'} • ${it.region_group || 'Unknown'}</small>
              <div><small>Vintages: ${(it.vintages || ['NV']).join(', ')}</small></div>
          </li>
        `).join("");
      }, 180);
    });
    qa.list?.addEventListener("click", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      const wine = decodeURIComponent(li.dataset.wine);
      const vintages = safeParse(li.dataset.vintages, []);
      const ids = safeParse(li.dataset.ids, {});
      const full_type = decodeURIComponent(li.dataset.type || "Unknown");
      const region_group = decodeURIComponent(li.dataset.region || "Unknown");
      qaCtx.catalogHit = { wine, ids, full_type, region_group };
      qa.input.value = wine;
      qa.list.innerHTML = "";
      qa.vintage.innerHTML = "";
      const vList = (vintages && vintages.length) ? vintages : ["NV"];
      for (const v of vList) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        qa.vintage.appendChild(opt);
      }
    });
    qa.lockBtn?.addEventListener("click", () => confirmPlacement(true));
    qa.unlockBtn?.addEventListener("click", () => confirmPlacement(false));
  }

  function openQuickAdd(day, slot) {
    if (!qa.overlay) return;
    qaCtx = { day, slot, catalogHit: null };
    qa.label.textContent = `${day}, slot ${Number(slot) + 1}`;
    qa.input.value = "";
    qa.list.innerHTML = "";
    qa.vintage.innerHTML = "";
    qa.customMode.checked = false;
    qa.customVintage.value = "";
    qa.customType.value = "";
    qa.customRegion.value = "";
    qa.vintageSection?.classList.remove("hidden");
    qa.customFields?.classList.add("hidden");
    qa.input.placeholder = "Search wine name…";
    qa.overlay.classList.remove("hidden");
    setTimeout(() => qa.input?.focus(), 20);
  }
  
  function closeQuickAdd() { 
    qa.overlay?.classList.add("hidden");
  }
  window.openQuickAdd = openQuickAdd;

  async function confirmPlacement(lockIt) {
    const day = qaCtx.day, slot = qaCtx.slot;
    const wine = qa.input.value.trim();
    if (!day || slot == null || !wine) return;
    
    const isCustomMode = qa.customMode?.checked;
    let vintage, found, id, item;
    
    if (isCustomMode) {
      // Custom card creation
      vintage = (qa.customVintage.value || "NV").trim();
      const customType = qa.customType.value.trim() || "Custom Wine";
      const customRegion = qa.customRegion.value.trim() || "Unknown";
      
      id = null; // Custom cards don't have IDs from catalog
      found = null;
      
      item = {
        id: null,
        wine,
        vintage,
        full_type: customType,
        region_group: customRegion,
        avg_cpi_score: 0,
        match_quality: lockIt ? "Locked" : "Auto",
        locked: lockIt,
        custom_card: true // Mark as custom
      };
    } else {
      // Regular catalog search
      vintage = (qa.vintage.value || "NV").trim();
      found = (qaCtx.catalogHit && qaCtx.catalogHit.wine === wine) ? qaCtx.catalogHit : null;
      id = found?.ids ? (found.ids[vintage] || null) : null;
      
      item = {
        id, wine, vintage,
        full_type: found?.full_type, region_group: found?.region_group,
        avg_cpi_score: 0, match_quality: lockIt ? "Locked" : "Auto", locked: lockIt
      };
    }
    
    const k = makeKey(id || wine, vintage, wine);
    const keys = collectCurrentKeys();
    if (keys.has(k)) { alert("That wine & vintage already exists in this week."); return; }

    // If we have an ID, fetch full card data including stock and last_campaign_date
    if (id) {
      try {
        const cardRes = await fetch(`/api/card/${id}`, { cache: "no-store" });
        if (cardRes.ok) {
          const fullCard = await cardRes.json();
          if (fullCard && !fullCard.error) {
            // Merge the full card data with our base item
            item = {
              ...item,
              stock: fullCard.stock,
              last_campaign_date: fullCard.last_campaign_date,
              price_tier: fullCard.price_tier,
              avg_cpi_score: fullCard.avg_cpi_score || 0,
              // Keep other fields from full card if they exist
              ...Object.fromEntries(
                Object.entries(fullCard).filter(([key, value]) => 
                  value !== null && value !== undefined && value !== ""
                )
              ),
              // But preserve our overrides
              wine, vintage, match_quality: lockIt ? "Locked" : "Auto", locked: lockIt
            };
          }
        }
      } catch (err) {
        console.warn("Failed to fetch full card data:", err);
        // Continue with basic data if fetch fails
      }
    }

    // Close Quick Add and show Reason Dialog (card will be rendered after reason selection)
    closeQuickAdd();
    showReasonDialog(item, day, slot, lockIt);
  }

  // ===== Reason & Tags Dialog =====
  let pendingCardData = null;
  let pendingCardDay = null;
  let pendingCardSlot = null;
  let pendingCardLocked = false;

  function showReasonDialog(item, day, slot, lockIt) {
    pendingCardData = item;
    pendingCardDay = day;
    pendingCardSlot = slot;
    pendingCardLocked = lockIt;
    
    const dialog = document.getElementById('reasonDialog');
    const wineInfo = document.getElementById('reason-wine-info');
    const reasonSelect = document.getElementById('reason-select');
    const winnerSection = document.getElementById('winner-window-section');
    const description = document.getElementById('reason-description');
    const charCounter = document.getElementById('char-counter');
    
    if (!dialog) return;
    
    // Set wine info
    wineInfo.textContent = `${item.wine || item.name} (${item.vintage}) → ${day}, slot ${Number(slot) + 1}`;
    
    // Reset form
    reasonSelect.value = 'Normal';
    winnerSection.classList.add('hidden');
    description.value = '';
    charCounter.textContent = '0';
    
    // Reset schedule time
    const scheduleInput = document.getElementById('schedule-time');
    if (scheduleInput) scheduleInput.value = '';
    
    // Clear all radio buttons
    document.querySelectorAll('input[name="winner-window"]').forEach(radio => radio.checked = false);
    
    // Clear tag selections
    document.querySelectorAll('.tag-btn').forEach(btn => {
      btn.classList.remove('bg-blue-500', 'text-white');
      btn.classList.add('border-gray-300', 'hover:bg-gray-50');
    });
    
    dialog.classList.remove('hidden');
  }

  function closeReasonDialog() {
    const dialog = document.getElementById('reasonDialog');
    if (dialog) dialog.classList.add('hidden');
    pendingCardData = null;
    pendingCardDay = null;
    pendingCardSlot = null;
    pendingCardLocked = false;
  }

  async function saveReasonAndPlaceCard() {
    if (!pendingCardData) return;
    
    const reasonSelect = document.getElementById('reason-select');
    const description = document.getElementById('reason-description');
    const reason = reasonSelect.value;
    
    let winnerWindow = null;
    if (reason === 'Winner') {
      const checkedRadio = document.querySelector('input[name="winner-window"]:checked');
      if (!checkedRadio) {
        alert('Please select a winner window for Winner reason.');
        return;
      }
      winnerWindow = parseInt(checkedRadio.value);
    }
    
    // Get selected tags
    const tags = [];
    document.querySelectorAll('.tag-btn.bg-blue-500').forEach(btn => {
      tags.push(btn.dataset.tag);
    });
    
    // Get schedule time
    const scheduleInput = document.getElementById('schedule-time');
    const scheduleTime = scheduleInput ? scheduleInput.value : '';
    
    // Create reason payload
    const reasonPayload = {
      reason,
      winner_window: winnerWindow,
      description: description.value.trim(),
      tags
    };
    
    // Add reason payload to item
    const itemWithReason = {
      ...pendingCardData,
      reason_payload: reasonPayload
    };
    
    // Add schedule time to item if provided
    if (scheduleTime) {
      itemWithReason.schedule_time = scheduleTime;
    }
    
    // Auto-set turquoise color for Delayed reason
    if (reason === 'Delayed') {
      itemWithReason.card_color = 'turquoise';
    }
    
    // Now place the card with reason data
    const cell = document.querySelector(`.fill-box[data-day="${pendingCardDay}"][data-slot="${pendingCardSlot}"]`);
    if (cell) {
      const prevAuto = cell.querySelector('.wine-box:not([data-locked="true"])');
      if (prevAuto) prevAuto.remove();
      renderWineIntoBox(cell, itemWithReason, { locked: pendingCardLocked });
    }
    
    await persistLockedCalendarState();
    await persistFullCalendarSnapshot();
    recalcAndUpdateGauge({ animate: true });
    await notifySelectedWine({ ...itemWithReason, day: pendingCardDay, slot: pendingCardSlot }).catch(() => {});
    
    closeReasonDialog();
  }

  // ===== Duplicate Dialog =====
  let pendingDuplicateData = null;
  let pendingDuplicateDay = null;
  let pendingDuplicateSlot = null;
  let pendingDuplicateBox = null;

  function showDuplicateDialog(item, day, slot, targetBox) {
    pendingDuplicateData = item;
    pendingDuplicateDay = day;
    pendingDuplicateSlot = slot;
    pendingDuplicateBox = targetBox;
    
    // Create and show duplicate dialog
    const existingDialog = document.getElementById('duplicateDialog');
    if (existingDialog) existingDialog.remove();
    
    const dialogHtml = `
      <div id="duplicateDialog" class="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
        <div class="bg-white rounded-lg p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-lg font-semibold text-gray-800">🔄 Customize Duplicate Card</h3>
            <button id="duplicateDialog-close" class="text-gray-400 hover:text-gray-600 text-xl font-bold">&times;</button>
          </div>
          
          <!-- Wine Info -->
          <div class="mb-4 p-3 bg-gray-50 rounded-md">
            <div class="text-sm text-gray-600">Duplicating:</div>
            <div class="font-medium text-gray-800">${item.name} (${item.vintage}) → ${day}, slot ${Number(slot) + 1}</div>
          </div>

          <!-- Color Selection -->
          <div class="mb-4">
            <label class="block text-sm font-medium text-gray-700 mb-2">Card Color</label>
            <div class="flex gap-2 flex-wrap">
              <div class="color-option green ${item.card_color === 'green' || !item.card_color ? 'selected' : ''}" data-color="green" title="Green (Default)"></div>
              <div class="color-option silver ${item.card_color === 'silver' ? 'selected' : ''}" data-color="silver" title="Silver"></div>
              <div class="color-option red ${item.card_color === 'red' ? 'selected' : ''}" data-color="red" title="Red"></div>
              <div class="color-option turquoise ${item.card_color === 'turquoise' ? 'selected' : ''}" data-color="turquoise" title="Turquoise"></div>
            </div>
          </div>

          <!-- Reason Selection -->
          <div class="mb-4">
            <label class="block text-sm font-medium text-gray-700 mb-2">Reason</label>
            <select id="duplicate-reason-select" class="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
              <option value="Normal">Normal</option>
              <option value="Recall">Recall</option>
              <option value="Horeca">Horeca</option>
              <option value="EnPrim">EnPrim</option>
              <option value="Winner">Winner (last N days)</option>
            </select>
          </div>

          <!-- Winner Window (conditional) -->
          <div id="duplicate-winner-window-section" class="mb-4 hidden">
            <label class="block text-sm font-medium text-gray-700 mb-2">Winner Window *</label>
            <div class="flex gap-2">
              <label class="flex items-center">
                <input type="radio" name="duplicate-winner-window" value="7" class="mr-1"> 7 days
              </label>
              <label class="flex items-center">
                <input type="radio" name="duplicate-winner-window" value="14" class="mr-1"> 14 days
              </label>
              <label class="flex items-center">
                <input type="radio" name="duplicate-winner-window" value="30" class="mr-1"> 30 days
              </label>
            </div>
          </div>

          <!-- Description -->
          <div class="mb-4">
            <label class="block text-sm font-medium text-gray-700 mb-2">Description (optional)</label>
            <div class="relative">
              <textarea id="duplicate-description" maxlength="80" class="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none" rows="2" placeholder="Brief description..."></textarea>
              <div class="text-xs text-gray-500 mt-1">
                <span id="duplicate-char-counter">0</span>/80 characters
              </div>
            </div>
          </div>

          <!-- Schedule Time -->
          <div class="mb-4">
            <label class="block text-sm font-medium text-gray-700 mb-2">Schedule Time (optional)</label>
            <input type="time" id="duplicate-schedule-time" class="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500" title="Select schedule time" placeholder="e.g., 17:00" min="09:00" max="20:30" step="900" value="${item.schedule_time || ''}">
          </div>

          <!-- Tags -->
          <div class="mb-6">
            <label class="block text-sm font-medium text-gray-700 mb-2">Tags (optional)</label>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="duplicate-tag-btn px-3 py-1 border border-gray-300 rounded-full text-sm hover:bg-gray-50 transition-colors" data-tag="CH">CH</button>
              <button type="button" class="duplicate-tag-btn px-3 py-1 border border-gray-300 rounded-full text-sm hover:bg-gray-50 transition-colors" data-tag="EU">EU</button>
              <button type="button" class="duplicate-tag-btn px-3 py-1 border border-gray-300 rounded-full text-sm hover:bg-gray-50 transition-colors" data-tag="W">🌍</button>
              <button type="button" class="duplicate-tag-btn px-3 py-1 border border-gray-300 rounded-full text-sm hover:bg-gray-50 transition-colors" data-tag="BDG">⬇️ BDG</button>
              <button type="button" class="duplicate-tag-btn px-3 py-1 border border-gray-300 rounded-full text-sm hover:bg-gray-50 transition-colors" data-tag="BIG">🅱️ BIG</button>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex gap-2 justify-end">
            <button id="duplicate-cancel" class="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors">Cancel</button>
            <button id="duplicate-save" class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">Duplicate Card</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', dialogHtml);
    
    const dialog = document.getElementById('duplicateDialog');
    
    // Populate existing values if any
    const existingReason = item.reason_payload?.reason || 'Normal';
    document.getElementById('duplicate-reason-select').value = existingReason;
    
    if (existingReason === 'Winner') {
      document.getElementById('duplicate-winner-window-section').classList.remove('hidden');
      if (item.reason_payload?.winner_window) {
        const radio = document.querySelector(`input[name="duplicate-winner-window"][value="${item.reason_payload.winner_window}"]`);
        if (radio) radio.checked = true;
      }
    }
    
    if (item.reason_payload?.description) {
      const descEl = document.getElementById('duplicate-description');
      descEl.value = item.reason_payload.description;
      document.getElementById('duplicate-char-counter').textContent = item.reason_payload.description.length;
    }
    
    if (item.reason_payload?.tags) {
      item.reason_payload.tags.forEach(tag => {
        const btn = document.querySelector(`[data-tag="${tag}"]`);
        if (btn) {
          btn.classList.remove('border-gray-300', 'hover:bg-gray-50');
          btn.classList.add('bg-blue-500', 'text-white');
        }
      });
    }
    
    // Event listeners
    dialog.querySelector('#duplicateDialog-close').addEventListener('click', closeDuplicateDialog);
    dialog.querySelector('#duplicate-cancel').addEventListener('click', closeDuplicateDialog);
    dialog.querySelector('#duplicate-save').addEventListener('click', saveDuplicateCard);
    
    // Color selection
    dialog.querySelectorAll('.color-option').forEach(option => {
      option.addEventListener('click', (e) => {
        dialog.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
        e.target.classList.add('selected');
      });
    });
    
    // Reason change handler
    dialog.querySelector('#duplicate-reason-select').addEventListener('change', (e) => {
      const winnerSection = dialog.querySelector('#duplicate-winner-window-section');
      if (e.target.value === 'Winner') {
        winnerSection.classList.remove('hidden');
      } else {
        winnerSection.classList.add('hidden');
      }
    });
    
    // Tag selection
    dialog.querySelectorAll('.duplicate-tag-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const isSelected = btn.classList.contains('bg-blue-500');
        if (isSelected) {
          btn.classList.remove('bg-blue-500', 'text-white');
          btn.classList.add('border-gray-300', 'hover:bg-gray-50');
        } else {
          btn.classList.remove('border-gray-300', 'hover:bg-gray-50');
          btn.classList.add('bg-blue-500', 'text-white');
        }
      });
    });
    
    // Character counter
    dialog.querySelector('#duplicate-description').addEventListener('input', (e) => {
      dialog.querySelector('#duplicate-char-counter').textContent = e.target.value.length;
    });
  }

  function closeDuplicateDialog() {
    const dialog = document.getElementById('duplicateDialog');
    if (dialog) dialog.remove();
    pendingDuplicateData = null;
    pendingDuplicateDay = null;
    pendingDuplicateSlot = null;
    pendingDuplicateBox = null;
  }

  async function saveDuplicateCard() {
    if (!pendingDuplicateData || !pendingDuplicateBox) return;
    
    const dialog = document.getElementById('duplicateDialog');
    const reasonSelect = dialog.querySelector('#duplicate-reason-select');
    const description = dialog.querySelector('#duplicate-description');
    const reason = reasonSelect.value;
    
    let winnerWindow = null;
    if (reason === 'Winner') {
      const checkedRadio = dialog.querySelector('input[name="duplicate-winner-window"]:checked');
      if (!checkedRadio) {
        alert('Please select a winner window for Winner reason.');
        return;
      }
      winnerWindow = parseInt(checkedRadio.value);
    }
    
    // Get selected color
    const selectedColorEl = dialog.querySelector('.color-option.selected');
    const selectedColor = selectedColorEl ? selectedColorEl.dataset.color : 'green';
    
    // Get selected tags
    const tags = [];
    dialog.querySelectorAll('.duplicate-tag-btn.bg-blue-500').forEach(btn => {
      tags.push(btn.dataset.tag);
    });
    
    // Get schedule time
    const scheduleInput = dialog.querySelector('#duplicate-schedule-time');
    const scheduleTime = scheduleInput ? scheduleInput.value : '';
    
    // Create reason payload
    const reasonPayload = {
      reason,
      winner_window: winnerWindow,
      description: description.value.trim(),
      tags
    };
    
    // Create the duplicate item with all customizations
    const duplicateItem = {
      ...pendingDuplicateData,
      card_color: selectedColor,
      reason_payload: reasonPayload
    };
    
    // Add schedule time if provided
    if (scheduleTime) {
      duplicateItem.schedule_time = scheduleTime;
    }
    
    // Render the duplicate into the target box
    renderWineIntoBox(pendingDuplicateBox, duplicateItem, { locked: false });
    
    // Update the box state
    pendingDuplicateBox.classList.remove("empty");
    pendingDuplicateBox.classList.add("filled");
    
    // Persist changes
    await persistLockedCalendarState();
    await persistFullCalendarSnapshot();
    recalcAndUpdateGauge({ animate: true });
    
    closeDuplicateDialog();
  }

  function formatScheduleTime(timeString) {
    if (!timeString) return '';
    // If it's already in HH:MM format, return as is
    if (timeString.match(/^\d{1,2}:\d{2}$/)) {
      return timeString;
    }
    // Try to parse as datetime and extract time
    try {
      const date = new Date(timeString);
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: false 
      });
    } catch (e) {
      return timeString; // Return original if can't parse
    }
  }

  function generateReasonBadges(reasonPayload) {
    if (!reasonPayload || reasonPayload.reason === 'Normal') {
      return '';
    }
    
    let reasonBadge = '';
    let tagBadges = '';
    
    // Reason badge with emoji
    const reasonEmojis = {
      'Recall': '↩️',
      'Horeca': '🏨',
      'EnPrim': '🎯',
      'Winner': '🏆'
    };
    
    const reasonEmoji = reasonEmojis[reasonPayload.reason] || '';
    let reasonText = reasonPayload.reason;
    
    if (reasonPayload.reason === 'Winner' && reasonPayload.winner_window) {
      reasonText += ` ${reasonPayload.winner_window}d`;
    }
    
    reasonBadge = `<div class="reason-container"><span class="reason-badge" title="${reasonPayload.description || ''}">${reasonEmoji} ${reasonText}</span></div>`;
    
    // Tags badges
    if (reasonPayload.tags && reasonPayload.tags.length > 0) {
      const tagEmojis = {
        'CH': 'CH', // Switzerland - fallback to text if flags don't work
        'EU': 'EU', // Europe - fallback to text if flags don't work
        'W': '🌍', // World emoji usually works better than flag emojis
        'BDG': '⬇️',
        'BIG': '🅱️'
      };
      
      const tags = reasonPayload.tags.map(tag => {
        const emoji = tagEmojis[tag] || '';
        if (tag === 'W') {
          return `<span class="tag-badge">${emoji}</span>`; // Only show world emoji
        }
        if (tag === 'CH') {
          return `<span class="tag-badge tag-ch">CH</span>`; // Special styling for Switzerland
        }
        if (tag === 'EU') {
          return `<span class="tag-badge tag-eu">EU</span>`; // Special styling for EU
        }
        return `<span class="tag-badge">${emoji}${tag}</span>`;
      }).join('');
      
      tagBadges = `<div class="tags-container">${tags}</div>`;
    }
    
    return reasonBadge + tagBadges;
  }

  // ===== Color System =====
  function applyCardColor(card, color) {
    // Remove existing color classes
    card.classList.remove('color-gold', 'color-green', 'color-silver', 'color-white');
    
    // Add new color class
    if (color !== 'green') { // green is default, no class needed
      card.classList.add(`color-${color}`);
    }
    
    // Store color in dataset for persistence
    card.dataset.cardColor = color;
    
    // Persist the change
    persistFullCalendarSnapshot();
    persistLockedCalendarState();
  }

  // ===== Actions (runs) =====
  async function startFullEngine() {
    if (engineReady) { if (typeof showToast === "function") showToast("Engine already initialized."); return; }
    if (runInFlight) return;
    showStatusPanel();
    setStatus({ message: "Starting full engine…", progress: 0, state: "running" });
    setCalendarInteractivity(false);
    try {
      await postJSON(URLS.runFull, {});
      await pollStatusUntilDone({
        onCompleted: () => {
          engineReady = true;
          sessionStorage.setItem("engineReady", "true");
          updateStartBtnState();
          updateLoadBtnState();
          setFiltersEnabled(true);
        }
      });
    } catch (e) {
      console.error(e);
      setStatus({ message: "Failed to start full engine", progress: 0, state: "error" });
    } finally {
      setCalendarInteractivity(true);
    }
  }

  async function loadNewSchedule() {
    const week = parseInt(getWeekFromUI(), 10);
    const year = currentYear;
    if (!engineReady) { alert("Run Start AVU Engine first. It prepares the data needed for scheduling."); return; }
    if (runInFlight) return;

    const btn = $("#loadScheduleBtn");
    if (btn) btn.disabled = true;

    showStatusPanel();
    setStatus({ message: `⏳ Building schedule for ${year}-W${week}...`, progress: 0, state: "running" });
    $("#status-notebook").textContent = "AVU_schedule_only.ipynb";
    setCalendarInteractivity(false);

    try {
      await postJSON(URLS.runNotebook, {
        mode: "partial",
        calendar_year: year,
        week_number: week,
        filters: mapUIFiltersForBackend(),
        locked_calendar: readDOMLockedState(),
        ui_selection: selectedWineData || null
      });
      await pollStatusUntilDone({ /* refresh handled inside */ });
    } catch (e) {
      console.error(e);
      setStatus({ message: `Failed to start schedule-only run: ${e.message}`, progress: 0, state: "error" });
    } finally {
      setCalendarInteractivity(true);
      updateLoadBtnState();
    }
  }

  // --- Load UI config (IRON_DATA path, optional gauge baselines)
  fetch("/static/config/ui_config.json", { cache: "no-store" })
    .then(r => r.ok ? r.json() : {})
    .then(j => { APP_CFG = j || {}; })
    .catch(() => {});

  // --- Load campaign index (optional; silent if missing) ---
  async function loadCampaignIndex() {
    try {
      const r = await fetch(URLS.campaignIndex, { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      const by_id = j.by_id || j.ids || j.index || {};
      const by_name = j.by_name || j.names || {};
      CAMPAIGN_INDEX = { by_id, by_name };
    } catch { CAMPAIGN_INDEX = { by_id: {}, by_name: {} }; }
  }

  async function runNotebookExplicit(notebook, params = {}, mode = "offer") {
    const body = { mode, notebook, params };
    const res = await fetch(URLS.runNotebook, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Failed to run notebook (${res.status}): ${t}`);
    }
    return true;
  }

  // ===== Gauge helpers =====
  function tierToIndex(tierRaw) {
    if (!tierRaw) return null;
    const t = String(tierRaw).toLowerCase().trim();
    if (PRICE_INDEX[t] != null) return PRICE_INDEX[t];
    if (t.includes("ultra")) return PRICE_INDEX["ultra luxury"];
    if (t.includes("luxury")) return PRICE_INDEX["luxury"];
    if (t.includes("premium")) return PRICE_INDEX["premium"];
    if (t.includes("mid")) return PRICE_INDEX["mid-range"];
    if (t.includes("budget") || t.includes("<") || t.includes("cheap")) return PRICE_INDEX["budget"];
    return null;
  }
  function getSelectedLoyalty() { const act = document.querySelector('#loyalty-group button.active'); return (act?.dataset?.value || "all").toLowerCase(); }
  function getBaselineIndex() {
    const map = (APP_CFG?.priceBaselineByLoyalty) || {};
    const merged = { ...DEFAULT_BASELINES, ...map };
    const key = getSelectedLoyalty();
    return merged[key] != null ? merged[key] : merged["all"];
  }
  function computeCalendarPriceIndex() {
    const cards = Array.from(document.querySelectorAll('#main-calendar-grid .wine-box'));
    if (!cards.length) return { avg: null, n: 0 };
    const nums = [];
    for (const c of cards) {
      const idx = tierToIndex(c.dataset.priceTier || "");
      if (idx != null) nums.push(idx);
    }
    if (!nums.length) return { avg: null, n: 0 };
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    return { avg, n: nums.length };
  }
  function deltaToAngle(delta) { const clamped = Math.max(-1, Math.min(1, delta)); return clamped * 90; }
  function setGaugeAngle(deg) {
    GAUGE.angle = deg;
    if (!GAUGE.dom.needle) GAUGE.dom.needle = document.getElementById("gauge-needle");
    if (GAUGE.dom.needle) GAUGE.dom.needle.setAttribute("transform", `rotate(${deg} 100 100)`);
  }
  function setGaugeTexts({ delta, avg /*, base */ }) {
    const elDelta = document.getElementById("gauge-delta-text");
    if (elDelta) {
      const dir = delta > 0.025 ? "↑ Over" : (delta < -0.025 ? "↓ Under" : "◎ Balanced");
      elDelta.textContent = `${dir} · Δ=${Math.abs(delta).toFixed(2)}`;
    }
    const elVal = document.getElementById("gauge-cpi-value");
    if (elVal) elVal.textContent = (avg != null ? avg : 0).toFixed(2);
  }
  function setGaugeFill(fraction01) {
    const totalLen = 165.645;
    const on = Math.max(0, Math.min(1, fraction01)) * totalLen;
    const off = totalLen - on + 46.412;
    if (!GAUGE.dom.arc) GAUGE.dom.arc = document.getElementById("gauge-fill-arc");
    if (GAUGE.dom.arc) GAUGE.dom.arc.setAttribute("stroke-dasharray", `${on} ${off}`);
  }
  function recalcAndUpdateGauge({ animate = true } = {}) {
    const { avg, n } = computeCalendarPriceIndex();
    const base = getBaselineIndex();
    if (avg == null) {
      setGaugeTexts({ delta: 0, avg: 0, base });
      setGaugeFill(0.2);
      setGaugeAngle(0);
      GAUGE.lastSettleAngle = 0;
      return;
    }
    const delta = avg - base;
    const normDelta = Math.max(-1, Math.min(1, delta / 0.5));
    const target = deltaToAngle(normDelta);
    setGaugeTexts({ delta, avg, base });
    const confidence = Math.max(0.1, Math.min(1, n / 20));
    setGaugeFill(confidence);
    GAUGE.targetAngle = target;
    if (!animate || !GAUGE.oscillate) { setGaugeAngle(target); GAUGE.lastSettleAngle = target; }
  }
  function startGaugeOscillation() {
    if (GAUGE.raf) cancelAnimationFrame(GAUGE.raf);
    GAUGE.oscillate = true;
    GAUGE.startTs = performance.now();
    const tick = (ts) => {
      const t = (ts - GAUGE.startTs) / 1000;
      const wobble = Math.sin(t * 2.2) * 6;
      const ease = GAUGE.angle + (GAUGE.targetAngle - GAUGE.angle) * 0.06;
      setGaugeAngle(ease + wobble);
      GAUGE.raf = requestAnimationFrame(tick);
    };
    GAUGE.raf = requestAnimationFrame(tick);
  }
  function stopGaugeOscillation() {
    GAUGE.oscillate = false;
    if (GAUGE.raf) cancelAnimationFrame(GAUGE.raf);
    GAUGE.raf = null;
    const settle = () => {
      const diff = GAUGE.targetAngle - GAUGE.angle;
      if (Math.abs(diff) < 0.5) { setGaugeAngle(GAUGE.targetAngle); GAUGE.lastSettleAngle = GAUGE.targetAngle; return; }
      setGaugeAngle(GAUGE.angle + diff * 0.15);
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }
  function stabilizeLayout() {}
  function ensureFiltersDock() {
    let dock = document.getElementById("filters-panel");
    if (!dock) dock = document.getElementById("filters-dock");
    if (!dock) {
      const calWrap = document.getElementById("calendar-container") || CAL()?.parentElement;
      if (!calWrap) return;
      dock = document.createElement("section");
      dock.id = "filters-dock";
      calWrap.parentNode?.insertBefore(dock, calWrap);
    }
    const selectors = [
      "#loyalty-group",
      "#price-tier",
      "#wine-type-group",
      "#last-stock-checkbox",
      "#seasonality-checkbox",
      "#bottle-size-slicer, #bigger-size-selector",
      "#pb-size-filter"
    ];
    const wraps = {};
    selectors.forEach(selGroup => {
      const candidates = selGroup.split(",").map(s => s.trim());
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && !dock.contains(el)) {
          const wrap = document.createElement("div");
          wrap.className = "fd-item";
          const label = el.previousElementSibling;
          if (label && label.tagName === "LABEL" && !wrap.contains(label)) wrap.appendChild(label);
          wrap.appendChild(el);
          dock.appendChild(wrap);
          wraps[sel] = wrap;
          break;
        } else if (el && dock.contains(el)) {
          wraps[sel] = el.closest(".fd-item") || el;
        }
      }
    });
    const ptEl = document.querySelector("#price-tier");
    const wtEl = document.querySelector("#wine-type-group");
    const ptWrap = ptEl ? ptEl.closest(".fd-item") : null;
    const wtWrap = wtEl ? wtEl.closest(".fd-item") : null;
    if (dock && ptWrap && wtWrap) {
      dock.insertBefore(ptWrap, wtWrap);
      wtWrap.classList.add("fd-narrow");
      wtWrap.style.maxWidth = "260px";
      wtWrap.style.flex = "0 0 260px";
    }
    injectFiltersCompactToggle(dock);
  }
  function injectFiltersCompactToggle(dock) {
    if (!dock || document.getElementById("filters-compact-btn")) return;
    const btn = document.createElement("button");
    btn.id = "filters-compact-btn";
    btn.type = "button";
    // Set initial text based on current state
    btn.textContent = dock.classList.contains("filters-compact") ? "Show filters" : "Hide filters";
    btn.addEventListener("click", () => {
      dock.classList.toggle("filters-compact");
      btn.textContent = dock.classList.contains("filters-compact") ? "Show filters" : "Hide filters";
    });
    dock.appendChild(btn);
  }

  function safeParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }
  function addLongPress(el, handler, ms = 450) {
    let t = null;
    el.addEventListener("touchstart", (e) => { t = setTimeout(() => handler(e.touches[0]), ms); }, { passive: true });
    el.addEventListener("touchmove", () => { if (t) { clearTimeout(t); t = null; } }, { passive: true });
    el.addEventListener("touchend", () => { if (t) { clearTimeout(t); t = null; } }, { passive: true });
  }
  async function notifySelectedWine(selection) { try { await postJSON(URLS.selectedWine, selection || {}); } catch (e) {} }
  function extractWineData(el) {
    const data = {
      id: el.dataset.id || null,
      name: el.dataset.name || "",
      wine: el.dataset.name || "",
      vintage: el.dataset.vintage || "",
      full_type: el.dataset.type || "",
      type: el.dataset.type || "",
      stock: el.dataset.stock || "",
      price_tier: el.dataset.priceTier || "",
      loyalty_level: el.dataset.loyalty || "",
      region_group: el.dataset.region || "",
      match_quality: el.dataset.matchQuality || "",
      avg_cpi_score: el.dataset.cpiScore || "",
      day: el.dataset.day || "",
      locked: el.dataset.locked === "true",
      last_campaign: el.dataset.lastCampaign || ""
    };
    
    // Add reason payload if present
    if (el.dataset.reasonPayload) {
      try {
        data.reason_payload = JSON.parse(el.dataset.reasonPayload);
      } catch (e) {
        console.warn("Failed to parse reason payload:", e);
      }
    }
    
    // Add schedule time if present
    if (el.dataset.scheduleTime) {
      data.schedule_time = el.dataset.scheduleTime;
    }
    
    // Add custom card flag if present
    if (el.dataset.customCard === "true") {
      data.custom_card = true;
    }
    
    // Add card color if present
    if (el.dataset.cardColor) {
      data.card_color = el.dataset.cardColor;
    }
    
    return data;
  }
  function toggleSelectWine(el) {
    if (selectedWineEl === el) {
      el.classList.remove("selected");
      selectedWineEl = null;
      selectedWineData = null;
      sessionStorage.removeItem("selectedWine");
      setOfferButtonsEnabled(false);
      notifySelectedWine(null).catch(() => {});
    } else {
      if (selectedWineEl) selectedWineEl.classList.remove("selected");
      el.classList.add("selected");
      selectedWineEl = el;
      selectedWineData = extractWineData(el);
      sessionStorage.setItem("selectedWine", JSON.stringify(selectedWineData));
      setOfferButtonsEnabled(true);
      notifySelectedWine(selectedWineData).catch(() => {});
    }
  }

  // ===== Detach (Fullscreen) Calendar =====
  function wireDetachCalendar() {
    const toolbar = $("#weekSelector")?.parentElement;
    if (!toolbar || $("#detachCalendarBtn")) return;
    const btn = document.createElement("button");
    btn.id = "detachCalendarBtn";
    btn.type = "button";
    btn.className = "bg-gray-700 text-white px-3 py-2 rounded hover:bg-gray-600 transition-colors duration-200";
    btn.title = "Detach / Fullscreen calendar";
    btn.setAttribute("aria-label", "Detach calendar to fullscreen");
    btn.textContent = "🗖 Detach";
    toolbar.appendChild(btn);

    btn.addEventListener("click", async () => {
      const container = $("#calendar-container");
      if (!container) return;
      try {
        if (!document.fullscreenElement) {
          await container.requestFullscreen?.({ navigationUI: "hide" });
        } else {
          await document.exitFullscreen?.();
        }
      } catch (e) {
        console.warn("Fullscreen API error:", e);
      }
    });

    document.addEventListener("fullscreenchange", () => {
      const container = $("#calendar-container");
      if (!container) return;
      container.classList.toggle("detached", !!document.fullscreenElement);
      try {
        delegationWired = false;
        wireCalendarDelegation();
        addDropZoneListeners();
      } catch (e) {
        console.warn("Rewire after fullscreen failed:", e);
      }
    });
  }

  // ===== Boot =====
  async function boot() {
    const iso = isoNowEurope();
    currentYear = iso.year;
    currentWeek = iso.week;

    const initialWeek = currentActiveWeek || String(currentWeek);
    const initialYear = sessionStorage.getItem("selectedYear") || String(currentYear);
    populateWeekSelector(initialWeek);
    currentActiveWeek = String(initialWeek);
    currentYear = parseInt(initialYear, 10);
    sessionStorage.setItem("selectedWeek", currentActiveWeek);
    sessionStorage.setItem("selectedYear", String(currentYear));

    await hydrateEngineReady();
    updateStartBtnState();
    updateLoadBtnState();
    ensureFiltersDock();
    setFiltersEnabled(engineReady);

    const styleButtons = $all(".cruise-button-small");
    styleButtons.forEach((b) => {
      const txt = (b.textContent || "").toLowerCase();
      if (txt.includes("cat")) b.dataset.style = "cat";
      if (txt.includes("nigo")) b.dataset.style = "nigo";
    });

    setOfferButtonsEnabled(!!selectedWineData);
    clearCalendar();
    buildCalendarSkeleton();
    wireCalendarDelegation();
    fetchAndRenderLeads(currentWeek, currentYear);
  tryLoadCampaignIndex(); // fire and forget

    const snap = loadFullCalendarSnapshot(currentYear, parseInt(currentActiveWeek, 10));
    if (snap) {
      renderFullFromData(snap);
    } else {
      const locked = await fetchLockedForWeek(parseInt(currentActiveWeek, 10), currentYear);
      if (locked && Object.keys(locked).length) renderLockedOnlyFromData(locked);
    }

    $("#loyalty-group")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      $all("#loyalty-group button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (!engineReady) return;
      markFiltersDirty();
    });

    $("#wine-type-group")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      $all("#wine-type-group button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (!engineReady) return;
      markFiltersDirty();
    });

    $("#bottle-size-slicer")?.addEventListener("change", (e) => {
      const v = e.target.value;
      const bigger = $("#bigger-size-selector");
      if (v === "bigger") {
        if (bigger && !bigger.options.length) {
          [3000, 4500, 6000, 9000, 12000].forEach(ml => {
            const o = document.createElement("option");
            o.value = String(ml);
            o.textContent = `${(ml / 1000).toFixed(1)}L`;
            bigger.appendChild(o);
          });
        }
        bigger?.classList.remove("hidden");
      } else {
        bigger?.classList.add("hidden");
      }
      if (!engineReady) return;
      markFiltersDirty();
    });
    $("#bigger-size-selector")?.addEventListener("change", () => { if (engineReady) markFiltersDirty(); });
    $("#price-tier")?.addEventListener("change", () => { if (engineReady) markFiltersDirty(); });
    $("#last-stock-checkbox")?.addEventListener("change", () => { if (engineReady) markFiltersDirty(); });
    $("#seasonality-checkbox")?.addEventListener("change", () => { if (engineReady) markFiltersDirty(); });

    styleButtons.forEach((b) => {
      b.addEventListener("click", () => {
        const isActive = b.classList.contains("active");
        styleButtons.forEach(x => x.classList.remove("active"));
        if (!isActive) { b.classList.add("active"); }
        if (!engineReady) return;
        markFiltersDirty();
      });
    });

    wireQuickAdd();
    wireDetachCalendar();
    stabilizeLayout();
    recalcAndUpdateGauge({ animate: false });
  }

  // ===== Events =====
  document.addEventListener("DOMContentLoaded", async () => {
    await boot();
    
    // Safety: ensure calendar is not stuck in busy state on page load
    const cal = CAL();
    if (cal) { 
      cal.removeAttribute("aria-busy"); 
      cal.classList.remove("is-busy"); 
    }

    $("#startEngineBtn")?.addEventListener("click", startFullEngine);
    $("#loadScheduleBtn")?.addEventListener("click", loadNewSchedule);

    // Initialize filters toggle button
    const filtersToggleBtn = $("#filters-compact-btn");
    const filtersPanel = $("#filters-panel");
    if (filtersToggleBtn && filtersPanel) {
      filtersToggleBtn.addEventListener("click", () => {
        filtersPanel.classList.toggle("filters-compact");
        filtersToggleBtn.textContent = filtersPanel.classList.contains("filters-compact") ? "Show filters" : "Hide filters";
      });
    }

    // Reason Dialog event listeners
    $("#reasonDialog-close")?.addEventListener("click", closeReasonDialog);
    $("#reason-cancel")?.addEventListener("click", closeReasonDialog);
    $("#reason-save")?.addEventListener("click", saveReasonAndPlaceCard);
    
    // Reason select change handler for Winner window
    $("#reason-select")?.addEventListener("change", (e) => {
      const winnerSection = $("#winner-window-section");
      if (e.target.value === "Winner") {
        winnerSection?.classList.remove("hidden");
      } else {
        winnerSection?.classList.add("hidden");
      }
    });
    
    // Description character counter
    $("#reason-description")?.addEventListener("input", (e) => {
      const counter = $("#char-counter");
      if (counter) counter.textContent = e.target.value.length;
    });
    
    // Tag button handlers
    document.querySelectorAll('.tag-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('bg-blue-500');
        btn.classList.toggle('text-white');
        btn.classList.toggle('border-gray-300');
        btn.classList.toggle('hover:bg-gray-50');
      });
    });
    
    // Close dialog on backdrop click
    $("#reasonDialog")?.addEventListener("click", (e) => {
      if (e.target.id === "reasonDialog") {
        closeReasonDialog();
      }
    });

    // Generate Offer (AUTONOMOUS_AVU_OMT_3.ipynb)
    $("#generateOfferBtn")?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!selectedWineData) { alert("Select a wine first."); return; }
      if (runInFlight) return;
      showStatusPanel();
      setStatus({ message: "Starting AUTONOMOUS_AVU_OMT_3.ipynb…", progress: 0, state: "running" });
      setCalendarInteractivity(false);

      const clientName = document.getElementById("clientName")?.value?.trim() || "Valued Client";
      const inputPath = (APP_CFG?.ironDataPath || "") || "C:\\\\Users\\\\Marco.Africani\\\\OneDrive - AVU SA\\\\AVU CPI Campaign\\\\Puzzle_control_Reports\\\\IRON_DATA";

      try {
        await runNotebookExplicit("AUTONOMOUS_AVU_OMT_3.ipynb", {
          selected_wine: selectedWineData,
          client_name: clientName,
          filters: mapUIFiltersForBackend(),
          input_path: inputPath,
          calendar_year: currentYear,
          week_number: currentWeek
        }, "offer");
        await pollStatusUntilDone({ refreshSchedule: false });
        if (typeof showToast === "function") showToast("✅ Offer generated (HTML saved; draft if Outlook enabled).");
      } catch (err) {
        console.error(err);
        setStatus({ message: `Failed to start notebook: ${err.message}`, progress: 0, state: "error" });
      } finally {
        setCalendarInteractivity(true);
      }
    });

    // Tailor-made Offer
    $("#generateTailorMadeOfferBtn")?.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!selectedWineData) { alert("Select a wine first."); return; }
      if (runInFlight) return;
      showStatusPanel();
      setStatus({ message: "Starting TAILOR_MADE_OFFER.ipynb…", progress: 0, state: "running" });
      setCalendarInteractivity(false);

      const clientName = document.getElementById("clientName")?.value?.trim() || "Valued Client";
      const inputPath = (APP_CFG?.ironDataPath || "") || "C:\\\\Users\\\\Marco.Africani\\\\OneDrive - AVU SA\\\\AVU CPI Campaign\\\\Puzzle_control_Reports\\\\IRON_DATA";

      try {
        await runNotebookExplicit("TAILOR_MADE_OFFER.ipynb", {
          selected_wine: selectedWineData,
          client_name: clientName,
          filters: mapUIFiltersForBackend(),
          input_path: inputPath,
          calendar_year: currentYear,
          week_number: currentWeek
        }, "offer");
        await pollStatusUntilDone({ refreshSchedule: false });
        if (typeof showToast === "function") showToast("✅ Tailor-made offer generated.");
      } catch (err) {
        console.error(err);
        setStatus({ message: `Failed to start notebook: ${err.message}`, progress: 0, state: "error" });
      } finally {
        setCalendarInteractivity(true);
      }
    });

    // Week selector change: keep YEAR, reset filters (UI) and render snapshot/locked only
    $("#weekSelector")?.addEventListener("change", (e) => {
      const wk = String(e.target.value);
      sessionStorage.setItem("selectedWeek", wk);
      resetFiltersToDefault();
      handleWeekChange(wk);
    });
  });

})();
