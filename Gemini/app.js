/* ============================================================
   DeepSeek Peak / Off-Peak Viewer — Modern Engine
   ============================================================ */

(() => {
  "use strict";

  // ---- Configuration & Data --------------------------------
  const PEAK_WINDOWS = [
    [1, 4],   // 01:00–04:00 UTC
    [6, 10],  // 06:00–10:00 UTC
  ];

  const ZONE_CHOICES = [
    "UTC",
    "Asia/Shanghai",
    "Asia/Hong_Kong",
    "Asia/Tokyo",
    "Asia/Seoul",
    "Asia/Singapore",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Europe/Moscow",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Sao_Paulo",
    "Australia/Sydney",
    "Pacific/Auckland",
  ];

  // ---- DOM Selectors ----------------------------------------
  const $ = (id) => document.getElementById(id);

  const DOM = {
    root: document.documentElement,
    tzSelect: $("tzSelect"),
    tzHint: $("tzHint"),
    holidayToggle: $("holidayToggle"),
    statusCard: $("statusCard"),
    statusBadge: $("statusBadge"),
    statusDesc: $("statusDesc"),
    statusRate: $("statusRate"),
    bannerBadge: $("bannerBadge"),
    bannerText: $("bannerText"),
    bannerCount: $("bannerCount"),
    themeColor: $("themeColor"),
    stateAnnounce: $("stateAnnounce"),
    localClock: $("localClock"),
    localDate: $("localDate"),
    utcClock: $("utcClock"),
    utcDate: $("utcDate"),
    nextLabel: $("nextLabel"),
    countdown: $("countdown"),
    nextAt: $("nextAt"),
    week: $("week"),
    weekSub: $("weekSub"),
  };

  // ---- Reactive State ---------------------------------------
  const state = new Proxy(
    {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      manualHoliday: false,
    },
    {
      set(target, prop, val) {
        target[prop] = val;
        renderLoop(true); // Trigger UI sync on state change
        return true;
      },
    }
  );

  // ---- High-Precision Time Engine --------------------------

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
    for (const { type, value } of fmt.formatToParts(date)) {
      if (type !== "literal") out[type] = value;
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

  function effectivePeak(date) {
    if (state.manualHoliday) return false;
    return isPeakUTC(date);
  }

  // ---- Formatters -------------------------------------------

  const fmtClock = (date, timeZone) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);

  const fmtDate = (date, timeZone) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);

  const fmtLocalDateTime = (date, timeZone) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);

  function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return d > 0
      ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`
      : `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  // ---- UI Component Constructors ---------------------------

  function buildZoneOptions() {
    const detected = state.timeZone;
    const zones = Array.from(new Set([detected, ...ZONE_CHOICES])).filter(Boolean);

    DOM.tzSelect.innerHTML = zones
      .map(
        (z) => `<option value="${z}">${z === detected ? `${z} (detected)` : z}</option>`
      )
      .join("");

    DOM.tzSelect.value = detected;
    updateTzHint();
  }

  function updateTzHint() {
    const city = state.timeZone.split("/").pop().replace(/_/g, " ");
    DOM.tzHint.textContent = `Active Viewport: ${city} · ${state.timeZone}`;
  }

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function renderWeek(now) {
    const tz = state.timeZone;
    const todayParts = partsIn(now, tz);
    const todayDow = new Date(
      Date.UTC(+todayParts.year, +todayParts.month - 1, +todayParts.day)
    ).getUTCDay();

    const startWall = new Date(
      Date.UTC(+todayParts.year, +todayParts.month - 1, +todayParts.day - todayDow)
    );
    const startY = startWall.getUTCFullYear();
    const startM = startWall.getUTCMonth() + 1;
    const startD = startWall.getUTCDate();

    const fragment = document.createDocumentFragment();

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
      row.className = `day ${isToday ? "is-today" : ""} ${isWeekend ? "is-weekend" : ""} ${
        isHoliday ? "is-holiday" : ""
      }`;

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
          const endLocal = zonedTimeToUtc(y, m, day, bUTC, 0, tz);

          const dayStart = zonedTimeToUtc(y, m, day, 0, 0, tz);
          const dayEnd = zonedTimeToUtc(y, m, day + 1, 0, 0, tz);

          const s = Math.max(startLocal.getTime(), dayStart.getTime());
          const e = Math.min(endLocal.getTime(), dayEnd.getTime());
          if (e <= s) continue;

          const left = ((s - dayStart.getTime()) / (dayEnd - dayStart)) * 100;
          const width = ((e - s) / (dayEnd - dayStart)) * 100;

          const block = document.createElement("div");
          block.className = "block";
          block.style.left = `${left}%`;
          block.style.width = `${Math.max(width, 0.6)}%`;
          block.title = `${aUTC}:00–${bUTC}:00 UTC`;
          track.appendChild(block);
        }
      }

      if (isToday) {
        const dayStart = zonedTimeToUtc(y, m, day, 0, 0, tz);
        const dayEnd = zonedTimeToUtc(y, m, day + 1, 0, 0, tz);
        const pct = (now.getTime() - dayStart.getTime()) / (dayEnd - dayStart);
        if (pct >= 0 && pct <= 1) {
          const marker = document.createElement("div");
          marker.className = "now-marker";
          marker.style.left = `${pct * 100}%`;
          track.appendChild(marker);
        }
      }

      row.appendChild(track);
      fragment.appendChild(row);
    }

    // Axis
    const axis = document.createElement("div");
    axis.className = "axis";
    const spacer = document.createElement("div");
    const labels = document.createElement("div");
    labels.className = "axis-labels";
    for (let h = 0; h <= 24; h += 6) {
      const s = document.createElement("span");
      s.textContent = `${String(h).padStart(2, "0")}:00`;
      labels.appendChild(s);
    }
    axis.appendChild(spacer);
    axis.appendChild(labels);
    fragment.appendChild(axis);

    DOM.week.replaceChildren(fragment);

    const startLabel = fmtDate(zonedTimeToUtc(startY, startM, startD, 12, 0, tz), tz);
    DOM.weekSub.textContent = `Week of ${startLabel} · Configured for local time`;
  }

  // ---- Status & DOM Sync Engine ----------------------------

  function updateStatus(now) {
    const tz = state.timeZone;
    const peak = effectivePeak(now);
    const currentState = peak ? "peak" : "off-peak";

    // Viewport level state reflection
    if (DOM.root.dataset.state !== currentState) {
      DOM.root.dataset.state = currentState;
      DOM.statusCard.dataset.state = currentState;
      DOM.stateAnnounce.textContent = peak
        ? "Peak hours. Full rates apply."
        : "Off-peak hours. Rates are 50% off.";
    }

    DOM.statusBadge.textContent = peak ? "Peak" : "Off-peak";
    DOM.bannerBadge.textContent = peak ? "Peak hours" : "Off-peak";
    DOM.bannerText.innerHTML = peak
      ? "<strong>Full rate</strong> — paying 2&times; baseline"
      : "<strong>50% off</strong> — discounted pricing active";
    DOM.themeColor.setAttribute("content", peak ? "#ff0055" : "#00f0ff");

    DOM.statusDesc.textContent = state.manualHoliday
      ? "Chinese Public Holiday — Off-peak tier active all day."
      : isPeakUTC(now)
      ? "Inside a UTC peak window — standard rate applies."
      : now.getUTCDay() === 0 || now.getUTCDay() === 6
      ? "UTC Weekend — continuous off-peak discount active."
      : "Outside peak UTC windows — 50% off active.";

    DOM.statusRate.textContent = peak
      ? "PEAK — Standard compute rates apply."
      : "OFF-PEAK — 50% token cost reduction applied.";

    DOM.localClock.textContent = fmtClock(now, tz);
    DOM.localDate.textContent = fmtDate(now, tz);
    DOM.utcClock.textContent = fmtClock(now, "UTC");
    DOM.utcDate.textContent = fmtDate(now, "UTC");

    const next = nextTransitionUTC(now);
    if (next) {
      DOM.nextLabel.textContent = peak ? "Off-peak in" : "Peak in";
      DOM.countdown.textContent = fmtDuration(next.getTime() - now.getTime());
      DOM.nextAt.textContent = `${fmtLocalDateTime(next, tz)} local · ${fmtClock(
        next,
        "UTC"
      )} UTC`;
    } else {
      DOM.nextLabel.textContent = "Next change";
      DOM.countdown.textContent = "—";
      DOM.nextAt.textContent = "—";
    }

    DOM.bannerCount.textContent = `${peak ? "off-peak" : "peak"} in ${
      DOM.countdown.textContent
    }`;
  }

  // ---- Main Loop --------------------------------------------

  let lastDayKey = null;

  function renderLoop(forceRedraw = false) {
    const now = new Date();
    const todayKey = fmtDate(now, state.timeZone);

    if (forceRedraw || todayKey !== lastDayKey) {
      lastDayKey = todayKey;
      renderWeek(now);
    } else {
      renderWeek(now); // Smooth tracking indicator render
    }

    updateStatus(now);
  }

  // ---- Event Handlers ---------------------------------------

  DOM.tzSelect.addEventListener("change", (e) => {
    state.timeZone = e.target.value;
    updateTzHint();
  });

  DOM.holidayToggle.addEventListener("change", (e) => {
    state.manualHoliday = e.target.checked;
  });

  // ---- Boot -------------------------------------------------

  buildZoneOptions();
  renderLoop(true);
  setInterval(() => renderLoop(false), 1000);
})();