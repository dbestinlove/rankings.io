/* ============================================================
   DeepSeek Peak / Off-Peak viewer — supercharged
   Peak (UTC, Mon–Fri): 01:00–04:00 and 06:00–10:00
   Everything else (incl. weekends + CN holidays) = off-peak
   ============================================================ */

(() => {
  "use strict";

  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FINE_POINTER = matchMedia("(pointer: fine)").matches;

  // ---- Configuration ----------------------------------------
  const PEAK_WINDOWS = [
    [1, 4],   // 01:00–04:00 UTC
    [6, 10],  // 06:00–10:00 UTC
  ];

  // Peak prices per 1M tokens (off-peak = exactly half)
  const MODELS = {
    "deepseek-flash":  { label: "DeepSeek-V4.1-Flash",   hit: 0.006, miss: 0.30, out: 1.20 },
    "deepseek-v4-pro": { label: "DeepSeek-V4-Pro-0813",  hit: 0.044, miss: 1.32, out: 3.96 },
  };

  const ZONE_CHOICES = [
    "UTC", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Seoul",
    "Asia/Singapore", "Asia/Kolkata", "Asia/Dubai", "Europe/London",
    "Europe/Paris", "Europe/Berlin", "Europe/Moscow", "America/New_York",
    "America/Chicago", "America/Denver", "America/Los_Angeles",
    "America/Sao_Paulo", "Australia/Sydney", "Pacific/Auckland",
  ];

  const STORE_KEY = "deepseek-hours:v1";

  // ---- DOM refs ---------------------------------------------
  const $ = (id) => document.getElementById(id);

  const tzSelect      = $("tzSelect");
  const tzHint        = $("tzHint");
  const holidayToggle = $("holidayToggle");

  const statusCard    = $("statusCard");
  const statusBadge   = $("statusBadge");
  const statusDesc    = $("statusDesc");
  const statusRate    = $("statusRate");
  const orbitState    = $("orbitState");
  const ringFill      = $("ringFill");

  const root          = document.documentElement;
  const bannerBadge   = $("bannerBadge");
  const bannerText    = $("bannerText");
  const bannerCount   = $("bannerCount");
  const themeColor    = $("themeColor");
  const stateAnnounce = $("stateAnnounce");

  const localClock    = $("localClock");
  const localClockSr  = $("localClockSr");
  const localDate     = $("localDate");
  const utcClock      = $("utcClock");
  const utcClockSr    = $("utcClockSr");
  const utcDate       = $("utcDate");
  const nextLabel     = $("nextLabel");
  const countdown     = $("countdown");
  const countdownSr   = $("countdownSr");
  const nextAt        = $("nextAt");

  const week          = $("week");
  const weekSub       = $("weekSub");
  const tickerTrack   = $("tickerTrack");
  const tooltip       = $("tooltip");

  const RING_LEN = 377; // 2π × 60

  // ---- State ------------------------------------------------
  const state = {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    manualHoliday: false,
    peak: false,
  };

  // Restore persisted prefs
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved) {
      if (typeof saved.tz === "string") {
        try { new Intl.DateTimeFormat("en-US", { timeZone: saved.tz }); state.timeZone = saved.tz; }
        catch { /* invalid zone — keep detected */ }
      }
      state.manualHoliday = !!saved.holiday;
    }
  } catch { /* storage unavailable */ }

  // URL ?tz= overrides storage
  const urlTz = new URLSearchParams(location.search).get("tz");
  if (urlTz) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: urlTz }); state.timeZone = urlTz; } catch {}
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        tz: state.timeZone,
        holiday: state.manualHoliday,
      }));
    } catch {}
    const u = new URL(location.href);
    u.searchParams.set("tz", state.timeZone);
    history.replaceState(null, "", u);
  }

  // ---- Time-zone helpers ------------------------------------

  function partsIn(date, timeZone) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const out = {};
    for (const p of fmt.formatToParts(date)) {
      if (p.type !== "literal") out[p.type] = p.value;
    }
    let h = parseInt(out.hour, 10);
    if (h === 24) h = 0;
    out.hour = String(h).padStart(2, "0");
    return out;
  }

  function zoneOffsetMinutes(date, timeZone) {
    const p = partsIn(date, timeZone);
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return (asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000;
  }

  function zonedTimeToUtc(y, m, d, hh, mm, timeZone) {
    let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
    for (let i = 0; i < 3; i++) {
      const off = zoneOffsetMinutes(new Date(guess), timeZone);
      const next = Date.UTC(y, m - 1, d, hh, mm, 0) - off * 60000;
      if (next === guess) break;
      guess = next;
    }
    return new Date(guess);
  }

  // ---- Peak logic (all in UTC) ------------------------------

  function isPeakUTC(date) {
    const day = date.getUTCDay();
    if (day === 0 || day === 6) return false;
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
    return PEAK_WINDOWS.some(([a, b]) => minutes >= a * 60 && minutes < b * 60);
  }

  function nextTransitionUTC(date) {
    const STEP = 60 * 1000;
    let t = new Date(Math.ceil(date.getTime() / STEP) * STEP);
    const current = isPeakUTC(date);
    const limit = date.getTime() + 7 * 24 * 60 * 60 * 1000;
    while (t.getTime() < limit) {
      if (isPeakUTC(t) !== current) return t;
      t = new Date(t.getTime() + STEP);
    }
    return null;
  }

  /** Previous transition strictly before `date` (for ring progress). */
  function prevTransitionUTC(date) {
    const STEP = 60 * 1000;
    let t = new Date(Math.floor(date.getTime() / STEP) * STEP - STEP);
    const current = isPeakUTC(date);
    const limit = date.getTime() - 7 * 24 * 60 * 60 * 1000;
    while (t.getTime() > limit) {
      if (isPeakUTC(t) !== current) return new Date(t.getTime() + STEP);
      t = new Date(t.getTime() - STEP);
    }
    return null;
  }

  function effectivePeak(date) {
    if (state.manualHoliday) return false;
    return isPeakUTC(date);
  }

  // ---- Formatting -------------------------------------------

  function fmtClock(date, timeZone) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone, hour12: false,
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(date);
  }

  function fmtHM(date, timeZone) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone, hour12: false, hour: "2-digit", minute: "2-digit",
    }).format(date);
  }

  function fmtDate(date, timeZone) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long", day: "numeric", month: "short", year: "numeric",
    }).format(date);
  }

  function fmtLocalDateTime(date, timeZone) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date);
  }

  function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  // ---- Rolling digits -----------------------------------------
  // Each numeric char gets a 0–9 reel; separators stay static.

  function buildDigits(el) {
    el.innerHTML = "";
    return {
      el,
      reels: [],
      text: "",
      set(next) {
        if (next === this.text) return;
        const isDigit = (c) => c >= "0" && c <= "9";
        // rebuild if shape changed (length / separator positions)
        if (next.length !== this.text.length ||
            next.split("").some((c, i) => isDigit(c) !== isDigit(this.text[i]))) {
          this.el.innerHTML = "";
          this.reels = [];
          for (const c of next) {
            if (!isDigit(c)) {
              const s = document.createElement("span");
              s.className = "digit digit--sep";
              s.textContent = c;
              this.el.appendChild(s);
              this.reels.push(null);
            } else {
              const wrap = document.createElement("span");
              wrap.className = "digit";
              const reel = document.createElement("span");
              reel.className = "digit__reel";
              for (let d = 0; d <= 9; d++) {
                const cell = document.createElement("span");
                cell.textContent = d;
                reel.appendChild(cell);
              }
              wrap.appendChild(reel);
              this.el.appendChild(wrap);
              this.reels.push(reel);
            }
          }
        }
        next.split("").forEach((c, i) => {
          const reel = this.reels[i];
          if (reel) {
            reel.style.transform = `translateY(${-parseInt(c, 10) * 1.15}em)`;
          }
        });
        this.text = next;
      },
    };
  }

  const digitsLocal = buildDigits(localClock);
  const digitsUtc   = buildDigits(utcClock);
  const digitsCount = buildDigits(countdown);

  // ---- Time-zone selector ------------------------------------

  function buildZoneOptions() {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const zones = Array.from(new Set([detected, ...ZONE_CHOICES, state.timeZone])).filter(Boolean);

    tzSelect.innerHTML = "";
    for (const z of zones) {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z === detected ? `${z}  (detected)` : z;
      tzSelect.appendChild(opt);
    }
    tzSelect.value = state.timeZone;
    updateTzHint();
  }

  function updateTzHint() {
    const city = state.timeZone.split("/").pop().replace(/_/g, " ");
    tzHint.textContent = `Currently showing: ${city} · ${state.timeZone}`;
  }

  // ---- Ticker -------------------------------------------------

  function buildTicker() {
    const items = [
      "PEAK 01:00–04:00 UTC", "PEAK 06:00–10:00 UTC", "MON–FRI ONLY",
      "WEEKENDS ALWAYS OFF-PEAK", "OFF-PEAK = 50% OF PEAK",
      "CN PUBLIC HOLIDAYS OFF-PEAK",
      "DEEPSEEK-FLASH OUT $0.60/$1.20", "DEEPSEEK-V4-PRO OUT $1.98/$3.96",
    ];
    const half = items.map((t) => `<span class="tk"><i></i>${t}</span>`).join("");
    tickerTrack.innerHTML = half + half; // duplicated for seamless -50% loop
  }

  // ---- Week rendering ----------------------------------------

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function renderWeek(now) {
    const tz = state.timeZone;

    const todayParts = partsIn(now, tz);
    const todayDow = new Date(
      Date.UTC(+todayParts.year, +todayParts.month - 1, +todayParts.day)
    ).getUTCDay();

    const startWall = new Date(Date.UTC(
      +todayParts.year, +todayParts.month - 1, +todayParts.day - todayDow
    ));
    const startY = startWall.getUTCFullYear();
    const startM = startWall.getUTCMonth() + 1;
    const startD = startWall.getUTCDate();

    week.innerHTML = "";

    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.UTC(startY, startM - 1, startD + i));
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const dow = d.getUTCDay();

      const isToday = i === todayDow;
      const isWeekend = dow === 0 || dow === 6;
      const isHoliday = state.manualHoliday && isToday;

      const row = document.createElement("div");
      row.className =
        "day" +
        (isToday ? " is-today" : "") +
        (isWeekend ? " is-weekend" : "") +
        (isHoliday ? " is-holiday" : "");

      const name = document.createElement("div");
      name.className = "day-name";
      name.textContent = DAY_NAMES[dow];
      row.appendChild(name);

      const track = document.createElement("div");
      track.className = "track";

      const ticks = document.createElement("div");
      ticks.className = "ticks";
      for (let h = 3; h < 24; h += 3) {
        const tick = document.createElement("i");
        tick.style.left = `${(h / 24) * 100}%`;
        ticks.appendChild(tick);
      }
      track.appendChild(ticks);

      if (!isWeekend && !isHoliday) {
        for (const [aUTC, bUTC] of PEAK_WINDOWS) {
          const startLocal = zonedTimeToUtc(y, m, day, aUTC, 0, tz);
          const endLocal   = zonedTimeToUtc(y, m, day, bUTC, 0, tz);
          const dayStart   = zonedTimeToUtc(y, m, day, 0, 0, tz);
          const dayEnd     = zonedTimeToUtc(y, m, day + 1, 0, 0, tz);

          const s = Math.max(startLocal.getTime(), dayStart.getTime());
          const e = Math.min(endLocal.getTime(), dayEnd.getTime());
          if (e <= s) continue;

          const left  = ((s - dayStart.getTime()) / (dayEnd - dayStart)) * 100;
          const width = ((e - s) / (dayEnd - dayStart)) * 100;

          const block = document.createElement("div");
          block.className = "block";
          block.style.left = `${left}%`;
          block.style.width = `${Math.max(width, 0.6)}%`;
          block.dataset.tip =
            `PEAK · ${fmtHM(new Date(s), tz)}–${fmtHM(new Date(e), tz)} local ` +
            `· ${aUTC}:00–${bUTC}:00 UTC`;
          track.appendChild(block);
        }
      }

      if (isToday) {
        const dayStart = zonedTimeToUtc(y, m, day, 0, 0, tz);
        const dayEnd   = zonedTimeToUtc(y, m, day + 1, 0, 0, tz);
        const pct = (now.getTime() - dayStart.getTime()) / (dayEnd - dayStart);
        if (pct >= 0 && pct <= 1) {
          const marker = document.createElement("div");
          marker.className = "now-marker";
          marker.style.left = `${pct * 100}%`;
          track.appendChild(marker);
        }
      }

      row.appendChild(track);
      week.appendChild(row);
    }

    const axis = document.createElement("div");
    axis.className = "axis";
    const spacer = document.createElement("div");
    const labels = document.createElement("div");
    labels.className = "axis-labels";
    for (let h = 0; h <= 24; h += 6) {
      const s = document.createElement("span");
      s.textContent = String(h).padStart(2, "0") + ":00";
      labels.appendChild(s);
    }
    axis.appendChild(spacer);
    axis.appendChild(labels);
    week.appendChild(axis);

    const startLabel = fmtDate(zonedTimeToUtc(startY, startM, startD, 12, 0, tz), tz);
    weekSub.textContent = `Week of ${startLabel} · times shown in your local clock`;
  }

  // ---- Block tooltip ------------------------------------------

  function bindTooltip() {
    let active = null;
    week.addEventListener("pointerover", (e) => {
      const b = e.target.closest(".block");
      if (!b || !b.dataset.tip) return;
      active = b;
      tooltip.innerHTML = b.dataset.tip.replace("PEAK", "<b>PEAK</b>");
      tooltip.hidden = false;
    });
    week.addEventListener("pointermove", (e) => {
      if (!active) return;
      const pad = 14;
      const x = Math.min(e.clientX + pad, innerWidth - tooltip.offsetWidth - 8);
      const y = Math.max(e.clientY - tooltip.offsetHeight - pad, 8);
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
    });
    week.addEventListener("pointerout", (e) => {
      if (active && !active.contains(e.relatedTarget)) {
        active = null;
        tooltip.hidden = true;
      }
    });
  }

  // ---- Cost calculator -----------------------------------------

  const calcModel  = $("calcModel");
  const calcInput  = $("calcInput");
  const calcCache  = $("calcCache");
  const calcOutput = $("calcOutput");
  const calcInputOut  = $("calcInputOut");
  const calcCacheOut  = $("calcCacheOut");
  const calcOutputOut = $("calcOutputOut");
  const calcOff    = $("calcOff");
  const calcPeak   = $("calcPeak");
  const calcSave   = $("calcSave");
  const calcVerdict = $("calcVerdict");
  const calcStateWord = $("calcStateWord");

  function buildCalc() {
    calcModel.innerHTML = "";
    for (const [id, m] of Object.entries(MODELS)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = `${id} · ${m.label}`;
      calcModel.appendChild(opt);
    }
    for (const el of [calcModel, calcInput, calcCache, calcOutput]) {
      el.addEventListener("input", updateCalc);
    }
  }

  function sliderFill(el) {
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty("--fill", `${pct}%`);
  }

  // animated money readout (eases toward target each frame)
  const money = { off: 0, peak: 0, save: 0, tOff: 0, tPeak: 0, tSave: 0 };
  function moneyTick() {
    const K = 0.22; // ease factor per frame
    let alive = false;
    for (const [cur, tgt] of [["off", "tOff"], ["peak", "tPeak"], ["save", "tSave"]]) {
      const diff = money[tgt] - money[cur];
      if (Math.abs(diff) > 0.00005) {
        money[cur] += diff * K;
        alive = true;
      } else {
        money[cur] = money[tgt];
      }
    }
    calcOff.textContent  = `$${money.off.toFixed(4)}`;
    calcPeak.textContent = `$${money.peak.toFixed(4)}`;
    calcSave.textContent = `$${Math.abs(money.save).toFixed(4)}`;
    if (alive && !REDUCED) requestAnimationFrame(moneyTick);
  }

  function updateCalc() {
    const m = MODELS[calcModel.value];
    const inTok  = parseFloat(calcInput.value);   // millions
    const cache  = parseFloat(calcCache.value) / 100;
    const outTok = parseFloat(calcOutput.value);  // millions

    calcInputOut.textContent  = `${inTok.toFixed(inTok % 1 ? 2 : 0)}M`;
    calcCacheOut.textContent  = `${calcCache.value}%`;
    calcOutputOut.textContent = `${outTok.toFixed(outTok % 1 ? 2 : 0)}M`;
    sliderFill(calcInput);
    sliderFill(calcCache);
    sliderFill(calcOutput);

    const peakCost =
      inTok * (cache * m.hit + (1 - cache) * m.miss) + outTok * m.out;
    const offCost = peakCost / 2;
    const peakNow = state.peak;

    money.tOff  = offCost;
    money.tPeak = peakCost;
    money.tSave = peakCost - offCost;

    calcVerdict.textContent = peakNow ? "You could save off-peak" : "You save right now";
    calcStateWord.textContent = `current ${peakNow ? "peak" : "off-peak"}`;

    if (REDUCED) {
      money.off = money.tOff; money.peak = money.tPeak; money.save = money.tSave;
      calcOff.textContent  = `$${money.off.toFixed(4)}`;
      calcPeak.textContent = `$${money.peak.toFixed(4)}`;
      calcSave.textContent = `$${Math.abs(money.save).toFixed(4)}`;
    } else {
      requestAnimationFrame(moneyTick);
    }
  }

  // ---- Status card update --------------------------------------

  function updateStatus(now) {
    const tz = state.timeZone;
    const peak = effectivePeak(now);
    const changed = peak !== state.peak;
    state.peak = peak;
    const nextState = peak ? "peak" : "off-peak";

    statusCard.dataset.state = nextState;
    if (root.dataset.state !== nextState) {
      root.dataset.state = nextState;
      stateAnnounce.textContent = peak
        ? "Peak hours. Full rates apply."
        : "Off-peak hours. Rates are 50% off.";
      setFxState(peak);
      if (changed) updateCalc();
    }

    statusBadge.textContent = peak ? "Peak" : "Off-peak";
    orbitState.textContent  = peak ? "PEAK" : "OFF-PEAK";

    bannerBadge.textContent = peak ? "Peak hours" : "Off-peak";
    bannerText.innerHTML = peak
      ? "<strong>Full rate</strong> — you are paying 2&times; right now"
      : "<strong>50% off</strong> — you are in off-peak hours";
    themeColor.setAttribute("content", peak ? "#f87171" : "#22d3ee");

    let desc;
    if (state.manualHoliday) {
      desc = "Chinese public holiday — off-peak all day.";
    } else if (isPeakUTC(now)) {
      desc = "Inside a UTC peak window — full rates apply.";
    } else {
      const utcDow = now.getUTCDay();
      desc = (utcDow === 0 || utcDow === 6)
        ? "Weekend in UTC — always off-peak."
        : "Outside peak windows — 50% off.";
    }
    statusDesc.textContent = desc;

    statusRate.textContent = peak
      ? "PEAK — every token costs 2× the off-peak price."
      : "OFF-PEAK — every token costs half the peak price.";

    // clocks (rolling digits + screen-reader mirrors)
    const lc = fmtClock(now, tz), uc = fmtClock(now, "UTC");
    digitsLocal.set(lc);
    digitsUtc.set(uc);
    localClockSr.textContent = lc;
    utcClockSr.textContent = uc;
    localDate.textContent = fmtDate(now, tz);
    utcDate.textContent   = fmtDate(now, "UTC");

    // next transition + countdown ring
    const next = nextTransitionUTC(now);
    let countText = "—";
    if (next) {
      nextLabel.textContent = peak ? "Off-peak in" : "Peak in";
      countText = fmtDuration(next.getTime() - now.getTime());
      nextAt.textContent = `${fmtLocalDateTime(next, tz)} local · ${fmtClock(next, "UTC")} UTC`;

      const prev = prevTransitionUTC(now);
      if (prev) {
        const span = next.getTime() - prev.getTime();
        const left = next.getTime() - now.getTime();
        const frac = Math.min(Math.max(left / span, 0), 1);
        ringFill.style.strokeDashoffset = String(RING_LEN * (1 - frac));
      }
    } else {
      nextLabel.textContent = "Next change";
      nextAt.textContent = "—";
      ringFill.style.strokeDashoffset = String(RING_LEN);
    }
    digitsCount.set(countText);
    countdownSr.textContent = countText;

    bannerCount.textContent = `${peak ? "off-peak" : "peak"} in ${countText}`;
    document.title = `${peak ? "▲ PEAK" : "● OFF-PEAK"} · ${countText} — DeepSeek hours`;
  }

  // ---- Particle field (canvas ambient) --------------------------
  // Drifting constellation behind everything; palette + energy follow
  // the peak state, lerped so state flips feel like a system alert.

  const fx = $("fx");
  const fctx = fx.getContext("2d");
  const OFF_RGB = [34, 211, 238];   // cyan
  const PEAK_RGB = [248, 113, 113]; // red
  const particles = [];
  const mouse = { x: -9999, y: -9999 };
  let fxColor = [...OFF_RGB];
  let fxEnergy = 1;        // speed/alpha multiplier, eased
  let fxEnergyTarget = 1;
  let fxW = 0, fxH = 0, fxDpr = 1;

  function setFxState(peak) {
    fxEnergyTarget = peak ? 2.1 : 1;
  }

  function fxResize() {
    fxDpr = Math.min(devicePixelRatio || 1, 2);
    fxW = innerWidth;
    fxH = innerHeight;
    fx.width = fxW * fxDpr;
    fx.height = fxH * fxDpr;
    fctx.setTransform(fxDpr, 0, 0, fxDpr, 0, 0);
    seedParticles();
  }

  function seedParticles() {
    particles.length = 0;
    const count = Math.min(110, Math.floor((fxW * fxH) / 16000));
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * fxW,
        y: Math.random() * fxH,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: 0.6 + Math.random() * 1.6,
        ph: Math.random() * Math.PI * 2,
      });
    }
  }

  function fxFrame(t) {
    // ease color + energy toward state targets
    const target = state.peak ? PEAK_RGB : OFF_RGB;
    for (let i = 0; i < 3; i++) fxColor[i] += (target[i] - fxColor[i]) * 0.03;
    fxEnergy += (fxEnergyTarget - fxEnergy) * 0.02;

    const [r, g, b] = fxColor.map((v) => Math.round(v));
    fctx.clearRect(0, 0, fxW, fxH);

    const LINK = 110;
    for (const p of particles) {
      p.x += p.vx * fxEnergy;
      p.y += p.vy * fxEnergy;

      // gentle pointer repulsion
      const dx = p.x - mouse.x, dy = p.y - mouse.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 12000 && d2 > 0.01) {
        const f = (1 - d2 / 12000) * 0.6;
        p.x += (dx / Math.sqrt(d2)) * f;
        p.y += (dy / Math.sqrt(d2)) * f;
      }

      if (p.x < -20) p.x = fxW + 20; else if (p.x > fxW + 20) p.x = -20;
      if (p.y < -20) p.y = fxH + 20; else if (p.y > fxH + 20) p.y = -20;

      const pulse = 0.55 + 0.45 * Math.sin(t * 0.0012 + p.ph);
      fctx.beginPath();
      fctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      fctx.fillStyle = `rgba(${r},${g},${b},${0.28 * pulse * Math.min(fxEnergy, 1.4)})`;
      fctx.fill();
    }

    // constellation links
    fctx.lineWidth = 0.6;
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j++) {
        const c = particles[j];
        const dx = a.x - c.x, dy = a.y - c.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < LINK * LINK) {
          const alpha = (1 - Math.sqrt(d2) / LINK) * 0.1 * Math.min(fxEnergy, 1.5);
          fctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
          fctx.beginPath();
          fctx.moveTo(a.x, a.y);
          fctx.lineTo(c.x, c.y);
          fctx.stroke();
        }
      }
    }
  }

  let fxRunning = false;
  function fxLoop(t) {
    if (!fxRunning) return;
    fxFrame(t);
    requestAnimationFrame(fxLoop);
  }
  function fxStart() {
    if (fxRunning || REDUCED) return;
    fxRunning = true;
    requestAnimationFrame(fxLoop);
  }
  function fxStop() { fxRunning = false; }

  // ---- Custom cursor -------------------------------------------

  function initCursor() {
    if (!FINE_POINTER || REDUCED) return;
    const cursor = $("cursor");
    const pos = { x: innerWidth / 2, y: innerHeight / 2 };
    const tgt = { ...pos };
    let scale = 1, scaleT = 1;
    let seen = false;

    addEventListener("pointermove", (e) => {
      tgt.x = e.clientX; tgt.y = e.clientY;
      mouse.x = e.clientX; mouse.y = e.clientY;
      if (!seen) { pos.x = tgt.x; pos.y = tgt.y; seen = true; cursor.style.opacity = "1"; }
    }, { passive: true });
    addEventListener("pointerleave", () => { mouse.x = mouse.y = -9999; });

    const HOVERABLE = "a, button, select, input, label.check, .block, [data-hover]";
    document.addEventListener("pointerover", (e) => {
      scaleT = e.target.closest(HOVERABLE) ? 1.6 : 1;
    });

    (function loop() {
      pos.x += (tgt.x - pos.x) * 0.18;
      pos.y += (tgt.y - pos.y) * 0.18;
      scale += (scaleT - scale) * 0.16;
      cursor.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      cursor.style.setProperty("--cursor-scale", scale.toFixed(3));
      requestAnimationFrame(loop);
    })();
  }

  // ---- Scroll reveals ------------------------------------------

  function initReveals() {
    const els = document.querySelectorAll("[data-reveal]");
    if (REDUCED || !("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -40px" });
    els.forEach((el) => io.observe(el));
    // safety net: never leave content hidden if an observation stalls
    setTimeout(() => els.forEach((el) => el.classList.add("in")), 1600);
  }

  // ---- Main loop -------------------------------------------------

  let lastMinuteKey = null;

  function tick() {
    const now = new Date();
    const tz = state.timeZone;

    // week only depends on the minute — rebuild on minute/day/holiday change
    const minuteKey = `${fmtLocalDateTime(now, tz)}|${state.manualHoliday}`;
    if (minuteKey !== lastMinuteKey) {
      lastMinuteKey = minuteKey;
      renderWeek(now);
    }

    updateStatus(now);
  }

  // ---- Events ----------------------------------------------------

  tzSelect.addEventListener("change", () => {
    state.timeZone = tzSelect.value;
    updateTzHint();
    lastMinuteKey = null;
    persist();
    tick();
  });

  holidayToggle.checked = state.manualHoliday;
  holidayToggle.addEventListener("change", () => {
    state.manualHoliday = holidayToggle.checked;
    lastMinuteKey = null;
    persist();
    updateCalc();
    tick();
  });

  addEventListener("resize", fxResize, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) fxStop(); else fxStart();
  });

  // ---- Boot -------------------------------------------------------

  buildZoneOptions();
  buildTicker();
  buildCalc();
  bindTooltip();
  initReveals();
  initCursor();
  fxResize();
  fxStart();
  updateCalc();
  tick();
  setInterval(tick, 1000);
})();
