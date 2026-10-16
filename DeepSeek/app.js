/* ═══════════════════════════════════════════════════════════════════
   DeepSeek Peak / Off-Peak — supercharged
   Peak (UTC, Mon–Fri): 01:00–04:00 and 06:00–10:00
   Everything else (incl. weekends + CN holidays) = off-peak
   ═══════════════════════════════════════════════════════════════════ */

(() => {
  "use strict";

  // ── Config ──────────────────────────────────────────────────────
  const PEAK_WINDOWS = [[1, 4], [6, 10]]; // UTC [start, end)

  const RATES = {
    flash: { inMissOff: 0.15, inMissPeak: 0.30, outOff: 0.60, outPeak: 1.20 },
    pro:   { inMissOff: 0.66, inMissPeak: 1.32, outOff: 1.98, outPeak: 3.96 },
  };

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

  const LS_KEY = "deepseek-peak-prefs-v1";
  const RING_C = 2 * Math.PI * 52; // circumference

  // ── DOM ─────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const tzSelect      = $("tzSelect");
  const tzHint        = $("tzHint");
  const holidayToggle = $("holidayToggle");
  const soundToggle   = $("soundToggle");
  const soundLabel    = $("soundLabel");
  const resetBtn      = $("resetBtn");

  const statusCard  = $("statusCard");
  const statusBadge = $("statusBadge");
  const statusRate  = $("statusRate");
  const statusDesc  = $("statusDesc");
  const statusTag   = $("statusTag");

  const bannerBadge = $("bannerBadge");
  const bannerText  = $("bannerText");
  const bannerCount = $("bannerCount");
  const themeColor  = $("themeColor");
  const announce    = $("stateAnnounce");

  const localClock = $("localClock");
  const localDate  = $("localDate");
  const utcClock   = $("utcClock");
  const utcDate    = $("utcDate");
  const nextLabel  = $("nextLabel");
  const countdown  = $("countdown");
  const nextAt     = $("nextAt");

  const nextState   = $("nextState");
  const nextPreview = $("nextPreview");

  const ringFg    = $("ringFg");
  const ringLabel = $("ringLabel");
  const ringValue = $("ringValue");

  const week    = $("week");
  const weekSub = $("weekSub");

  const simModel = $("simModel");
  const simIn    = $("simIn");
  const simOut   = $("simOut");
  const simPeak  = $("simPeak");
  const simOff   = $("simOff");
  const simSave  = $("simSave");

  const canvas = $("bgCanvas");
  const root   = document.documentElement;

  // ── State ───────────────────────────────────────────────────────
  const state = {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    manualHoliday: false,
    sound: false,
    lastState: null,     // "peak" | "off-peak" — for detecting flips
    booted: false,
  };

  // ════════════════════════════════════════════════════════════════
  //  PERSISTENCE + URL
  // ════════════════════════════════════════════════════════════════
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.tz) state.timeZone = p.tz;
        if (typeof p.holiday === "boolean") state.manualHoliday = p.holiday;
        if (typeof p.sound === "boolean") state.sound = p.sound;
      }
    } catch { /* ignore */ }

    // URL hash overrides (shareable links)
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (hash.get("tz")) state.timeZone = hash.get("tz");
    if (hash.get("h") === "1") state.manualHoliday = true;
    if (hash.get("h") === "0") state.manualHoliday = false;
  }

  function savePrefs() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        tz: state.timeZone,
        holiday: state.manualHoliday,
        sound: state.sound,
      }));
    } catch { /* ignore */ }
    writeHash();
  }

  function writeHash() {
    const p = new URLSearchParams();
    p.set("tz", state.timeZone);
    p.set("h", state.manualHoliday ? "1" : "0");
    const next = "#" + p.toString();
    if (location.hash !== next) history.replaceState(null, "", next);
  }

  // ════════════════════════════════════════════════════════════════
  //  TIME-ZONE HELPERS
  // ════════════════════════════════════════════════════════════════
  function partsIn(date, timeZone) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
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
    const asUTC = Date.UTC(
      +p.year, +p.month - 1, +p.day,
      +p.hour, +p.minute, +p.second
    );
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

  // ════════════════════════════════════════════════════════════════
  //  PEAK LOGIC
  // ════════════════════════════════════════════════════════════════
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

  function prevTransitionUTC(date) {
    const STEP = 60 * 1000;
    let t = new Date(Math.floor(date.getTime() / STEP) * STEP);
    const current = isPeakUTC(date);
    const limit = date.getTime() - 7 * 24 * 60 * 60 * 1000;
    while (t.getTime() > limit) {
      const prev = new Date(t.getTime() - STEP);
      if (isPeakUTC(prev) !== current) return t;
      t = prev;
    }
    return null;
  }

  function effectivePeak(date) {
    if (state.manualHoliday) return false;
    return isPeakUTC(date);
  }

  // ════════════════════════════════════════════════════════════════
  //  FORMATTING
  // ════════════════════════════════════════════════════════════════
  const fmtClock = (date, tz) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour12: false,
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(date);

  const fmtDate = (date, tz) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, weekday: "long", day: "numeric", month: "short", year: "numeric",
    }).format(date);

  const fmtShortDate = (date, tz) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, weekday: "short", day: "numeric", month: "short",
    }).format(date);

  const fmtLocalDateTime = (date, tz) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
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

  const fmtMoney = (n) => {
    if (n >= 1000) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (n >= 1)    return "$" + n.toFixed(2);
    return "$" + n.toFixed(4);
  };

  // ════════════════════════════════════════════════════════════════
  //  PARTICLE FIELD
  // ════════════════════════════════════════════════════════════════
  class ParticleField {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: true });
      this.mode = "off-peak";
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.particles = [];
      this.raf = 0;
      this.lastT = performance.now();
      this.resize = this.resize.bind(this);
      this.loop = this.loop.bind(this);
      window.addEventListener("resize", this.resize);
      this.resize();
      this.seed();
      if (!this.reduced) this.raf = requestAnimationFrame(this.loop);
    }

    resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.w = w; this.h = h;
      this.canvas.width  = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.canvas.style.width  = w + "px";
      this.canvas.style.height = h + "px";
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    seed() {
      const n = this.mode === "peak" ? 110 : 65;
      this.particles = new Array(n);
      for (let i = 0; i < n; i++) this.particles[i] = this.make();
    }

    make() {
      const peak = this.mode === "peak";
      return {
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        vx: (Math.random() - 0.5) * (peak ? 0.6 : 0.25),
        vy: peak ? -(0.25 + Math.random() * 0.9) : (Math.random() - 0.5) * 0.18,
        r: peak ? 0.6 + Math.random() * 2.1 : 0.5 + Math.random() * 1.6,
        a: 0.15 + Math.random() * 0.55,
        hue: peak
          ? 12 + Math.random() * 38   // amber → red
          : 205 + Math.random() * 55, // blue → cyan
      };
    }

    setMode(mode) {
      if (this.mode === mode) return;
      this.mode = mode;
      this.seed();
    }

    loop(t) {
      const dt = Math.min(48, t - this.lastT) / 16.67;
      this.lastT = t;
      const ctx = this.ctx;
      const peak = this.mode === "peak";

      ctx.clearRect(0, 0, this.w, this.h);

      // Soft radial bloom
      const g = ctx.createRadialGradient(
        this.w * 0.5, this.h * 0.15, 0,
        this.w * 0.5, this.h * 0.15, Math.max(this.w, this.h) * 0.75
      );
      g.addColorStop(0, peak ? "rgba(239,68,68,0.06)" : "rgba(77,107,254,0.05)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);

      for (const p of this.particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        if (p.x < -12) p.x = this.w + 12;
        if (p.x > this.w + 12) p.x = -12;
        if (p.y < -12) { p.y = this.h + 12; p.x = Math.random() * this.w; }
        if (p.y > this.h + 12) { p.y = -12; p.x = Math.random() * this.w; }

        const r = p.r;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 6);
        grad.addColorStop(0, `hsla(${p.hue}, 95%, 68%, ${p.a})`);
        grad.addColorStop(1, `hsla(${p.hue}, 95%, 68%, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 6, 0, Math.PI * 2);
        ctx.fill();
      }

      this.raf = requestAnimationFrame(this.loop);
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  CONFETTI + CHIME
  // ════════════════════════════════════════════════════════════════
  function burstConfetti(colorA, colorB) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const palette = [colorA, colorB, "#ffffff", "#a78bfa", "#22d3ee"];
    const N = 44;
    for (let i = 0; i < N; i++) {
      const el = document.createElement("div");
      el.className = "confetti";
      el.style.background = palette[i % palette.length];
      const angle = (Math.PI * 2 * i) / N + Math.random() * 0.4;
      const dist = 90 + Math.random() * 260;
      el.style.setProperty("--tx", Math.cos(angle) * dist + "px");
      el.style.setProperty("--ty", Math.sin(angle) * dist + "px");
      el.style.setProperty("--rot", (Math.random() * 720 - 360) + "deg");
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1300);
    }
  }

  let audioCtx = null;
  function chime(up) {
    if (!state.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const freqs = up ? [523.25, 783.99] : [659.25, 440.0];
      freqs.forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t + i * 0.09);
        g.gain.linearRampToValueAtTime(0.18, t + i * 0.09 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.35);
        o.connect(g).connect(audioCtx.destination);
        o.start(t + i * 0.09);
        o.stop(t + i * 0.09 + 0.4);
      });
    } catch { /* silent */ }
  }

  // ════════════════════════════════════════════════════════════════
  //  TZ SELECTOR
  // ════════════════════════════════════════════════════════════════
  function buildZoneOptions() {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const zones = Array.from(new Set([state.timeZone, detected, ...ZONE_CHOICES]));
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
    tzHint.textContent = `Showing: ${city} · ${state.timeZone}`;
  }

  // ════════════════════════════════════════════════════════════════
  //  WEEK RENDER
  // ════════════════════════════════════════════════════════════════
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function renderWeek(now) {
    const tz = state.timeZone;
    const tp = partsIn(now, tz);
    const todayDow = new Date(
      Date.UTC(+tp.year, +tp.month - 1, +tp.day)
    ).getUTCDay();

    const startWall = new Date(Date.UTC(
      +tp.year, +tp.month - 1, +tp.day - todayDow
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
          block.title = `${aUTC}:00–${bUTC}:00 UTC`;
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

    // Axis
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

    const startLabel = fmtShortDate(
      zonedTimeToUtc(startY, startM, startD, 12, 0, tz), tz
    );
    weekSub.textContent = `Week of ${startLabel} · times shown in your local clock`;
  }

  // ════════════════════════════════════════════════════════════════
  //  RING
  // ════════════════════════════════════════════════════════════════
  function updateRing(now, peak) {
    const start = prevTransitionUTC(now);
    const end   = nextTransitionUTC(now);
    if (!start || !end) {
      ringValue.textContent = "—%";
      ringFg.style.strokeDashoffset = RING_C;
      return;
    }
    const total = end.getTime() - start.getTime();
    const done  = now.getTime() - start.getTime();
    const pct   = Math.max(0, Math.min(1, done / total));

    ringFg.style.strokeDashoffset = String(RING_C * (1 - pct));
    ringValue.textContent = Math.round(pct * 100) + "%";
    ringLabel.textContent = peak ? "peak window" : "off-peak window";
  }

  // ════════════════════════════════════════════════════════════════
  //  STATUS UPDATE
  // ════════════════════════════════════════════════════════════════
  function updateStatus(now) {
    const tz = state.timeZone;
    const peak = effectivePeak(now);
    const nextStateKey = peak ? "peak" : "off-peak";

    statusCard.dataset.state = nextStateKey;

    // Detect transitions for confetti + chime
    if (state.booted && state.lastState && state.lastState !== nextStateKey) {
      const colors = peak
        ? ["#f59e0b", "#ef4444"]
        : ["#4d6bfe", "#22d3ee"];
      burstConfetti(colors[0], colors[1]);
      chime(!peak); // up-chime when entering off-peak
    }
    state.lastState = nextStateKey;

    if (root.dataset.state !== nextStateKey) {
      root.dataset.state = nextStateKey;
      announce.textContent = peak
        ? "Peak hours. Full rates apply."
        : "Off-peak hours. Rates are 50% off.";
    }

    statusBadge.textContent = peak ? "Peak" : "Off-peak";
    statusTag.textContent   = peak ? "2× rate" : "½ rate";

    bannerBadge.textContent = peak ? "Peak" : "Off-peak";
    bannerText.innerHTML = peak
      ? "<strong>Full rate</strong> — you are paying 2&times; right now"
      : "<strong>50% off</strong> — you are in off-peak hours";
    themeColor.setAttribute("content", peak ? "#ef4444" : "#4d6bfe");

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
      ? "Every token costs 2× the off-peak price."
      : "Every token costs half the peak price.";

    localClock.textContent = fmtClock(now, tz);
    localDate.textContent  = fmtDate(now, tz);
    utcClock.textContent   = fmtClock(now, "UTC");
    utcDate.textContent    = fmtDate(now, "UTC");

    const next = nextTransitionUTC(now);
    if (next) {
      nextLabel.textContent = peak ? "Off-peak in" : "Peak in";
      countdown.textContent = fmtDuration(next.getTime() - now.getTime());
      nextAt.textContent    = `${fmtLocalDateTime(next, tz)} local · ${fmtClock(next, "UTC")} UTC`;

      const nextIsPeak = isPeakUTC(next);
      nextState.textContent = nextIsPeak ? "Peak" : "Off-peak";
      nextState.style.color = nextIsPeak ? "#ffb199" : "#b8c5ff";
      nextPreview.textContent = nextIsPeak
        ? "Full rate resumes"
        : "Half price resumes";

      bannerCount.textContent = `${nextIsPeak ? "peak" : "off-peak"} in ${countdown.textContent}`;
    } else {
      nextLabel.textContent = "Next change";
      countdown.textContent = "—";
      nextAt.textContent    = "—";
      nextState.textContent = "—";
      nextPreview.textContent = "—";
      bannerCount.textContent = "—";
    }

    updateRing(now, peak);
  }

  // ════════════════════════════════════════════════════════════════
  //  SIMULATOR
  // ════════════════════════════════════════════════════════════════
  function updateSim() {
    const r = RATES[simModel.value] || RATES.flash;
    const inTok  = Math.max(0, +simIn.value  || 0);
    const outTok = Math.max(0, +simOut.value || 0);

    const peakCost = (inTok / 1e6) * r.inMissPeak + (outTok / 1e6) * r.outPeak;
    const offCost  = (inTok / 1e6) * r.inMissOff  + (outTok / 1e6) * r.outOff;
    const save     = peakCost - offCost;

    simPeak.textContent = fmtMoney(peakCost);
    simOff.textContent  = fmtMoney(offCost);
    simSave.textContent = fmtMoney(save);
  }

  // ════════════════════════════════════════════════════════════════
  //  MAIN LOOP
  // ════════════════════════════════════════════════════════════════
  let lastRenderedDay = null;
  let lastHoliday = null;

  function tick() {
    const now = new Date();
    const todayKey = fmtDate(now, state.timeZone);

    if (todayKey !== lastRenderedDay || state.manualHoliday !== lastHoliday) {
      lastRenderedDay = todayKey;
      lastHoliday = state.manualHoliday;
      renderWeek(now);
    } else {
      renderWeek(now);
    }

    updateStatus(now);
    if (!state.booted) state.booted = true;
  }

  // ════════════════════════════════════════════════════════════════
  //  EVENTS
  // ════════════════════════════════════════════════════════════════
  tzSelect.addEventListener("change", () => {
    state.timeZone = tzSelect.value;
    updateTzHint();
    lastRenderedDay = null;
    savePrefs();
    tick();
  });

  holidayToggle.addEventListener("change", () => {
    state.manualHoliday = holidayToggle.checked;
    lastRenderedDay = null;
    savePrefs();
    tick();
  });

  soundToggle.addEventListener("click", () => {
    state.sound = !state.sound;
    soundToggle.setAttribute("aria-pressed", String(state.sound));
    soundLabel.textContent = "Chime: " + (state.sound ? "on" : "off");
    if (state.sound) chime(true);
    savePrefs();
  });

  resetBtn.addEventListener("click", () => {
    try { localStorage.removeItem(LS_KEY); } catch {}
    state.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    state.manualHoliday = false;
    state.sound = false;
    tzSelect.value = state.timeZone;
    holidayToggle.checked = false;
    soundToggle.setAttribute("aria-pressed", "false");
    soundLabel.textContent = "Chime: off";
    updateTzHint();
    lastRenderedDay = null;
    writeHash();
    tick();
  });

  [simModel, simIn, simOut].forEach((el) =>
    el.addEventListener("input", updateSim)
  );

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const k = e.key.toLowerCase();
    if (k === "h") {
      holidayToggle.checked = !holidayToggle.checked;
      holidayToggle.dispatchEvent(new Event("change"));
    } else if (k === "s") {
      soundToggle.click();
    } else if (k === "t") {
      const i = tzSelect.selectedIndex;
      tzSelect.selectedIndex = (i + 1) % tzSelect.options.length;
      tzSelect.dispatchEvent(new Event("change"));
    } else if (k === "r") {
      resetBtn.click();
    }
  });

  window.addEventListener("hashchange", () => {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (hash.get("tz") && hash.get("tz") !== state.timeZone) {
      state.timeZone = hash.get("tz");
      tzSelect.value = state.timeZone;
      updateTzHint();
      lastRenderedDay = null;
    }
    if (hash.has("h")) {
      const v = hash.get("h") === "1";
      if (v !== state.manualHoliday) {
        state.manualHoliday = v;
        holidayToggle.checked = v;
        lastRenderedDay = null;
      }
    }
    tick();
  });

  // ════════════════════════════════════════════════════════════════
  //  BOOT
  // ════════════════════════════════════════════════════════════════
  loadPrefs();
  buildZoneOptions();
  holidayToggle.checked = state.manualHoliday;
  soundToggle.setAttribute("aria-pressed", String(state.sound));
  soundLabel.textContent = "Chime: " + (state.sound ? "on" : "off");

  const field = new ParticleField(canvas);
  field.setMode(effectivePeak(new Date()) ? "peak" : "off-peak");

  // Re-set particle mode whenever the state flips
  const origUpdateStatus = updateStatus;
  // (simplest way: piggyback the loop — call setMode from tick)

  updateSim();
  tick();
  setInterval(() => {
    tick();
    field.setMode(root.dataset.state === "peak" ? "peak" : "off-peak");
  }, 1000);
})();