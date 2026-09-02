import { forecast, PROFILES, SEASON, WATER_TEMP, WEIGHTS, ratingLabel, WATER_TAU_HOURS, COLOUR_HALF_LIFE_HOURS } from './src/engine.js';
import { fetchForecast, fetchBankHolidays, weatherCodeLabel, normaliseOpenMeteo } from './src/data.js';
import { findRainGauge, fetchGaugeHourly, applyGaugeRain } from './src/ea.js';
import { getSunTimes } from './src/astro.js';
import { localParts, midnightForDateKey } from './src/timezone.js';

const TZ = 'Europe/London';
const STORE_KEY = 'fishing-claude:v1';
// Single-file preview builds (see scripts/build-single.mjs) set this: they run
// on synthetic weather because the embedding sandbox blocks outbound fetch.
const PREVIEW = typeof window !== 'undefined' && window.__FISHING_CLAUDE_PREVIEW__ === true;

// Midlands canal presets. Coordinates are approximate; weather grids are 2–10 km so it hardly matters.
const PRESETS = [
  { name: 'Solihull — Grand Union, Catherine-de-Barnes', lat: 52.4076, lng: -1.7451 },
  { name: 'Solihull — Stratford Canal, Shirley', lat: 52.3968, lng: -1.8305 },
  { name: 'Leamington — Grand Union, town centre', lat: 52.2856, lng: -1.522 },
  { name: 'Leamington — Grand Union, Radford Semele', lat: 52.2775, lng: -1.4835 },
  { name: 'Warwick — Grand Union, Saltisford', lat: 52.282, lng: -1.575 },
  { name: 'Hawkesbury Junction (Coventry / Oxford)', lat: 52.4477, lng: -1.4614 },
  { name: 'Braunston (Grand Union / Oxford)', lat: 52.287, lng: -1.205 },
  { name: 'Gas Street Basin (Birmingham)', lat: 52.4762, lng: -1.9105 },
  { name: 'Fradley Junction (Trent & Mersey / Coventry)', lat: 52.7195, lng: -1.7761 },
  { name: 'Market Bosworth (Ashby)', lat: 52.6215, lng: -1.4012 },
];

const state = {
  species: 'perch',
  view: 'forecast',
  loc: null,
  solunar: false,
  wx: null,
  bank: new Set(),
  gauge: null,
  days: [],
  past: [],
  hours: [],
  selectedDay: null,
  selectedHour: null,
};

// ---- persistence -----------------------------------------------------------
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (s.species && PROFILES[s.species]) state.species = s.species;
    if (s.loc && Number.isFinite(s.loc.lat)) state.loc = s.loc;
    if (typeof s.solunar === 'boolean') state.solunar = s.solunar;
  } catch {
    /* ignore */
  }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ species: state.species, loc: state.loc, solunar: state.solunar }));
  } catch {
    /* ignore */
  }
}

// ---- helpers ---------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) n.append(c);
  return n;
};
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const fmtTime = (unix) => new Date(unix * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const fmtHour = (unix) => new Date(unix * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', timeZone: TZ }).slice(0, 2);
const dayNoon = (dateKey) => new Date(midnightForDateKey(dateKey, TZ).valueOf() + 43200000);
const fmtDow = (dateKey) => dayNoon(dateKey).toLocaleDateString('en-GB', { weekday: 'short', timeZone: TZ });
const fmtDate = (dateKey, opts = { day: 'numeric', month: 'short' }) => dayNoon(dateKey).toLocaleDateString('en-GB', { ...opts, timeZone: TZ });
const scoreBand = (s) => (s >= 4.2 ? 5 : s >= 3.4 ? 4 : s >= 2.6 ? 3 : s >= 1.8 ? 2 : 1);
const scoreStyle = (s) => `background:var(--score-${scoreBand(s)});color:var(--score-${scoreBand(s)}-ink)`;
const signed = (v) => {
  const s = Math.abs(v * 10 - Math.round(v * 10)) < 1e-9 ? v.toFixed(1) : v.toFixed(2);
  return v > 0 ? `+${s}` : s;
};
const todayKey = () => localParts(new Date(), TZ).dateKey;

function setStatus(msg, offline = false) {
  const s = $('#status');
  s.textContent = msg || '';
  s.classList.toggle('offline', offline);
}

// ---- data ------------------------------------------------------------------
function mockWeather() {
  // Deterministic synthetic fortnight+week for ?mock=1 QA without network.
  const start = Math.floor(Date.now() / 1000 / 3600) * 3600 - 14 * 86400;
  const n = 22 * 24;
  const h = { time: [], temperature_2m: [], precipitation: [], cloud_cover: [], pressure_msl: [], wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [], weather_code: [], visibility: [] };
  for (let i = 0; i < n; i++) {
    const t = start + i * 3600;
    const day = Math.floor(i / 24);
    const hod = i % 24;
    const front = Math.sin(day / 2.2);
    h.time.push(t);
    h.temperature_2m.push(15 + 3 * Math.sin(((hod - 15) / 24) * 2 * Math.PI) - day * 0.1);
    const rainy = front > 0.4 && hod % 5 < 2;
    h.precipitation.push(rainy ? (day % 3 === 0 ? 4.5 : 0.6) : 0);
    h.cloud_cover.push(Math.round(50 + 45 * front));
    h.pressure_msl.push(1015 - 8 * front);
    h.wind_speed_10m.push(6 + 8 * Math.abs(front));
    h.wind_gusts_10m.push(12 + 14 * Math.abs(front));
    h.wind_direction_10m.push(220);
    h.weather_code.push(rainy ? 61 : front > 0.4 ? 3 : 1);
    h.visibility.push(20000);
  }
  return normaliseOpenMeteo({ hourly: h, daily: { time: [], sunrise: [], sunset: [] } });
}

async function loadData() {
  const params = new URLSearchParams(location.search);
  if (PREVIEW || params.get('mock') === '1') {
    state.wx = mockWeather();
    state.bank = new Set();
    state.gauge = null;
    setStatus(PREVIEW ? 'Preview build — synthetic weather, not a real forecast' : 'Mock data (QA mode)', true);
    return;
  }
  setStatus('Fetching forecast…');
  const [wx, bank] = await Promise.all([fetchForecast(state.loc), fetchBankHolidays()]);
  state.wx = wx;
  state.bank = bank;
  state.gauge = null;
  // Optional: real rainfall from the nearest EA gauge replaces modelled past rain.
  try {
    const gauge = await findRainGauge(state.loc);
    if (gauge) {
      const now = Date.now() / 1000;
      const hourly = await fetchGaugeHourly(gauge, now - 14 * 86400);
      const replaced = applyGaugeRain(wx, hourly, now);
      const sum = (h) => [...hourly].filter(([t]) => t >= now - h * 3600).reduce((s, [, v]) => s + v, 0);
      state.gauge = { ...gauge, replaced, rain24: Math.round(sum(24) * 10) / 10, rain72: Math.round(sum(72) * 10) / 10 };
    }
  } catch {
    /* gauge is optional */
  }
  const stale = Date.now() - wx.generated > 3 * 3600000;
  setStatus(!navigator.onLine || stale ? `Offline — showing forecast cached ${new Date(wx.generated).toLocaleString('en-GB', { timeZone: TZ })}` : '', !navigator.onLine || stale);
}

function compute() {
  if (!state.wx || !state.loc) return;
  const ctx = { lat: state.loc.lat, lng: state.loc.lng, tz: TZ, species: state.species, bankHolidays: state.bank, solunar: state.solunar };
  const { hours, days } = forecast(state.wx, ctx);
  const today = todayKey();
  state.hours = hours;
  state.days = days.filter((d) => d.dateKey >= today);
  state.past = days.filter((d) => d.dateKey < today).slice(-14);
  const pool = state.view === 'history' ? state.past : state.days;
  if (!pool.some((d) => d.dateKey === state.selectedDay)) {
    state.selectedDay = state.view === 'history' ? (pool[pool.length - 1]?.dateKey ?? null) : (pool[0]?.dateKey ?? null);
    state.selectedHour = null;
  }
}

// ---- render ----------------------------------------------------------------
function render() {
  $('#locBtn').textContent = `📍 ${state.loc?.name ?? 'Set location'}`;
  document.querySelectorAll('.species [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.species === state.species)));
  document.querySelectorAll('.views [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
  $('#forecastView').hidden = state.view !== 'forecast';
  $('#historyView').hidden = state.view !== 'history';
  if (!state.wx) return;
  if (state.view === 'forecast') {
    renderHero();
    renderDayStrip($('#days'), state.days);
  } else {
    renderHistory();
  }
  renderDetail();
  $('#updated').textContent = state.wx ? `Forecast fetched ${new Date(state.wx.generated).toLocaleString('en-GB', { timeZone: TZ })}` : '';
}

function currentHour() {
  const now = Math.floor(Date.now() / 1000);
  return state.hours.find((h) => now >= h.time && now < h.time + 3600) ?? null;
}

function speciesWarnings(day) {
  const out = [];
  if (state.species === 'pike') {
    if (day.flags.includes('pikeWelfare')) out.push(`⚠ Estimated water ≥ ${WEIGHTS.pikeWelfareTemp}°C — Pike Anglers' Club advise not targeting pike; recovery is poor in warm, low-oxygen water.`);
    else if (day.flags.includes('pikeSummer')) out.push('ℹ 16 Jun – 1 Oct: PAC advise a summer break from pike fishing.');
  }
  if (state.species === 'zander' && day.dateKey === todayKey()) out.push('ℹ Zander are a Schedule 9 non-native species — check your permit; CRT permits typically require they are not returned.');
  return out;
}

function renderHero() {
  const hero = $('#hero');
  hero.replaceChildren();
  const now = currentHour();
  const today = state.days.find((d) => d.dateKey === todayKey()) ?? state.days[0];
  if (!today) {
    hero.append(el('div', { class: 'skeleton', text: 'No forecast data for today.' }));
    return;
  }
  const prof = PROFILES[state.species];
  const score = now ? now.score : today.score;
  const scoreEl = el('div', { class: 'score', style: scoreStyle(score) }, document.createTextNode(score.toFixed(1)), el('small', { text: now ? 'now' : 'today' }));
  const headline = el('div', {}, el('div', { class: 'headline', text: `${ratingLabel(score)} for ${prof.label.toLowerCase()}` }));
  const bits = [];
  if (today.bestWindow) bits.push(`Best window ${fmtTime(today.bestWindow.start)}–${fmtTime(today.bestWindow.end)} (${today.bestWindow.score.toFixed(1)})`);
  if (now) {
    const top = [...now.parts]
      .filter((p) => p.key !== 'season')
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 2);
    if (top.length) bits.push(top.map((p) => `${p.label.toLowerCase()} ${signed(p.value)}`).join(' · '));
  }
  headline.append(el('div', { class: 'sub', text: bits.join(' — ') }));
  hero.append(scoreEl, headline);

  const sun = getSunTimes(dayNoon(today.dateKey), state.loc.lat, state.loc.lng);
  const facts = el('div', { class: 'facts' });
  const fact = (k, v) => facts.append(el('span', {}, `${k} `, el('b', { text: v })));
  fact('Water', `~${today.waterTemp.toFixed(1)}°C`);
  fact('Colour', today.colourLabel);
  if (today.pressureNote) fact('Pressure', today.pressureNote);
  if (now) {
    const i = state.wx.time.indexOf(now.time);
    fact('Air', `${Math.round(now.temp)}°C, ${weatherCodeLabel(state.wx.weatherCode[i]).toLowerCase()}`);
  }
  if (sun.sunrise && sun.sunset) fact('Sun', `${fmtTime(sun.sunrise / 1000)}–${fmtTime(sun.sunset / 1000)}`);
  fact('Moon', `${today.moon.name} ${Math.round(today.moon.fraction * 100)}%`);
  if (state.gauge) fact('Gauge 24h/72h', `${state.gauge.rain24}/${state.gauge.rain72} mm`);
  hero.append(facts);
  for (const w of speciesWarnings(today)) hero.append(el('div', { class: 'warn full', text: w }));
}

function renderDayStrip(wrap, days) {
  wrap.replaceChildren();
  for (const d of days) {
    wrap.append(
      el(
        'button',
        {
          class: 'day',
          type: 'button',
          role: 'option',
          'aria-selected': String(d.dateKey === state.selectedDay),
          onclick: () => {
            state.selectedDay = d.dateKey;
            state.selectedHour = null;
            render();
            $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        },
        el('div', { class: 'dow', text: d.dateKey === todayKey() ? 'Today' : fmtDow(d.dateKey) }),
        el('div', { class: 'dom', text: fmtDate(d.dateKey) }),
        el('div', { class: 'pill', style: scoreStyle(d.score), text: d.score.toFixed(1) }),
        el('div', { class: 'win', text: d.bestWindow ? `${fmtHour(d.bestWindow.start)}–${fmtHour(d.bestWindow.end)}h` : '—' }),
        el('div', { class: 'wx', text: `${Math.round(d.tempRange[1])}° · ${d.rainTotal > 0 ? `${d.rainTotal.toFixed(0)}mm` : 'dry'} · ${d.cloudMean}%☁` }),
      ),
    );
  }
}

// ---- history view ----------------------------------------------------------
function renderHistory() {
  const chart = $('#historyChart');
  chart.replaceChildren();
  const stats = $('#historyStats');
  stats.replaceChildren();
  const days = state.past;
  if (!days.length) {
    chart.append(el('div', { class: 'skeleton', text: 'No history yet — reload once the forecast has fetched past days.' }));
    return;
  }
  chart.append(renderDailyBars(days));
  const legend = el('div', { class: 'legend' });
  legend.append(el('span', { style: '--k: var(--score-3)', text: `Daily score, ${PROFILES[state.species].label.toLowerCase()}` }));
  chart.append(legend);

  const scores = days.map((d) => d.score);
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const best = days.reduce((a, b) => (b.score > a.score ? b : a));
  const good = days.filter((d) => d.score >= 3.4).length;
  const fact = (k, v) => stats.append(el('div', {}, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v })));
  fact('Mean score', mean.toFixed(1));
  fact('Best day', `${fmtDow(best.dateKey)} ${fmtDate(best.dateKey)} — ${best.score.toFixed(1)}`);
  fact('Days rated Good+', `${good} of ${days.length}`);
  fact('Water temp now vs 14d ago', `${days[days.length - 1].waterTemp.toFixed(1)}°C vs ${days[0].waterTemp.toFixed(1)}°C`);
  fact('Rain over period', `${days.reduce((s, d) => s + d.rainTotal, 0).toFixed(0)} mm`);
  fact('Colour now', days[days.length - 1].colourLabel);

  renderDayStrip($('#historyDays'), days);
}

/** Compact daily bar chart used by the History view. */
function renderDailyBars(days) {
  const W = 360;
  const H = 130;
  const padL = 20;
  const padR = 6;
  const padT = 14;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const slot = plotW / days.length;
  const barW = Math.min(24, slot - 4);
  const y = (v) => padT + plotH - (v / 5) * plotH;
  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Daily ${PROFILES[state.species].label} score, last ${days.length} days` });
  for (const v of [0, 1, 2, 3, 4, 5]) {
    svg.append(svgEl('line', { class: v === 0 ? 'axis' : 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    const t = svgEl('text', { x: padL - 5, y: y(v) + 3, 'text-anchor': 'end' });
    t.textContent = String(v);
    svg.append(t);
  }
  // "Good" threshold — the line worth going fishing above.
  svg.append(svgEl('line', { class: 'threshold', x1: padL, x2: W - padR, y1: y(3.4), y2: y(3.4) }));
  const thr = svgEl('text', { class: 'threshold-label', x: W - padR, y: y(3.4) - 4, 'text-anchor': 'end' });
  thr.textContent = 'Good';
  svg.append(thr);
  const best = Math.max(...days.map((d) => d.score));
  let labelled = false;
  days.forEach((d, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const top = y(d.score);
    const height = Math.max(0, y(0) - top);
    const r = Math.min(4, height / 2);
    svg.append(
      svgEl('path', {
        class: `bar${d.dateKey === state.selectedDay ? ' selected' : ''}`,
        fill: `var(--score-${scoreBand(d.score)})`,
        d: height <= 0 ? '' : `M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${y(0)} Z`,
      }),
    );
    const hit = svgEl('rect', { class: 'hit', x: padL + i * slot, y: padT, width: slot, height: plotH, tabindex: 0, role: 'button', 'aria-label': `${fmtDow(d.dateKey)} ${fmtDate(d.dateKey)} score ${d.score.toFixed(1)}` });
    const pick = () => {
      state.selectedDay = d.dateKey;
      state.selectedHour = null;
      render();
    };
    hit.addEventListener('click', pick);
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    svg.append(hit);
    if (!labelled && d.score === best) {
      const t = svgEl('text', { class: 'label', x: x + barW / 2, y: Math.max(padT - 3, top - 4), 'text-anchor': 'middle' });
      t.textContent = d.score.toFixed(1);
      svg.append(t);
      labelled = true;
    }
    if (i % 2 === 0) {
      const t = svgEl('text', { x: padL + i * slot + slot / 2, y: H - 8, 'text-anchor': 'middle' });
      t.textContent = fmtDate(d.dateKey, { day: 'numeric' });
      svg.append(t);
    }
  });
  const wrap = el('div', { class: 'chart-wrap' });
  wrap.append(svg);
  return wrap;
}

// ---- day detail ------------------------------------------------------------
function renderDetail() {
  const sec = $('#detail');
  const pool = state.view === 'history' ? state.past : state.days;
  const day = pool.find((d) => d.dateKey === state.selectedDay);
  if (!day) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;
  sec.replaceChildren();
  const prof = PROFILES[state.species];
  const isToday = day.dateKey === todayKey();
  sec.append(
    el(
      'div',
      { class: 'detail-head' },
      el('h3', { text: `${isToday ? 'Today' : fmtDow(day.dateKey)}, ${fmtDate(day.dateKey, { day: 'numeric', month: 'long' })}` }),
      el('div', { class: 'rating', text: `${day.label} · ${day.score.toFixed(1)} for ${prof.label.toLowerCase()}` }),
    ),
  );
  if (state.view === 'history') sec.append(el('div', { class: 'note', text: 'Past day — scored from recorded weather.' }));
  if (day.flags.includes('thunder')) sec.append(el('div', { class: 'warn', text: "⚠ Thunderstorms — carbon rods and lightning don't mix. Stay off the bank during storms." }));
  if (day.flags.includes('ice')) sec.append(el('div', { class: 'warn', text: '❄ Ice likely on the canal — expect a frozen surface, at least early on.' }));
  for (const w of speciesWarnings(day)) sec.append(el('div', { class: 'warn', text: w }));

  const sun = getSunTimes(dayNoon(day.dateKey), state.loc.lat, state.loc.lng);
  const facts = el('div', { class: 'facts-grid' });
  const fact = (k, v) => facts.append(el('div', {}, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v })));
  fact('Best window', day.bestWindow ? `${fmtTime(day.bestWindow.start)}–${fmtTime(day.bestWindow.end)}` : '—');
  fact('Water temp (est.)', `~${day.waterTemp.toFixed(1)}°C`);
  fact('Canal colour', `${day.colourLabel} (${day.colour.toFixed(0)})`);
  fact('Pressure', day.pressureNote ?? '—');
  fact('Air temp', `${Math.round(day.tempRange[0])}–${Math.round(day.tempRange[1])}°C`);
  fact('Rain', day.rainTotal > 0 ? `${day.rainTotal.toFixed(1)} mm` : 'dry');
  fact('Wind max', `${day.windMax} mph`);
  fact('Cloud', `${day.cloudMean}% mean`);
  fact('Boat traffic', day.traffic);
  if (sun.dawn && sun.dusk) fact('Dawn / dusk', `${fmtTime(sun.dawn / 1000)} / ${fmtTime(sun.dusk / 1000)}`);
  if (sun.sunrise && sun.sunset) fact('Sunrise / set', `${fmtTime(sun.sunrise / 1000)} / ${fmtTime(sun.sunset / 1000)}`);
  fact('Moon', `${day.moon.name}, ${Math.round(day.moon.fraction * 100)}%`);
  const majors = day.solunar.filter((p) => p.kind === 'major').map((p) => fmtTime(p.centre / 1000));
  if (state.solunar && majors.length) fact('Solunar majors', majors.join(', '));
  if (state.gauge && isToday) fact(`Rain gauge (${Math.round(state.gauge.km)} km)`, `${state.gauge.rain24} mm / 24h, ${state.gauge.rain72} mm / 72h`);
  sec.append(facts);

  sec.append(renderHourChart(day));
  const legend = el('div', { class: 'legend' });
  legend.append(el('span', { style: '--k: var(--score-3)', text: 'Hourly score (0–5)' }));
  legend.append(el('span', { style: '--k: var(--night)', text: 'Night' }));
  legend.append(el('span', { style: '--k: var(--twilight)', text: 'Twilight' }));
  if (state.solunar) legend.append(el('span', { style: '--k: var(--accent)', text: 'Solunar major' }));
  sec.append(legend);

  const sel = day.hours.find((h) => h.time === state.selectedHour) ?? day.hours.reduce((a, b) => (b.fishable && b.score > (a?.score ?? -1) ? b : a), null) ?? day.hours[0];
  sec.append(renderBreakdown(sel));
  sec.append(renderHourTable(day));
}

function renderHourChart(day) {
  const W = 360;
  const H = 170;
  const padL = 22;
  const padR = 6;
  const padT = 14;
  const padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const hours = day.hours;
  const slot = plotW / hours.length;
  const barW = Math.min(24, slot - 3);
  const y = (v) => padT + plotH - (v / 5) * plotH;

  const svg = svgEl('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Hourly ${PROFILES[state.species].label} score for ${day.dateKey}` });

  for (let i = 0; i < hours.length; i++) {
    const a = hours[i].sunAlt;
    const cls = a < -6 ? 'night' : a < 6 ? 'twilight' : null;
    if (cls) svg.append(svgEl('rect', { class: cls, x: padL + i * slot, y: padT, width: slot, height: plotH }));
  }
  for (let v = 0; v <= 5; v++) {
    svg.append(svgEl('line', { class: v === 0 ? 'axis' : 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    const t = svgEl('text', { x: padL - 5, y: y(v) + 3, 'text-anchor': 'end' });
    t.textContent = String(v);
    svg.append(t);
  }
  if (state.solunar) {
    for (const p of day.solunar.filter((q) => q.kind === 'major')) {
      const s = Math.max(hours[0].time, p.start / 1000);
      const e = Math.min(hours[hours.length - 1].time + 3600, p.end / 1000);
      if (e <= s) continue;
      const x1 = padL + ((s - hours[0].time) / 3600) * slot;
      const x2 = padL + ((e - hours[0].time) / 3600) * slot;
      svg.append(svgEl('rect', { class: 'solunar', x: x1, y: y(0) + 2, width: x2 - x1, height: 3, rx: 1.5 }));
    }
  }
  const best = Math.max(...hours.filter((h) => h.fishable).map((h) => h.score));
  const now = Math.floor(Date.now() / 1000);
  let labelled = false;
  hours.forEach((h, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const top = y(h.score);
    const height = Math.max(0, y(0) - top);
    const r = Math.min(4, height / 2);
    svg.append(
      svgEl('path', {
        class: `bar${h.time === state.selectedHour ? ' selected' : ''}`,
        fill: `var(--score-${scoreBand(h.score)})`,
        opacity: h.fishable ? 1 : 0.45,
        d: height <= 0 ? '' : `M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${y(0)} Z`,
      }),
    );
    const hit = svgEl('rect', { class: 'hit', x: padL + i * slot, y: padT, width: slot, height: plotH, tabindex: 0, role: 'button', 'aria-label': `${fmtHour(h.time)}:00 score ${h.score.toFixed(1)}` });
    const pick = () => {
      state.selectedHour = h.time;
      renderDetail();
    };
    hit.addEventListener('click', pick);
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    svg.append(hit);
    if (!labelled && h.fishable && h.score === best) {
      const t = svgEl('text', { class: 'label', x: x + barW / 2, y: Math.max(padT - 3, top - 4), 'text-anchor': 'middle' });
      t.textContent = h.score.toFixed(1);
      svg.append(t);
      labelled = true;
    }
    if (i % 3 === 0) {
      const t = svgEl('text', { x: padL + i * slot + slot / 2, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = fmtHour(h.time);
      svg.append(t);
    }
    if (now >= h.time && now < h.time + 3600) {
      const nx = padL + i * slot + ((now - h.time) / 3600) * slot;
      svg.append(svgEl('line', { class: 'now', x1: nx, x2: nx, y1: padT, y2: y(0) }));
    }
  });
  const wrap = el('div', { class: 'chart-wrap' });
  wrap.append(svg);
  return wrap;
}

function renderBreakdown(h) {
  const box = el('div', { class: 'breakdown' });
  box.append(el('h4', { text: `Why ${h.score.toFixed(1)} at ${fmtTime(h.time)}${h.fishable ? '' : ' (outside usual hours for this species)'}` }));
  const table = el('table');
  for (const p of h.parts) {
    table.append(
      el(
        'tr',
        {},
        el('td', {}, el('div', { text: p.label }), el('div', { class: 'n', text: p.note ?? '' })),
        el('td', { class: `v ${p.value > 0 ? 'pos' : p.value < 0 ? 'neg' : ''}`, text: signed(p.value) }),
      ),
    );
  }
  const capped = h.raw > WEIGHTS.softCapStart;
  table.append(el('tr', { class: 'total' }, el('td', { text: capped ? `Total (raw ${h.raw.toFixed(1)}, soft-capped)` : 'Total' }), el('td', { class: 'v', text: h.score.toFixed(1) })));
  box.append(table);
  return box;
}

function renderHourTable(day) {
  const det = el('details');
  det.append(el('summary', { text: 'Hourly table' }));
  const t = el('table', { class: 'hour-table' });
  const head = el('tr');
  for (const k of ['Hour', 'Score', 'Air °C', 'Rain mm', 'Cloud %', 'Wind mph', 'hPa', 'Water °C']) head.append(el('th', { text: k }));
  t.append(head);
  for (const h of day.hours) {
    const row = el('tr');
    for (const v of [fmtHour(h.time), h.score.toFixed(1), Math.round(h.temp), (h.precip || 0).toFixed(1), Math.round(h.cloud), Math.round(h.wind), Math.round(h.pressure), h.waterTemp.toFixed(1)]) row.append(el('td', { text: String(v) }));
    t.append(row);
  }
  det.append(el('div', { class: 'table-wrap' }, t));
  return det;
}

// ---- about -----------------------------------------------------------------
function renderAbout() {
  const body = $('#aboutBody');
  body.replaceChildren();
  const p = (t) => body.append(el('p', { text: t }));
  p('Score = season base + additive weather/water/canal components, clamped 0–5. Above 4.0 every extra point counts one third, so a true 5.0 needs an exceptional day. Each component is a single mechanism, so "overcast" and "dusk" never double-count — they both act through the light component.');
  p(`Water temperature is estimated as a ${Math.round((WATER_TAU_HOURS / 24) * 10) / 10}-day exponential average of air temperature plus a small solar term (a 1.3 m canal lags air by 2–3 days). Canal colour is a run-off + boat-wash index with a ${COLOUR_HALF_LIFE_HOURS} h half-life; where an Environment Agency rain gauge is within 15 km its observations replace modelled past rain. Both are proxies, not measurements — read the water when you arrive.`);
  p('Day score = mean of the best three fishable hours (the session you would actually fish), not a 24 h average.');
  p('Weights follow the evidence: season, water temperature, light and clarity carry the score (telemetry and catch-rate studies). Barometric pressure and solunar periods showed no direct effect in controlled angling studies, so they are small tie-breakers; a ±3-day new/full-moon bonus is kept because two large datasets found a real ~5% effect. Wind direction has no weight — "east wind" acts through temperature and cloud, which are already scored.');

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const t = el('table');
  const hd = el('tr', {}, el('th', { text: 'Season base' }));
  for (const m of months) hd.append(el('th', { text: m }));
  t.append(hd);
  for (const sp of Object.keys(SEASON)) {
    const r = el('tr', {}, el('td', { text: PROFILES[sp].label }));
    for (const v of SEASON[sp]) r.append(el('td', { class: 'num', text: v.toFixed(1) }));
    t.append(r);
  }
  body.append(el('div', { class: 'table-wrap' }, t));

  const t2 = el('table');
  t2.append(el('tr', {}, el('th', { text: 'Water temp (est.) °C' }), el('th', { text: 'Perch' }), el('th', { text: 'Pike' }), el('th', { text: 'Zander' })));
  for (const [lo, hi, label] of [
    [-99, 4, '< 4'],
    [4, 6, '4–6'],
    [6, 9, '6–9'],
    [9, 12, '9–12'],
    [12, 14, '12–14'],
    [14, 18, '14–18'],
    [18, 21, '18–21'],
    [21, 24, '21–24'],
    [24, 99, '> 24'],
  ]) {
    const mid = lo === -99 ? 2 : hi === 99 ? 26 : (lo + hi) / 2;
    const r = el('tr', {}, el('td', { text: label }));
    for (const sp of ['perch', 'pike', 'zander']) {
      const v = WATER_TEMP[sp].find(([a, b]) => mid >= a && mid < b)?.[2] ?? 0;
      r.append(el('td', { class: 'num', text: signed(v) }));
    }
    t2.append(r);
  }
  body.append(el('div', { class: 'table-wrap' }, t2));

  const t3 = el('table');
  t3.append(el('tr', {}, el('th', { text: 'Component' }), el('th', { text: 'Perch' }), el('th', { text: 'Pike' }), el('th', { text: 'Zander' })));
  const row = (label, f) => {
    const r = el('tr', {}, el('td', { text: label }));
    for (const sp of ['perch', 'pike', 'zander']) r.append(el('td', { class: 'num', text: f(PROFILES[sp]) }));
    t3.append(r);
  };
  row('Light: dark', (pr) => signed(pr.night));
  row('Light: first 3h after dusk', (pr) => signed(pr.afterDusk));
  row('Light: dawn/dusk (Oct–Apr; ×0.6 midsummer)', (pr) => signed(pr.twilight));
  row('Light: overcast day (≈)', (pr) => signed(pr.dayBase - pr.daySlope * 0.3));
  row('Light: clear midday (≈)', (pr) => signed(pr.dayBase - pr.daySlope * 1.0));
  row('Rain light / moderate / heavy', (pr) => `${signed(pr.rain.light)} / ${signed(pr.rain.moderate)} / ${signed(pr.rain.heavy)}`);
  row('Colour: coloured / chocolate', (pr) => {
    const at = (v) => pr.colour.find(([a, b]) => v >= a && v < b)?.[2] ?? 0;
    return `${signed(at(18))} / ${signed(at(30))}`;
  });
  row('Boats: busy / moderate', (pr) => `${signed(pr.boats.busy)} / ${signed(pr.boats.normal)}`);
  row('Wind 13–20 mph', (pr) => signed(pr.windFresh));
  row('Cold snap multiplier', (pr) => `×${pr.coldSnap}`);
  body.append(el('div', { class: 'table-wrap' }, t3));

  const t4 = el('table');
  t4.append(el('tr', {}, el('th', { text: 'Shared component' }), el('th', { text: 'Points' })));
  const shared = [
    ['Pressure falling ≥ 3 hPa/24h (tie-breaker)', WEIGHTS.pressure.falling],
    ['Pressure rising ≥ 8 hPa + clearing + colder', WEIGHTS.pressure.risingClearingCold],
    ['Cold snap: 3-day mean −5 °C', WEIGHTS.tempShock.drop5],
    ['Mild spell: 3-day mean +3 °C (Nov–Mar)', WEIGHTS.tempShock.mildSpell],
    ['Summer cooling, pike only (water > 16 °C)', WEIGHTS.tempShock.summerCoolingPike],
    ['Wind 4–12 mph ripple', WEIGHTS.wind.ripple],
    ['Wind 21–28 / > 28 mph', `${signed(WEIGHTS.wind.strong)} / ${signed(WEIGHTS.wind.gale)}`],
    ['Gusts ≥ 30 mph', WEIGHTS.wind.gusty],
    ['Flat calm & bright', WEIGHTS.wind.flatBright],
    ['Frost with water < 3 °C', WEIGHTS.frost],
    ['Thunderstorm', WEIGHTS.thunder],
    ['New/full moon ±3 days', WEIGHTS.moon.syzygy],
    ['Dark night, zander only', WEIGHTS.moon.darkNightZander],
    ['Solunar major / minor (opt-in, traditional)', `${signed(WEIGHTS.solunar.major)} / ${signed(WEIGHTS.solunar.minor)}`],
  ];
  for (const [k, v] of shared) t4.append(el('tr', {}, el('td', { text: k }), el('td', { class: 'num', text: typeof v === 'number' ? signed(v) : v })));
  body.append(el('div', { class: 'table-wrap' }, t4));
  p('Evidence grades and sources for every weight are in ALGORITHM.md in the repository.');
}

// ---- location dialog -------------------------------------------------------
function openLocation() {
  const dlg = $('#locDialog');
  $('#locName').value = state.loc?.name ?? '';
  $('#locLat').value = state.loc?.lat ?? '';
  $('#locLng').value = state.loc?.lng ?? '';
  $('#solunarToggle').checked = state.solunar;
  $('#geoMsg').textContent = '';
  const spots = $('#spots');
  spots.replaceChildren();
  for (const p of PRESETS) {
    spots.append(
      el(
        'button',
        {
          type: 'button',
          'aria-selected': String(state.loc?.name === p.name),
          onclick: () => {
            $('#locName').value = p.name;
            $('#locLat').value = p.lat;
            $('#locLng').value = p.lng;
          },
        },
        p.name,
        el('small', { text: `${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}` }),
      ),
    );
  }
  dlg.showModal();
}

async function applyLocation(loc) {
  state.loc = loc;
  save();
  render();
  try {
    await loadData();
    compute();
    render();
  } catch (e) {
    setStatus(`Couldn't fetch forecast: ${e.message}`, true);
  }
}

function wireUi() {
  document.querySelectorAll('.species [role=tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.species = b.dataset.species;
      state.selectedHour = null;
      save();
      compute();
      render();
    }),
  );
  document.querySelectorAll('.views [role=tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      state.selectedHour = null;
      state.selectedDay = null;
      compute();
      render();
    }),
  );
  $('#locBtn').addEventListener('click', openLocation);
  $('#locCancel').addEventListener('click', () => $('#locDialog').close());
  $('#locSave').addEventListener('click', () => {
    const lat = Number($('#locLat').value);
    const lng = Number($('#locLng').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      $('#geoMsg').textContent = 'Enter a valid latitude/longitude.';
      return;
    }
    state.solunar = $('#solunarToggle').checked;
    $('#locDialog').close();
    applyLocation({ name: $('#locName').value.trim() || `${lat.toFixed(3)}, ${lng.toFixed(3)}`, lat, lng });
  });
  $('#geoBtn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      $('#geoMsg').textContent = 'Geolocation unavailable.';
      return;
    }
    $('#geoMsg').textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $('#locLat').value = pos.coords.latitude.toFixed(4);
        $('#locLng').value = pos.coords.longitude.toFixed(4);
        if (!$('#locName').value) $('#locName').value = 'My position';
        $('#geoMsg').textContent = `±${Math.round(pos.coords.accuracy)} m`;
      },
      (err) => {
        $('#geoMsg').textContent = err.message;
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  });
  window.addEventListener('online', () => applyLocation(state.loc));
  // Refresh the "now" marker and hero each minute without refetching.
  setInterval(() => {
    if (state.wx && state.view === 'forecast') renderHero();
  }, 60000);
}

async function main() {
  load();
  wireUi();
  renderAbout();
  if ('serviceWorker' in navigator && !PREVIEW && location.protocol.startsWith('http') && !new URLSearchParams(location.search).has('nosw')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (!state.loc) {
    state.loc = PRESETS[0];
    render();
  }
  await applyLocation(state.loc);
}

main();
