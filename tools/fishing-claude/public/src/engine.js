// Canal predator feeding forecast — deterministic scoring engine.
//
// Input: normalised hourly weather series (see data.js) + location/time context.
// Output: per-hour scores with an itemised breakdown, plus per-day summaries.
//
// Design principles
//  * Additive components on a 0–5 scale with a soft cap above 4, so the reader
//    can see exactly WHY a score is what it is.
//  * Every component is one physical mechanism. Light (sun angle × cloud × fog)
//    is one component, so "overcast" and "dusk" don't double-count.
//  * Weights live in SEASON / WATER_TEMP / PROFILES / WEIGHTS and nowhere else.
//  * Weights follow the evidence review in ALGORITHM.md: well-evidenced factors
//    (season, water temperature, light, clarity) carry the score; folklore
//    factors (pressure, solunar) are small tie-breakers.

import { sunAltitudeDeg, getSolunarPeriods, solunarAt, getMoonIllumination, moonPhaseName, getSunTimes } from './astro.js';
import { localParts, midnightForDateKey, dayOfYear } from './timezone.js';

export const SPECIES = ['perch', 'pike', 'zander'];

// Mid-month seasonal base (Jan..Dec), interpolated by day of year. Shape from
// the angler-consensus month tables (ALGORITHM.md §7) scaled so modifiers have
// room; perch late-Aug/early-Sep anchored to the user's own 2.6 / 2.8.
export const SEASON = {
  perch: [2.0, 2.2, 2.4, 1.4, 1.8, 2.1, 2.1, 2.4, 2.8, 3.1, 3.0, 2.4],
  pike: [2.3, 2.6, 2.0, 1.3, 1.6, 1.3, 0.7, 0.7, 1.6, 2.6, 2.9, 2.9],
  zander: [2.3, 2.3, 2.0, 1.3, 1.3, 2.0, 2.3, 2.3, 2.6, 2.9, 2.9, 2.6],
};

// Water-temperature bands [lo, hi, points] on the canal water-temp PROXY.
// Perch: Craig 1977 activity ∝ temp; specialists say big perch rarely feed <4 °C.
// Pike: Casselman 1978 peak 15–18, much less active <6; PAC welfare stop ≥18.
// Zander: thermal generalist (Frisk 2012, 10–27 °C plateau).
export const WATER_TEMP = {
  perch: [
    [-99, 2, -0.8],
    [2, 4, -0.5],
    [4, 8, -0.1],
    [8, 18, 0.5],
    [18, 23, 0.1],
    [23, 99, -0.3],
  ],
  pike: [
    [-99, 4, -0.3],
    [4, 6, -0.1],
    [6, 9, 0.2],
    [9, 18, 0.5],
    [18, 20, -0.6],
    [20, 99, -1.2],
  ],
  zander: [
    [-99, 4, -0.2],
    [4, 10, 0.2],
    [10, 27, 0.4],
    [27, 99, -0.3],
  ],
};

// Per-species constants for light, rain, colour and boat components.
export const PROFILES = {
  perch: {
    label: 'Perch',
    night: -0.4, // true dark: visual feeder, essentially inactive (Craig 1977)
    twilight: 0.8, // dawn/dusk band (scaled by season, see twilightSeasonFactor)
    afterDusk: -0.4, // first 3h after civil dusk = night for perch
    dayBase: 0.8, // day score = dayBase - daySlope * brightness
    daySlope: 1.5,
    brightColourRelief: 0.3, // bright-midday penalty shrinks this much in coloured water
    rain: { light: 0.3, moderate: 0.1, heavy: -0.2 },
    colour: [
      [0, 5, 0.1],
      [5, 12, 0],
      [12, 25, -0.35],
      [25, 999, -0.7],
    ],
    boats: { busy: -0.3, normal: -0.15, shoulder: -0.05 },
    windFresh: -0.15,
    coldSnap: 1.0,
    fishableNight: false,
  },
  pike: {
    label: 'Pike',
    night: -0.2,
    twilight: 0.5,
    afterDusk: -0.1,
    dayBase: 0.5,
    daySlope: 0.8,
    brightColourRelief: 0,
    rain: { light: 0.2, moderate: 0.1, heavy: -0.2 },
    colour: [
      [0, 12, 0],
      [12, 25, 0.1],
      [25, 999, 0],
    ],
    boats: { busy: -0.2, normal: -0.1, shoulder: -0.05 },
    windFresh: 0.1, // pike CPUE rose with wind (Kuparinen 2010)
    coldSnap: 1.0,
    fishableNight: false,
  },
  zander: {
    label: 'Zander',
    night: 0.4, // deep night: fish present but mostly resting (Horký 2008)
    twilight: 0.7,
    afterDusk: 0.9, // dusk → ~3h after: the primary window
    dayBase: 0.2,
    daySlope: 1.5,
    brightColourRelief: 0.5, // coloured water flattens zander's diel curve
    rain: { light: 0.2, moderate: 0.2, heavy: 0.1 },
    colour: [
      [0, 5, 0],
      [5, 12, 0.25],
      [12, 999, 0.5],
    ],
    boats: { busy: -0.15, normal: -0.05, shoulder: 0 },
    windFresh: 0,
    coldSnap: 0.5,
    fishableNight: true,
  },
};

export const WEIGHTS = {
  // Tie-breakers only: controlled studies find no direct pressure effect.
  pressure: { falling: 0.2, risingClearingCold: -0.3 },
  // 3-day mean vs previous 3-day mean of air temperature.
  tempShock: { drop5: -0.5, mildSpell: 0.3, summerCoolingPike: 0.2 },
  wind: { flatBright: -0.1, ripple: 0.15, strong: -0.5, gale: -0.8, gusty: -0.3 },
  moon: { syzygy: 0.15, darkNightZander: 0.1 },
  solunar: { major: 0.15, minor: 0.05 }, // opt-in, "traditional"
  thunder: -0.5,
  frost: -0.5,
  pikeWelfareTemp: 18,
  softCapStart: 4.0,
  softCapDivisor: 3,
};

// Water-temperature proxy: exponential moving average of air temperature with
// a 2.5-day time constant (τ = ρ·cp·h/K for h≈1.3 m, K≈25 W/m²K), plus a small
// solar-gain term, floored at 0 °C.
export const WATER_TAU_HOURS = 60;
export const WATER_SOLAR_GAIN = 1.5; // °C at a 24h-mean brightness of 1.0
// Canal colour proxy: run-off + boat-wash accumulator, ~2-day half-life.
export const COLOUR_HALF_LIFE_HOURS = 48;
export const BOAT_COLOUR_INPUT = { busy: 0.6, normal: 0.3, shoulder: 0.1, none: 0 }; // mm-equivalent per hour

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const band = (bands, v) => {
  for (const [lo, hi, pts] of bands) if (v >= lo && v < hi) return pts;
  return 0;
};

const MONTH_MID_DOY = [15, 46, 75, 105, 136, 166, 197, 228, 258, 289, 319, 350];

/** Seasonal base for a species on a given day of year (linear between mid-months). */
export function seasonBase(species, doy) {
  const vals = SEASON[species];
  let i = MONTH_MID_DOY.findIndex((m) => m > doy);
  if (i === -1) i = 0;
  const j = (i + 11) % 12;
  let a = MONTH_MID_DOY[j];
  let b = MONTH_MID_DOY[i];
  let x = doy;
  if (i === 0) {
    b += 365;
    if (x < a) x += 365;
  }
  const t = (x - a) / (b - a);
  return vals[j] + (vals[i] - vals[j]) * t;
}

/** Crepuscular peaks are strongest Oct–Apr and flatten in midsummer (Craig 1977; Jacobsen 2002). */
export function twilightSeasonFactor(month) {
  if (month >= 10 || month <= 4) return 1.0;
  if (month === 5 || month === 9) return 0.8;
  return 0.6; // Jun–Aug
}

export function softCap(raw) {
  const { softCapStart, softCapDivisor } = WEIGHTS;
  if (raw <= 0) return 0;
  if (raw <= softCapStart) return raw;
  return Math.min(5, softCapStart + (raw - softCapStart) / softCapDivisor);
}

/** Brightness 0..1: 0 at night, ~1 at clear noon, ~0.3 overcast noon. */
export function brightness(sunAltDeg, cloudPct, visibilityM) {
  if (sunAltDeg <= 0) return 0;
  const elev = Math.sqrt(Math.sin((sunAltDeg * Math.PI) / 180));
  const cloud = Number.isFinite(cloudPct) ? clamp(cloudPct, 0, 100) : 50;
  let b = elev * (1 - 0.7 * cloud / 100);
  if (Number.isFinite(visibilityM) && visibilityM < 2000) b *= 0.5;
  return clamp(b, 0, 1);
}

export function ratingLabel(score) {
  if (score >= 4.2) return 'Excellent';
  if (score >= 3.4) return 'Good';
  if (score >= 2.6) return 'Fair';
  if (score >= 1.8) return 'Poor';
  return 'Stay home';
}

/** Canal water temperature proxy. `bright` (optional) is the hourly brightness series for solar gain. */
export function waterTempSeries(temps, bright, tauHours = WATER_TAU_HOURS) {
  const alpha = 1 - Math.exp(-1 / tauHours);
  const out = new Array(temps.length);
  const n0 = Math.min(24, temps.length);
  let acc = temps.slice(0, n0).reduce((s, v) => s + v, 0) / Math.max(1, n0);
  let sun = 0;
  const alphaSun = 1 - Math.exp(-1 / 24);
  for (let i = 0; i < temps.length; i++) {
    const t = Number.isFinite(temps[i]) ? temps[i] : acc;
    acc = acc + alpha * (t - acc);
    if (bright) sun = sun + alphaSun * ((bright[i] || 0) - sun);
    out[i] = Math.max(0, acc + WATER_SOLAR_GAIN * sun);
  }
  return out;
}

/** Decaying run-off + boat-wash accumulator = canal colour proxy (mm-equivalent). */
export function colourSeries(precip, boatInput, halfLifeHours = COLOUR_HALF_LIFE_HOURS) {
  const k = Math.pow(0.5, 1 / halfLifeHours);
  const out = new Array(precip.length);
  let acc = 0;
  for (let i = 0; i < precip.length; i++) {
    acc = acc * k + (Number.isFinite(precip[i]) ? precip[i] : 0) + (boatInput ? boatInput[i] || 0 : 0);
    out[i] = acc;
  }
  return out;
}

export function colourLabel(v) {
  if (v < 5) return 'clear';
  if (v < 12) return 'tinged';
  if (v < 25) return 'coloured';
  return 'chocolate';
}

function meanRange(arr, from, to) {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(arr.length, to); i++) {
    if (Number.isFinite(arr[i])) {
      s += arr[i];
      n++;
    }
  }
  return n ? s / n : NaN;
}

/**
 * Boat traffic class for a local hour. Canals are busiest Apr–Oct daytime,
 * with weekends/bank holidays and the Jul–Aug hire-boat peak busiest of all.
 * Nov–Mar most traffic stops (CRT winter stoppages, few hire boats).
 */
export function boatTraffic({ month, hour, weekday, isBankHoliday }) {
  const daytime = hour >= 9 && hour < 18;
  if (!daytime) return 'none';
  const weekendish = weekday === 0 || weekday === 6 || isBankHoliday;
  if (month >= 5 && month <= 9) {
    if (weekendish || month === 7 || month === 8) return 'busy';
    return 'normal';
  }
  if (month === 4 || month === 10) return weekendish ? 'normal' : 'shoulder';
  if (month === 3 || month === 11) return weekendish ? 'shoulder' : 'none';
  return 'none';
}

/** PAC guidance: refrain from targeting pike 16 Jun – 1 Oct and whenever water ≥ 18 °C. */
export function pikeSummerBreak(month, day) {
  return (month === 6 && day >= 16) || month === 7 || month === 8 || (month === 9 && day <= 30);
}

/**
 * Score every hour for one species.
 * @param {object} wx normalised hourly weather (see data.js) — arrays aligned to wx.time (unix s)
 * @param {object} ctx { lat, lng, tz, species, bankHolidays:Set<'YYYY-MM-DD'>, solunar:boolean }
 */
export function scoreHours(wx, ctx) {
  const species = ctx.species || 'perch';
  const prof = PROFILES[species];
  const tz = ctx.tz || 'Europe/London';
  const n = wx.time.length;

  // Pass 1: per-hour local calendar, sun altitude, brightness, boat traffic.
  const lps = new Array(n);
  const alts = new Array(n);
  const brights = new Array(n);
  const boats = new Array(n);
  const boatInput = new Array(n);
  for (let i = 0; i < n; i++) {
    const date = new Date(wx.time[i] * 1000);
    const lp = localParts(date, tz);
    lps[i] = lp;
    alts[i] = sunAltitudeDeg(date, ctx.lat, ctx.lng);
    brights[i] = brightness(alts[i], wx.cloud[i], wx.visibility ? wx.visibility[i] : NaN);
    boats[i] = boatTraffic({ month: lp.month, hour: lp.hour, weekday: lp.weekday, isBankHoliday: ctx.bankHolidays?.has(lp.dateKey) });
    boatInput[i] = BOAT_COLOUR_INPUT[boats[i]];
  }
  const water = waterTempSeries(wx.temp, brights);
  const colour = colourSeries(wx.precip, boatInput);

  const perDay = new Map(); // dateKey -> { dusk, solunar, moon }
  const dayInfo = (lp) => {
    let d = perDay.get(lp.dateKey);
    if (!d) {
      const midnight = midnightForDateKey(lp.dateKey, tz);
      const noon = new Date(midnight.valueOf() + 43200000);
      const sun = getSunTimes(noon, ctx.lat, ctx.lng);
      d = {
        dusk: sun.dusk ? sun.dusk.valueOf() / 1000 : NaN,
        solunar: ctx.solunar ? getSolunarPeriods(midnight, ctx.lat, ctx.lng).periods : null,
        moon: getMoonIllumination(noon),
      };
      perDay.set(lp.dateKey, d);
    }
    return d;
  };

  const results = [];
  for (let i = 0; i < n; i++) {
    const t = wx.time[i];
    const date = new Date(t * 1000);
    const lp = lps[i];
    const parts = [];
    const flags = [];
    const add = (key, label, value, note) => {
      if (Math.abs(value) < 0.001 && !note) return;
      parts.push({ key, label, value: round2(value), note });
    };

    // 1. Season
    const doy = dayOfYear(lp.year, lp.month, lp.day);
    const base = seasonBase(species, doy);
    add('season', 'Season', base, `${prof.label} in ${date.toLocaleString('en-GB', { month: 'long', timeZone: tz })}`);

    // 2. Light: sun angle × cloud × fog, with a species-specific diel curve.
    const alt = alts[i];
    const cloud = wx.cloud[i];
    const B = brights[i];
    const c = colour[i];
    const coloured = c >= 12;
    const di = dayInfo(lp);
    // "After dusk" = the 3h following civil dusk (yesterday's dusk for the small hours).
    let sinceDusk = Number.isFinite(di.dusk) ? t - di.dusk : NaN;
    if (Number.isFinite(sinceDusk) && sinceDusk < 0) {
      const y = localParts(new Date((t - 86400) * 1000), tz);
      const yd = dayInfo(y);
      sinceDusk = Number.isFinite(yd.dusk) ? t - yd.dusk : NaN;
    }
    let lightPts;
    let lightNote;
    if (alt < -6) {
      if (Number.isFinite(sinceDusk) && sinceDusk >= 0 && sinceDusk < 3 * 3600) {
        lightPts = prof.afterDusk;
        lightNote = 'first hours after dusk';
      } else {
        lightPts = prof.night;
        lightNote = 'dark';
      }
    } else if (alt < 10) {
      lightPts = prof.twilight * twilightSeasonFactor(lp.month) - 0.3 * B;
      lightNote = alt < 0 ? 'twilight' : 'low sun';
      if (twilightSeasonFactor(lp.month) < 1) lightNote += ' (summer: weaker peak)';
    } else {
      const relief = coloured ? prof.brightColourRelief : 0;
      lightPts = prof.dayBase - prof.daySlope * B * (1 - relief);
      lightNote = cloud >= 70 ? `overcast ${Math.round(cloud)}%` : cloud >= 40 ? `partly cloudy ${Math.round(cloud)}%` : `bright, ${Math.round(cloud)}% cloud`;
      const vis = wx.visibility ? wx.visibility[i] : NaN;
      if (Number.isFinite(vis) && vis < 2000) lightNote += ', murky/fog';
      if (relief && B > 0.5) lightNote += ', coloured water softens glare';
    }
    add('light', 'Light', lightPts, lightNote);

    // 3. Water temperature proxy
    const tw = water[i];
    add('water', 'Water temp', band(WATER_TEMP[species], tw), `~${tw.toFixed(1)}°C (est.)`);
    if (species === 'pike' && tw >= WEIGHTS.pikeWelfareTemp) flags.push('pikeWelfare');
    if (species === 'pike' && pikeSummerBreak(lp.month, lp.day)) flags.push('pikeSummer');

    // 4. Air-temperature trend: 3-day mean vs previous 3-day mean
    if (i >= 144) {
      const recent = meanRange(wx.temp, i - 72, i);
      const before = meanRange(wx.temp, i - 144, i - 72);
      const delta = recent - before;
      const ws = WEIGHTS.tempShock;
      if (delta <= -5) add('trend', 'Cold snap', ws.drop5 * prof.coldSnap, `${delta.toFixed(1)}°C vs previous 3 days`);
      else if (delta >= 3 && (lp.month >= 11 || lp.month <= 3)) add('trend', 'Mild spell', ws.mildSpell, `+${delta.toFixed(1)}°C vs previous 3 days`);
      else if (species === 'pike' && delta <= -2 && tw > 16) add('trend', 'Summer cooling', ws.summerCoolingPike, `${delta.toFixed(1)}°C, water easing off`);
    } else if (i >= 48) {
      const recent = meanRange(wx.temp, i - 24, i);
      const before = meanRange(wx.temp, i - 48, i - 24);
      const delta = recent - before;
      if (delta <= -5) add('trend', 'Cold snap', WEIGHTS.tempShock.drop5 * prof.coldSnap, `${delta.toFixed(1)}°C in 24h`);
    }

    // 5. Pressure — tie-breaker only (no direct effect in controlled studies).
    if (i >= 24 && Number.isFinite(wx.pressure[i]) && Number.isFinite(wx.pressure[i - 24])) {
      const d24 = wx.pressure[i] - wx.pressure[i - 24];
      const tempDrop = i >= 48 ? meanRange(wx.temp, i - 24, i) - meanRange(wx.temp, i - 48, i - 24) : 0;
      let pts = 0;
      let note = `${d24 >= 0 ? '+' : ''}${d24.toFixed(1)} hPa/24h`;
      if (d24 <= -3) {
        pts = WEIGHTS.pressure.falling;
        note += ', falling (weather on the move)';
      } else if (d24 >= 8 && cloud < 30 && tempDrop < -1) {
        pts = WEIGHTS.pressure.risingClearingCold;
        note += ', post-frontal: rising, clearing, colder';
      } else note += d24 >= 3 ? ', rising' : ', steady';
      add('pressure', 'Pressure', pts, note);
    }

    // 6. Rain now (small: rain mostly acts via light and colour)
    const p = wx.precip[i] || 0;
    const code = wx.weatherCode ? wx.weatherCode[i] : 0;
    if (code >= 95) {
      add('rain', 'Thunder', WEIGHTS.thunder, 'thunderstorm — stay off the bank');
      flags.push('thunder');
    } else if (p >= 4) add('rain', 'Rain', prof.rain.heavy, `heavy ${p.toFixed(1)} mm/h`);
    else if (p >= 1.5) add('rain', 'Rain', prof.rain.moderate, `moderate ${p.toFixed(1)} mm/h`);
    else if (p >= 0.1) add('rain', 'Rain', prof.rain.light, `light ${p.toFixed(1)} mm/h`);

    // 7. Canal colour (rain run-off + boat wash)
    add('colour', 'Water colour', band(prof.colour, c), `${colourLabel(c)} (index ${c.toFixed(0)})`);

    // 8. Wind (speed only; direction acts through air mass = temperature/cloud)
    const wind = wx.wind[i];
    const gust = wx.gust ? wx.gust[i] : NaN;
    const ww = WEIGHTS.wind;
    if (Number.isFinite(wind)) {
      let pts = 0;
      let note = `${Math.round(wind)} mph`;
      if (wind > 28) {
        pts = ww.gale;
        note += ', gale';
      } else if (wind > 20) {
        pts = ww.strong;
        note += ', strong';
      } else if (wind > 12) {
        pts = prof.windFresh;
        note += ', fresh';
      } else if (wind >= 4) {
        pts = ww.ripple;
        note += ', good ripple';
      } else if (B > 0.5) {
        pts = ww.flatBright;
        note += ', flat calm & bright';
      } else note += ', calm';
      if (Number.isFinite(gust) && gust >= 30) {
        pts += ww.gusty;
        note += `, gusts ${Math.round(gust)}`;
      }
      add('wind', 'Wind', pts, note);
    }

    // 9. Boat traffic disturbance (colour effect already in the colour index)
    const traffic = boats[i];
    if (traffic !== 'none') add('boats', 'Boat traffic', prof.boats[traffic], traffic === 'busy' ? 'busy — weekend/holiday/peak season' : traffic === 'normal' ? 'moderate' : 'light');

    // 10. Frost / ice
    const airMin24 = i >= 24 ? Math.min(...wx.temp.slice(i - 24, i + 1).filter(Number.isFinite)) : wx.temp[i];
    if (tw < 3 && airMin24 < -1) {
      add('frost', 'Frost', WEIGHTS.frost, `air min ${airMin24.toFixed(0)}°C`);
      if (tw < 1.5 && airMin24 < -3) flags.push('ice');
    }

    // 11. Moon: small syzygy effect (Kuparinen 2010; Vinson & Angradi 2014).
    const phase = di.moon.phase;
    const distNew = Math.min(phase, 1 - phase);
    const distFull = Math.abs(phase - 0.5);
    const daysFromSyzygy = Math.min(distNew, distFull) * 29.53;
    if (daysFromSyzygy <= 3) add('moon', 'Moon', WEIGHTS.moon.syzygy, `${distFull < distNew ? 'full' : 'new'} moon ±3 days`);
    if (species === 'zander' && alt < -6 && (di.moon.fraction < 0.25 || cloud >= 80)) add('moon', 'Dark night', WEIGHTS.moon.darkNightZander, di.moon.fraction < 0.25 ? 'little moonlight' : 'overcast night');

    // 12. Solunar periods — opt-in, traditional; no predictive value in controlled tests.
    if (di.solunar) {
      const hit = solunarAt(date, di.solunar);
      if (hit) add('solunar', 'Solunar', WEIGHTS.solunar[hit], `${hit} period (traditional)`);
    }

    const raw = parts.reduce((s, x) => s + x.value, 0);
    const score = round1(softCap(raw));
    const fishable = prof.fishableNight || alt >= -8;
    results.push({
      time: t,
      dateKey: lp.dateKey,
      hour: lp.hour,
      score,
      raw: round2(raw),
      parts,
      flags,
      fishable,
      sunAlt: round1(alt),
      brightness: round1(B),
      waterTemp: round1(tw),
      colour: round1(c),
      temp: wx.temp[i],
      wind,
      precip: p,
      cloud,
      pressure: wx.pressure[i],
      traffic,
    });
  }
  return results;
}

/**
 * Collapse hourly results into per-day summaries. The day score is the mean of
 * the best 3 fishable hours (≈ "how good is the best session you could fish"),
 * not the daily mean — nobody fishes 24 hours.
 */
export function summariseDays(hours, ctx, { fromTime = 0 } = {}) {
  const tz = ctx.tz || 'Europe/London';
  const byDay = new Map();
  for (const h of hours) {
    if (h.time < fromTime) continue;
    if (!byDay.has(h.dateKey)) byDay.set(h.dateKey, []);
    byDay.get(h.dateKey).push(h);
  }
  const days = [];
  for (const [dateKey, hs] of byDay) {
    const fishable = hs.filter((h) => h.fishable);
    if (fishable.length < 3) continue; // partial day at the series edge
    const top3 = [...fishable].sort((a, b) => b.score - a.score).slice(0, 3);
    const score = round1(top3.reduce((s, h) => s + h.score, 0) / 3);

    // Best contiguous 3h window among fishable hours.
    let best = null;
    for (let i = 0; i + 2 < fishable.length; i++) {
      const a = fishable[i];
      const c = fishable[i + 2];
      if (c.time - a.time !== 7200) continue;
      const sum = a.score + fishable[i + 1].score + c.score;
      if (!best || sum > best.sum) best = { sum, start: a.time, end: c.time + 3600 };
    }

    // Peaks: fishable hours within 0.4 of the day's best hour, grouped into windows.
    const maxScore = Math.max(...fishable.map((h) => h.score));
    const windows = [];
    let cur = null;
    for (const h of fishable) {
      const good = h.score >= maxScore - 0.4 && h.score >= 2.6;
      if (good && cur && h.time - cur.end === 0) cur.end = h.time + 3600;
      else if (good) {
        cur = { start: h.time, end: h.time + 3600, peak: h.score };
        windows.push(cur);
      } else cur = null;
      if (good && cur) cur.peak = Math.max(cur.peak, h.score);
    }

    const mid = hs.find((h) => h.hour === 12) || hs[Math.floor(hs.length / 2)];
    const pressurePart = mid.parts.find((p) => p.key === 'pressure');
    const midnight = midnightForDateKey(dateKey, tz);
    const noon = new Date(midnight.valueOf() + 43200000);
    const moon = getMoonIllumination(noon);
    const sol = ctx.solunar ? getSolunarPeriods(midnight, ctx.lat, ctx.lng).periods : [];
    const flags = [...new Set(hs.flatMap((h) => h.flags))];

    days.push({
      dateKey,
      score,
      label: ratingLabel(score),
      bestWindow: best ? { start: best.start, end: best.end, score: round1(best.sum / 3) } : null,
      windows,
      hours: hs,
      waterTemp: mid.waterTemp,
      colour: mid.colour,
      colourLabel: colourLabel(mid.colour),
      pressureNote: pressurePart?.note ?? null,
      tempRange: [Math.min(...hs.map((h) => h.temp)), Math.max(...hs.map((h) => h.temp))].map(round1),
      rainTotal: round1(hs.reduce((s, h) => s + (h.precip || 0), 0)),
      windMax: Math.round(Math.max(...hs.map((h) => h.wind || 0))),
      cloudMean: Math.round(hs.reduce((s, h) => s + (h.cloud || 0), 0) / hs.length),
      traffic: hs.some((h) => h.traffic === 'busy') ? 'busy' : hs.some((h) => h.traffic === 'normal') ? 'moderate' : hs.some((h) => h.traffic === 'shoulder') ? 'light' : 'quiet',
      moon: { phase: moon.phase, fraction: round1(moon.fraction), name: moonPhaseName(moon.phase) },
      solunar: sol,
      flags,
    });
  }
  return days;
}

/** Convenience: full forecast for one species. */
export function forecast(wx, ctx, opts) {
  const hours = scoreHours(wx, ctx);
  const days = summariseDays(hours, ctx, opts);
  return { hours, days };
}
