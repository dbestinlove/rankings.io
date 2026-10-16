/* ============================================================================
   Peak Hours — live DeepSeek peak / off-peak pricing clock
   ----------------------------------------------------------------------------
   Rules (all UTC):
     peak = Mon–Fri, 01:00–04:00 and 06:00–10:00
     everything else (incl. weekends + Chinese public holidays) = off-peak (50%)

   Everything below is derived from one engine: peakAt(ms) + nextTransition(ms).
   The render layer is split in two so a 60 fps loop stays cheap:
     • smooth()  — every animation frame (needle, dial dot, cursor, milliseconds)
     • second()  — once per wall-clock second (clocks, countdown, world, title)
   ========================================================================== */

(() => {
  "use strict";

  /* ── constants ─────────────────────────────────────────────────────── */

  const DAY_MS  = 86_400_000;
  const HOUR_MS = 3_600_000;

  /** UTC peak windows, in hours. Half-open: [start, end). */
  const PEAK_WINDOWS = [[1, 4], [6, 10]];

  const ZONE_CHOICES = [
    "UTC",
    "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Seoul",
    "Asia/Singapore", "Asia/Kolkata", "Asia/Dubai",
    "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow",
    "America/New_York", "America/Chicago", "America/Denver",
    "America/Los_Angeles", "America/Sao_Paulo",
    "Australia/Sydney", "Pacific/Auckland",
  ];

  /** Price rows: USD per 1M tokens, `[offPeak, peak]`. Single source of truth. */
  const MODELS = {
    flash: {
      name: "deepseek-flash", full: "DeepSeek-V4.1-Flash", conc: "2,500",
      hit: [0.003, 0.006], miss: [0.15, 0.30], out: [0.60, 1.20],
    },
    pro: {
      name: "deepseek-v4-pro", full: "DeepSeek-V4-Pro-0813", conc: "500",
      hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96],
    },
  };

  const WORLD = [
    { tz: "Asia/Shanghai",    city: "Shanghai" },
    { tz: "Asia/Tokyo",       city: "Tokyo" },
    { tz: "Asia/Kolkata",     city: "Bengaluru" },
    { tz: "Europe/London",    city: "London" },
    { tz: "America/New_York", city: "New York" },
    { tz: "America/Los_Angeles", city: "San Francisco" },
    { tz: "Australia/Sydney", city: "Sydney" },
    { tz: "UTC",              city: "UTC" },
  ];

  const STORAGE_KEY = "peakhours.v2";
  const RING_R = 150;                // dial radius
  const DIAL_C = 180;                // dial centre (in the 360×360 viewBox)

  /* ── DOM ───────────────────────────────────────────────────────────── */

  const $ = (id) => document.getElementById(id);

  const el = {
    root: document.documentElement,
    themeColor: $("themeColor"), favicon: $("favicon"),
    announce: $("stateAnnounce"), glow: $("cursorGlow"),
    burst: $("burstLayer"), toasts: $("toasts"),
    themeBtn: $("themeBtn"),
    bannerBadgeText: $("bannerBadgeText"), bannerCount: $("bannerCount"),
    tzSelect: $("tzSelect"), tzHint: $("tzHint"), holiday: $("holidayToggle"),
    dialCard: $("dialCard"), dialArcs: $("dialArcs"), dialTicks: $("dialTicks"),
    dialNeedle: $("dialNeedle"), dialUtcDot: $("dialUtcDot"),
    dialLabel: $("dialLabel"), dialCount: $("dialCount"), dialMs: $("dialMs"),
    dialDay: $("dialDay"), arcA: $("arcGradA"), arcB: $("arcGradB"),
    ticker: $("tickerTrack"),
    statusCard: $("statusCard"), statusBadge: $("statusBadge"),
    statusDesc: $("statusDesc"), statusRate: $("statusRate"), copyBtn: $("copyBtn"),
    localClock: $("localClock"), localDate: $("localDate"),
    utcClock: $("utcClock"), utcDate: $("utcDate"),
    nextLabel: $("nextLabel"), countdown: $("countdown"), nextAt: $("nextAt"),
    week: $("week"), weekSub: $("weekSub"),
    world: $("worldClocks"), ratesBody: $("ratesBody"),
    hit: $("hitRange"), miss: $("missRange"), out: $("outRange"),
    hitOut: $("hitOut"), missOut: $("missOut"), outOut: $("outOut"),
    costOff: $("costOff"), costPeak: $("costPeak"), costSave: $("costSave"),
    saveLabel: $("saveLabel"), calcNote: $("calcNote"),
    moneyOff: $("moneyOff"), moneyPeak: $("moneyPeak"),
  };

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ── persistent state ──────────────────────────────────────────────── */

  const detectedZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const store = {
    tz: detectedZone,
    holiday: false,
    theme: "dark",
    model: "flash",
    tokens: { hit: 0, miss: 800, out: 250 },
  };

  (function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { /* ignore */ }
    if (!saved || typeof saved !== "object") return;
    if (typeof saved.tz === "string" && saved.tz) store.tz = saved.tz;
    if (typeof saved.theme === "string") store.theme = saved.theme;
    if (saved.model in MODELS) store.model = saved.model;
    const t = saved.tokens;
    if (t && typeof t === "object") {
      for (const k of ["hit", "miss", "out"]) {
        const n = Number(t[k]);
        if (Number.isFinite(n) && n >= 0) store.tokens[k] = n;
      }
    }
  })();

  const persist = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* ignore */ }
  };

  /* ── time-zone maths ───────────────────────────────────────────────── */

  // Intl formatters are expensive to construct, so cache one per zone.
  const partsFmtCache = new Map();
  function partsFmt(tz) {
    let f = partsFmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour12: false, weekday: "short", year: "numeric",
        month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      partsFmtCache.set(tz, f);
    }
    return f;
  }

  /** Wall-clock parts of an instant, in a zone. */
  function partsIn(date, timeZone) {
    const out = {};
    for (const p of partsFmt(timeZone).formatToParts(date)) {
      if (p.type !== "literal") out[p.type] = p.value;
    }
    if (out.hour === "24") out.hour = "00";
    return out;
  }

  /** Offset in minutes (local wall clock − UTC) at a given instant. */
  function zoneOffsetMinutes(date, timeZone) {
    const p = partsIn(date, timeZone);
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return (asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000;
  }

  /** Real UTC instant for a wall-clock time in a zone (DST-safe by iteration). */
  function zonedTimeToUtc(y, m, d, hh, mm, timeZone) {
    const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
    let guess = naive;
    for (let i = 0; i < 4; i++) {
      const off = zoneOffsetMinutes(new Date(guess), timeZone);
      const next = naive - off * 60000;
      if (next === guess) break;
      guess = next;
    }
    return new Date(guess);
  }

  /**
   * [startMs, endMs) of the local day containing `ms`.
   * Day bounds only move at local midnight, so a one-minute bucket cache
   * keeps the 60 fps loop from re-deriving them for every zone.
   */
  const boundsCache = new Map();
  function localDayBounds(ms, timeZone) {
    const bucket = Math.floor(ms / 60000);
    const hit = boundsCache.get(timeZone);
    if (hit && hit.bucket === bucket) return hit.value;

    const p = partsIn(new Date(ms), timeZone);
    const y = +p.year, m = +p.month, d = +p.day;
    const value = [
      zonedTimeToUtc(y, m, d, 0, 0, timeZone).getTime(),
      zonedTimeToUtc(y, m, d + 1, 0, 0, timeZone).getTime(),
    ];
    boundsCache.set(timeZone, { bucket, value });
    return value;
  }

  /** Stable key for the local calendar day — used to expire the holiday toggle. */
  const localDayKey = (ms, tz) => {
    const p = partsIn(new Date(ms), tz);
    return `${p.year}-${p.month}-${p.day}`;
  };

  /* ── the engine ────────────────────────────────────────────────────── */

  /** Is this instant inside a UTC peak window on a UTC weekday? */
  function peakAtUTC(ms) {
    const d = new Date(ms);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) return false;
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return PEAK_WINDOWS.some(([a, b]) => mins >= a * 60 && mins < b * 60);
  }

  /** Effective state: a holiday override pins everything to off-peak. */
  const isPeak = (ms) => (store.holiday ? false : peakAtUTC(ms));

  /**
   * The next instant the effective state flips (strictly after `ms`).
   * Peaks only ever start/end on window edges or at UTC midnight, so we
   * test those instants exactly instead of scanning minute by minute.
   */
  function nextTransition(ms) {
    if (store.holiday) {
      return { at: localDayBounds(ms, store.tz)[1], to: "off-peak", reason: "holiday-over" };
    }

    const now = new Date(ms);
    const baseUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS;
    const current = peakAtUTC(ms);
    const candidates = [];

    for (let i = 0; i < 10; i++) {
      const base = baseUTC + i * DAY_MS;
      candidates.push(base);
      for (const [a, b] of PEAK_WINDOWS) {
        candidates.push(base + a * HOUR_MS, base + b * HOUR_MS);
      }
    }
    candidates.sort((x, y) => x - y);

    for (const t of candidates) {
      if (t <= ms) continue;
      const state = peakAtUTC(t);
      if (state !== current) {
        return {
          at: t,
          to: state ? "peak" : "off-peak",
          reason: state ? "peak-start" : "peak-end",
        };
      }
    }
    return null;
  }

  /**
   * Peak segments inside one local day, as fractions of that day.
   * Correctly handles zones where the UTC weekday differs from the local one.
   */
  function peakSegments(dayStart, dayEnd) {
    if (store.holiday) return [];
    const span = dayEnd - dayStart;
    if (span <= 0) return [];

    const firstUTC = Math.floor(dayStart / DAY_MS) * DAY_MS - DAY_MS;
    const out = [];

    for (let i = 0; i < 4; i++) {
      const base = firstUTC + i * DAY_MS;
      const wd = new Date(base).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      for (const [a, b] of PEAK_WINDOWS) {
        const s = Math.max(base + a * HOUR_MS, dayStart);
        const e = Math.min(base + b * HOUR_MS, dayEnd);
        if (e > s) out.push([(s - dayStart) / span, (e - dayStart) / span]);
      }
    }
    return out.sort((x, y) => x[0] - y[0]);
  }

  /* ── formatting ────────────────────────────────────────────────────── */

  const fmtCache = new Map();
  function cached(key, build) {
    let v = fmtCache.get(key);
    if (!v) { v = build(); fmtCache.set(key, v); }
    return v;
  }

  const clockFmt = (tz) => cached(`c:${tz}`, () =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour12: false,
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));

  const dateFmt = (tz) => cached(`d:${tz}`, () =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, weekday: "long", day: "numeric", month: "short", year: "numeric",
    }));

  const shortFmt = (tz) => cached(`s:${tz}`, () =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }));

  const cityFmt = (tz) => cached(`z:${tz}`, () =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }));

  /** "UTC+08:00" for an instant. */
  function offsetLabel(ms, tz) {
    const off = zoneOffsetMinutes(new Date(ms), tz);
    const sign = off < 0 ? "−" : "+";
    const abs = Math.abs(Math.round(off));
    return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  }

  const pad = (n, w = 2) => String(n).padStart(w, "0");

  /** "2d 04:31:09" / "04:31:09" */
  function duration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  /** Short human form: "2h 15m" */
  function rough(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) return `${h}h ${pad(m)}m`;
    if (m > 0) return `${m}m ${pad(total % 60)}s`;
    return `${total}s`;
  }

  function money(v) {
    if (!Number.isFinite(v)) return "—";
    if (v === 0) return "$0.00";
    if (v < 0.0001) return `$${v.toExponential(2)}`;
    if (v < 0.01) return `$${v.toFixed(4)}`;
    if (v < 10) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
  }

  const cityName = (tz) => {
    const raw = tz.split("/").pop() || tz;
    return raw.replace(/_/g, " ");
  };

  /* ── dial geometry ─────────────────────────────────────────────────── */

  /** Fraction of a day → point on the dial (0 = midnight, clockwise). */
  function polar(r, frac) {
    const a = frac * Math.PI * 2 - Math.PI / 2;
    return [DIAL_C + r * Math.cos(a), DIAL_C + r * Math.sin(a)];
  }

  function arcPath(r, f0, f1) {
    const [x0, y0] = polar(r, f0);
    const [x1, y1] = polar(r, f1);
    const large = f1 - f0 > 0.5 ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  const svgEl = (tag, attrs) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  };

  /** Static dial furniture: hour ticks + the four clock labels. */
  function buildDialTicks() {
    const frag = document.createDocumentFragment();
    for (let h = 0; h < 24; h++) {
      const major = h % 6 === 0;
      const [x0, y0] = polar(major ? 156 : 160, h / 24);
      const [x1, y1] = polar(166, h / 24);
      frag.appendChild(svgEl("line", {
        x1: x0.toFixed(2), y1: y0.toFixed(2), x2: x1.toFixed(2), y2: y1.toFixed(2),
        class: major ? "dial__tick dial__tick--major" : "dial__tick",
      }));
    }
    for (const h of [0, 6, 12, 18]) {
      const [x, y] = polar(176, h / 24);
      const t = svgEl("text", {
        x: x.toFixed(2), y: (y + 3.5).toFixed(2),
        "text-anchor": "middle", class: "dial__labeltick",
      });
      t.textContent = pad(h);
      frag.appendChild(t);
    }
    el.dialTicks.replaceChildren(frag);
  }

  /** Peak arcs for the local day containing `ms`. */
  function buildDialArcs(ms) {
    const [start, end] = localDayBounds(ms, store.tz);
    const segs = peakSegments(start, end);
    const frag = document.createDocumentFragment();

    if (!segs.length) {
      frag.appendChild(svgEl("circle", {
        cx: DIAL_C, cy: DIAL_C, r: RING_R, class: "dial__arc dial__arc--none",
      }));
    } else {
      for (const [f0, f1] of segs) {
        // Leave a hairline gap so adjacent windows read as two blocks.
        const inset = Math.min(0.004, (f1 - f0) / 8);
        frag.appendChild(svgEl("path", {
          d: arcPath(RING_R, f0 + inset, f1 - inset),
          class: "dial__arc",
        }));
      }
    }
    el.dialArcs.replaceChildren(frag);
  }

  /* ── week view ─────────────────────────────────────────────────────── */

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  let nowMarker = null;

  function renderWeek(ms) {
    const tz = store.tz;
    const p = partsIn(new Date(ms), tz);
    const todayUTC = Date.UTC(+p.year, +p.month - 1, +p.day);
    const dow = new Date(todayUTC).getUTCDay();

    const frag = document.createDocumentFragment();
    nowMarker = null;

    for (let i = 0; i < 7; i++) {
      const d = new Date(todayUTC + (i - dow) * DAY_MS);
      const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
      const wd = d.getUTCDay();

      const dayStart = zonedTimeToUtc(y, m, day, 0, 0, tz).getTime();
      const dayEnd = zonedTimeToUtc(y, m, day + 1, 0, 0, tz).getTime();
      const segs = peakSegments(dayStart, dayEnd);
      const isToday = i === dow;

      const row = document.createElement("div");
      row.className = "day" +
        (isToday ? " is-today" : "") +
        (segs.length ? " is-peakday" : " is-offday") +
        (wd === 0 || wd === 6 ? " is-weekend" : "") +
        (store.holiday && isToday ? " is-holiday" : "");

      const name = document.createElement("div");
      name.className = "day__name";
      name.innerHTML = `<span>${DAY_NAMES[wd]}</span><small>${pad(day)}</small>`;

      const track = document.createElement("div");
      track.className = "track";

      const ticks = document.createElement("div");
      ticks.className = "track__ticks";
      for (let h = 3; h < 24; h += 3) {
        const t = document.createElement("i");
        t.style.left = `${(h / 24) * 100}%`;
        ticks.appendChild(t);
      }
      track.appendChild(ticks);

      for (const [f0, f1] of segs) {
        const block = document.createElement("div");
        block.className = "block";
        block.style.left = `${f0 * 100}%`;
        block.style.width = `${Math.max((f1 - f0) * 100, 0.7)}%`;
        const a = Math.round(f0 * 1440), b = Math.round(f1 * 1440);
        block.title = `${pad(Math.floor(a / 60))}:${pad(a % 60)}–${pad(Math.floor(b / 60))}:${pad(b % 60)} local`;
        track.appendChild(block);
      }

      if (isToday) {
        nowMarker = document.createElement("div");
        nowMarker.className = "now-marker";
        track.appendChild(nowMarker);
      }

      row.append(name, track);
      frag.appendChild(row);
    }

    el.week.replaceChildren(frag);

    // The Sunday anchor is a date-only value, so read it back in UTC.
    const startDate = new Date(todayUTC - dow * DAY_MS);
    el.weekSub.textContent =
      `Week of ${shortFmt("UTC").format(startDate)} · your local clock`;

    paintWeekMarker(ms);
  }

  function paintWeekMarker(ms) {
    if (!nowMarker) return;
    const [s, e] = localDayBounds(ms, store.tz);
    const frac = (ms - s) / (e - s);
    nowMarker.style.left = `${Math.min(Math.max(frac, 0), 1) * 100}%`;
  }

  /* ── world clocks ──────────────────────────────────────────────────── */

  function buildWorld() {
    const frag = document.createDocumentFragment();

    const rows = [{ tz: store.tz, city: cityName(store.tz), you: true }];
    for (const w of WORLD) {
      if (w.tz !== store.tz) rows.push({ ...w, you: false });
    }

    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "world__row" + (row.you ? " is-you" : "");
      li.dataset.tz = row.tz;

      const head = document.createElement("div");
      head.className = "world__head";
      head.innerHTML =
        `<span class="world__city">${row.city}${row.you ? " <em>you</em>" : ""}</span>` +
        `<span class="world__meta">` +
          `<span class="world__off" data-off></span>` +
          `<span class="world__time" data-clock>--:--:--</span>` +
        `</span>`;

      const bar = document.createElement("div");
      bar.className = "world__bar";
      bar.dataset.bar = "";

      li.append(head, bar);
      frag.appendChild(li);
    }

    el.world.replaceChildren(frag);
  }

  function paintWorld(ms) {
    for (const li of el.world.children) {
      const tz = li.dataset.tz;
      li.querySelector("[data-clock]").textContent = cityFmt(tz).format(ms);
      li.querySelector("[data-off]").textContent = offsetLabel(ms, tz);

      const bar = li.querySelector("[data-bar]");
      if (bar.dataset.for !== `${tz}|${store.holiday}`) {
        const [s, e] = localDayBounds(ms, tz);
        const segs = peakSegments(s, e);
        bar.replaceChildren();
        for (const [f0, f1] of segs) {
          const b = document.createElement("i");
          b.style.left = `${f0 * 100}%`;
          b.style.width = `${Math.max((f1 - f0) * 100, 1)}%`;
          bar.appendChild(b);
        }
        const hand = document.createElement("u");
        hand.className = "world__hand";
        bar.appendChild(hand);
        bar.dataset.for = `${tz}|${store.holiday}`;
      }
      const hand = bar.querySelector(".world__hand");
      if (hand) {
        const [s, e] = localDayBounds(ms, tz);
        hand.style.left = `${Math.min(Math.max((ms - s) / (e - s), 0), 1) * 100}%`;
      }
    }
  }

  /* ── rates table ───────────────────────────────────────────────────── */

  function renderRates() {
    const frag = document.createDocumentFragment();
    for (const key in MODELS) {
      const m = MODELS[key];
      const tr = document.createElement("tr");
      tr.dataset.model = key;
      tr.innerHTML = `
        <th scope="row">
          <span class="model">${m.name}</span>
          <small>${m.full}</small>
        </th>
        <td>${pricePair(m.hit)}</td>
        <td>${pricePair(m.miss)}</td>
        <td>${pricePair(m.out)}</td>
        <td>${m.conc}</td>`;
      frag.appendChild(tr);
    }
    el.ratesBody.replaceChildren(frag);
  }

  const pricePair = ([off, peak]) =>
    `<b class="p-off">${fmtUsd(off)}</b><i>/</i><b class="p-peak">${fmtUsd(peak)}</b>`;

  const fmtUsd = (v) => `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;

  /* ── calculator ────────────────────────────────────────────────────── */

  function readTokens() {
    const n = (input, fallback) => {
      const v = Number(input?.value);
      return Number.isFinite(v) ? v : fallback;
    };
    store.tokens = {
      hit: n(el.hit, store.tokens.hit),
      miss: n(el.miss, store.tokens.miss),
      out: n(el.out, store.tokens.out),
    };
  }

  function paintCalculator() {
    const m = MODELS[store.model];
    const { hit, miss, out } = store.tokens;
    const cost = (idx) =>
      (hit * m.hit[idx] + miss * m.miss[idx] + out * m.out[idx]) / 1000;

    const off = cost(0);
    const peak = cost(1);
    const diff = peak - off;
    const currentlyOff = !isPeak(Date.now());

    el.costOff.textContent = money(off);
    el.costPeak.textContent = money(peak);
    el.costSave.textContent = money(diff);

    el.moneyOff.classList.toggle("is-active", currentlyOff);
    el.moneyPeak.classList.toggle("is-active", !currentlyOff);

    el.saveLabel.textContent = currentlyOff ? "You're saving right now" : "You're paying extra";
    el.calcNote.innerHTML = currentlyOff
      ? `At the current rate you'd pay <strong>${money(off)}</strong> for those tokens — half of the <strong>${money(peak)}</strong> peak price.`
      : `You're inside a peak window: <strong>${money(peak)}</strong>. Wait for off-peak and the same tokens cost <strong>${money(off)}</strong>.`;

    el.hitOut.textContent = `${store.tokens.hit} K`;
    el.missOut.textContent = `${store.tokens.miss} K`;
    el.outOut.textContent = `${store.tokens.out} K`;
  }

  /* ── page-level state flip ─────────────────────────────────────────── */

  let lastState = null;
  let flipTimer = 0;

  function applyState(ms) {
    const peak = isPeak(ms);
    const next = peak ? "peak" : "off-peak";
    if (next === lastState) return;

    const first = lastState === null;
    lastState = next;

    el.root.dataset.state = next;
    el.statusCard.dataset.state = next;

    el.announce.textContent = peak
      ? "Peak hours. Full rates apply."
      : "Off-peak hours. Rates are 50% off.";

    el.bannerBadgeText.textContent = peak ? "Peak hours" : "Off-peak";
    el.statusBadge.textContent = peak ? "Peak" : "Off-peak";

    el.statusRate.textContent = peak
      ? "PEAK — every token costs 2× the off-peak price."
      : "OFF-PEAK — every token costs half the peak price.";

    el.statusDesc.textContent = describe(ms, peak);
    el.themeColor.setAttribute("content", peak ? "#1a0708" : "#05070d");

    paintFavicon(peak);
    buildDialArcs(ms);
    buildTicker(peak);
    paintCalculator();

    if (!first) {
      el.root.classList.add("flip");
      clearTimeout(flipTimer);
      flipTimer = setTimeout(() => el.root.classList.remove("flip"), 900);
      if (!reduceMotion) burst(peak);
      toast(
        peak ? "Peak hours just started" : "Off-peak just started",
        peak ? "Full rates apply until the next window closes."
             : "Everything is 50% off from now.",
        peak ? "warn" : "ok"
      );
    }
  }

  function describe(ms, peak) {
    if (store.holiday) return "Chinese public holiday — off-peak all day, on the house.";
    if (peak) return "Inside a UTC peak window — full rates apply.";
    const next = nextTransition(ms);
    if (next && next.reason === "peak-start") {
      return `Outside peak windows — 50% off for another ${rough(next.at - ms)}.`;
    }
    return "Outside peak windows — 50% off.";
  }

  /* ── per-second paint ──────────────────────────────────────────────── */

  let lastSecond = -1;
  let lastTitle = -1;

  function paintSecond(ms) {
    applyState(ms);

    const tz = store.tz;
    el.localClock.textContent = clockFmt(tz).format(ms);
    el.localDate.textContent = dateFmt(tz).format(ms);
    el.utcClock.textContent = clockFmt("UTC").format(ms);
    el.utcDate.textContent = dateFmt("UTC").format(ms);

    const next = nextTransition(ms);
    const remaining = next ? next.at - ms : 0;

    if (next) {
      el.nextLabel.textContent =
        next.reason === "holiday-over" ? "Holiday override ends in"
        : next.to === "peak" ? "Peak starts in"
        : "Off-peak in";
      el.countdown.textContent = duration(remaining);
      el.nextAt.textContent =
        `${shortFmt(tz).format(next.at)} local · ${clockFmt("UTC").format(next.at)} UTC`;
      el.bannerCount.textContent =
        `${next.to === "peak" ? "peak" : "off-peak"} in ${duration(remaining)}`;
      el.dialLabel.textContent =
        next.reason === "holiday-over" ? "until override ends"
        : next.to === "peak" ? "until peak" : "until off-peak";
    } else {
      el.nextLabel.textContent = "Next change";
      el.countdown.textContent = "—";
      el.nextAt.textContent = "—";
      el.bannerCount.textContent = "steady state";
      el.dialLabel.textContent = "steady";
    }

    el.dialDay.textContent =
      `${clockFmt(tz).format(ms)} local · ${offsetLabel(ms, tz)}`;

    paintWorld(ms);

    // Title: at most 4×/s, and only when the text actually changes.
    if (Math.abs(ms - lastTitle) > 250) {
      lastTitle = ms;
      const title = next
        ? `${duration(remaining)} → ${next.to === "peak" ? "peak" : "off-peak"} · Peak Hours`
        : "Peak Hours";
      if (document.title !== title) document.title = title;
    }
  }

  /* ── per-frame paint ───────────────────────────────────────────────── */

  let pointer = { x: 0, y: 0, cx: 0, cy: 0, active: false };

  function paintSmooth(ms) {
    const tz = store.tz;
    const [s, e] = localDayBounds(ms, tz);

    // Local needle
    const frac = Math.min(Math.max((ms - s) / (e - s), 0), 1);
    el.dialNeedle.setAttribute("transform", `rotate(${(frac * 360).toFixed(2)} ${DIAL_C} ${DIAL_C})`);

    // UTC dot — the UTC clock reading plotted on the same 0–24 ruler,
    // so the needle (your wall clock) and the dot (UTC) compare directly.
    const ufrac = (ms - Math.floor(ms / DAY_MS) * DAY_MS) / DAY_MS;
    const [ux, uy] = polar(RING_R + 20, ufrac);
    el.dialUtcDot.setAttribute("cx", ux.toFixed(2));
    el.dialUtcDot.setAttribute("cy", uy.toFixed(2));

    // Milliseconds ticker in the dial
    el.dialMs.textContent = `.${pad(Math.floor((ms % 1000) / 10))}`;

    // Cursor glow eases toward the pointer
    if (pointer.active) {
      pointer.cx += (pointer.x - pointer.cx) * 0.14;
      pointer.cy += (pointer.y - pointer.cy) * 0.14;
      el.glow.style.transform = `translate3d(${pointer.cx - 260}px, ${pointer.cy - 260}px, 0)`;
    }
  }

  /* ── ticker ────────────────────────────────────────────────────────── */

  function buildTicker(peak) {
    const m = MODELS[store.model];
    const items = [
      peak ? "● PEAK HOURS" : "▲ OFF-PEAK · 50% OFF",
      `${m.name} · in $${m.miss[peak ? 1 : 0].toFixed(2)} / out $${m.out[peak ? 1 : 0].toFixed(2)} per 1M`,
      "PEAK 01:00–04:00 UTC",
      "PEAK 06:00–10:00 UTC",
      "MON–FRI ONLY",
      "WEEKENDS ARE ALWAYS OFF-PEAK",
      "CN HOLIDAYS WAIVED",
      `${MODELS.pro.name} · in $${MODELS.pro.miss[peak ? 1 : 0].toFixed(2)} / out $${MODELS.pro.out[peak ? 1 : 0].toFixed(2)} per 1M`,
    ];
    const strip = items.map((t) => `<span>${t}</span>`).join("");
    el.ticker.innerHTML = strip + strip;
  }

  /* ── favicon ───────────────────────────────────────────────────────── */

  function paintFavicon(peak) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (!g) return;

    const grad = g.createLinearGradient(0, 0, 64, 64);
    grad.addColorStop(0, peak ? "#f59e0b" : "#4d6bfe");
    grad.addColorStop(1, peak ? "#ef4444" : "#22d3ee");

    g.fillStyle = grad;
    g.beginPath();
    g.roundRect ? g.roundRect(0, 0, 64, 64, 18) : g.rect(0, 0, 64, 64);
    g.fill();

    g.fillStyle = "#fff";
    g.beginPath();
    if (peak) {                                   // warning triangle
      g.moveTo(32, 15); g.lineTo(52, 48); g.lineTo(12, 48); g.closePath();
    } else {                                      // happy circle
      g.arc(32, 32, 14, 0, Math.PI * 2);
    }
    g.fill();
    if (peak) { g.fillStyle = grad; g.fillRect(29, 24, 6, 14); g.fillRect(29, 41, 6, 5); }

    el.favicon.setAttribute("href", c.toDataURL("image/png"));
  }

  /* ── toasts + burst ────────────────────────────────────────────────── */

  function toast(title, body, kind = "info") {
    const node = document.createElement("div");
    node.className = `toast toast--${kind}`;
    node.innerHTML = `<strong>${title}</strong><span>${body}</span>`;
    el.toasts.appendChild(node);
    setTimeout(() => node.classList.add("is-out"), 4200);
    setTimeout(() => node.remove(), 4900);
  }

  function burst(peak) {
    const colors = peak
      ? ["#f59e0b", "#ef4444", "#fb923c", "#fbbf24"]
      : ["#4d6bfe", "#22d3ee", "#818cf8", "#38bdf8"];
    for (let i = 0; i < 22; i++) {
      const p = document.createElement("i");
      const angle = (Math.PI * 2 * i) / 22 + Math.random() * 0.4;
      const dist = 110 + Math.random() * 190;
      p.className = "spark";
      p.style.setProperty("--tx", `${Math.cos(angle) * dist}px`);
      p.style.setProperty("--ty", `${Math.sin(angle) * dist}px`);
      p.style.setProperty("--c", colors[i % colors.length]);
      p.style.animationDelay = `${Math.random() * 90}ms`;
      el.burst.appendChild(p);
      setTimeout(() => p.remove(), 1200);
    }
  }

  /* ── controls ──────────────────────────────────────────────────────── */

  function buildZoneOptions() {
    const zones = [...new Set([detectedZone, ...ZONE_CHOICES])].filter(Boolean);
    const frag = document.createDocumentFragment();
    for (const z of zones) {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z === detectedZone ? `${z} · detected` : z;
      frag.appendChild(opt);
    }
    el.tzSelect.replaceChildren(frag);
    if ([...el.tzSelect.options].some((o) => o.value === store.tz)) {
      el.tzSelect.value = store.tz;
    } else {
      store.tz = detectedZone;
      el.tzSelect.value = detectedZone;
    }
  }

  function paintZoneHint() {
    el.tzHint.textContent =
      `Showing ${cityName(store.tz)} · ${offsetLabel(Date.now(), store.tz)} · peak windows are fixed in UTC`;
  }

  function setZone(tz) {
    if (!tz) return;
    store.tz = tz;
    el.tzSelect.value = tz;
    persist();
    paintZoneHint();
    buildWorld();
    buildDialArcs(Date.now());
    refresh(true);
  }

  function setTheme(theme) {
    store.theme = theme === "light" ? "light" : "dark";
    el.root.dataset.theme = store.theme;
    el.themeBtn.setAttribute("aria-pressed", String(store.theme === "light"));
    persist();
  }

  function setHoliday(on) {
    store.holiday = !!on;
    // Remember which local day the override belongs to; it expires at midnight.
    store.holidayDay = store.holiday ? localDayKey(Date.now(), store.tz) : null;
    el.holiday.checked = store.holiday;
    persist();
    refresh(true);
  }

  function setModel(key) {
    if (!(key in MODELS)) return;
    store.model = key;
    for (const b of document.querySelectorAll(".seg__btn")) {
      const on = b.dataset.model === key;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    }
    persist();
    buildTicker(isPeak(Date.now()));
    paintCalculator();
  }

  /** Force a full repaint of everything that depends on day/zone/holiday. */
  function refresh(rebuildWeek) {
    if (rebuildWeek) renderWeek(Date.now());
    lastState = null;
    applyState(Date.now());
    paintSecond(Date.now());
  }

  /* ── wiring ────────────────────────────────────────────────────────── */

  el.tzSelect.addEventListener("change", () => setZone(el.tzSelect.value));
  el.holiday.addEventListener("change", () => setHoliday(el.holiday.checked));
  el.themeBtn.addEventListener("click", () =>
    setTheme(store.theme === "dark" ? "light" : "dark"));

  for (const input of [el.hit, el.miss, el.out]) {
    input.addEventListener("input", () => { readTokens(); persist(); paintCalculator(); });
  }

  for (const btn of document.querySelectorAll(".seg__btn")) {
    btn.addEventListener("click", () => setModel(btn.dataset.model));
  }

  el.copyBtn.addEventListener("click", async () => {
    const ms = Date.now();
    const next = nextTransition(ms);
    const peak = isPeak(ms);
    const text =
      `DeepSeek pricing right now: ${peak ? "PEAK (full rate)" : "OFF-PEAK (50% off)"}\n` +
      `Local ${clockFmt(store.tz).format(ms)} (${store.tz}, ${offsetLabel(ms, store.tz)})\n` +
      `UTC   ${clockFmt("UTC").format(ms)}\n` +
      (next ? `${next.to === "peak" ? "Peak" : "Off-peak"} in ${duration(next.at - ms)}` : "Steady state");
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied", "Status copied to your clipboard.", "ok");
    } catch {
      toast("Copy failed", "Your browser blocked clipboard access.", "warn");
    }
  });

  // Cursor glow + per-card spotlight
  window.addEventListener("pointermove", (ev) => {
    pointer.x = ev.clientX;
    pointer.y = ev.clientY;
    if (!pointer.active) { pointer.cx = ev.clientX; pointer.cy = ev.clientY; pointer.active = true; }
    el.glow.classList.add("is-on");

    const card = ev.target instanceof Element ? ev.target.closest("[data-spot]") : null;
    if (card) {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${((ev.clientX - r.left) / r.width) * 100}%`);
      card.style.setProperty("--my", `${((ev.clientY - r.top) / r.height) * 100}%`);
    }
  }, { passive: true });

  window.addEventListener("pointerleave", () => {
    pointer.active = false;
    el.glow.classList.remove("is-on");
  });

  // Keyboard shortcuts (ignored while typing in a control)
  window.addEventListener("keydown", (ev) => {
    const tag = (ev.target instanceof HTMLElement ? ev.target.tagName : "").toLowerCase();
    if (["input", "select", "textarea"].includes(tag) || ev.metaKey || ev.ctrlKey || ev.altKey) return;

    switch (ev.key.toLowerCase()) {
      case "t": setTheme(store.theme === "dark" ? "light" : "dark"); break;
      case "h": setHoliday(!store.holiday); break;
      case "u": setZone("UTC"); break;
      case "l": setZone(detectedZone); break;
      case "/": ev.preventDefault(); el.tzSelect.focus(); break;
      case "escape": document.activeElement?.blur?.(); break;
      default: return;
    }
  });

  // Scroll reveal — opt in only when JS is running, so nothing can ever be
  // stranded invisible. Anything already on screen reveals without waiting.
  el.root.classList.add("js");
  const revealables = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    for (const n of revealables) n.classList.add("in");
  } else {
    const vh = window.innerHeight || 800;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      }
    }, { rootMargin: "-40px 0px -40px 0px" });

    for (const n of revealables) {
      if (n.getBoundingClientRect().top < vh) n.classList.add("in");
      else io.observe(n);
    }
  }

  // Recompute immediately when the tab wakes — timers throttle in background.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh(false);
  });

  window.addEventListener("resize", () => paintSecond(Date.now()), { passive: true });

  /* ── boot ──────────────────────────────────────────────────────────── */

  function boot() {
    setTheme(store.theme);
    buildZoneOptions();
    paintZoneHint();

    el.holiday.checked = store.holiday;
    el.hit.value = store.tokens.hit;
    el.miss.value = store.tokens.miss;
    el.out.value = store.tokens.out;

    buildDialTicks();
    buildWorld();
    renderRates();
    setModel(store.model);
    refresh(true);

    if (reduceMotion) {
      setInterval(() => { paintSmooth(Date.now()); paintSecond(Date.now()); }, 1000);
    } else {
      let last = 0;
      const loop = () => {
        requestAnimationFrame(loop);
        const ms = Date.now();
        paintSmooth(ms);
        const sec = Math.floor(ms / 1000);
        if (sec !== last) { last = sec; paintSecond(ms); }
      };
      requestAnimationFrame(loop);
    }
  }

  // Auto-clear the holiday override when the local day rolls over.
  setInterval(() => {
    if (!store.holiday) return;
    if (localDayKey(Date.now(), store.tz) !== store.holidayDay) {
      setHoliday(false);
      toast("Holiday override cleared", "A new day started — back on the UTC schedule.", "info");
    }
  }, 5000);

  boot();
})();
