// Sun / moon / solunar calculations. Pure functions, no dependencies.
// Algorithms follow Meeus "Astronomical Algorithms" as popularised by SunCalc
// (Vladimir Agafonkin, BSD-2). Accuracy: sun times ~1 min, moon times ~2-3 min —
// more than enough for a fishing forecast.

const PI = Math.PI;
const rad = PI / 180;
const dayMs = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const e = rad * 23.4397; // obliquity of the Earth

const toJulian = (date) => date.valueOf() / dayMs - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * dayMs);
const toDays = (date) => toJulian(date) - J2000;

const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const azimuth = (H, phi, dec) => Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
const altitude = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;

function astroRefraction(h) {
  if (h < 0) h = 0; // formula only valid for h >= 0
  return 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
}

// ---- Sun -------------------------------------------------------------------

const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);

function eclipticLongitude(M) {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = rad * 102.9372; // perihelion of the Earth
  return M + C + P + PI;
}

function sunCoords(d) {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

/** Sun azimuth/altitude in radians for a Date at lat/lng (degrees). */
export function getSunPosition(date, lat, lng) {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(date);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  return { azimuth: azimuth(H, phi, c.dec), altitude: altitude(H, phi, c.dec) };
}

/** Sun altitude in DEGREES — the quantity the scoring engine uses. */
export function sunAltitudeDeg(date, lat, lng) {
  return getSunPosition(date, lat, lng).altitude / rad;
}

const J0 = 0.0009;
const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * PI));
const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * PI) + n;
const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
const hourAngle = (h, phi, d) => Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));

function getSetJ(h, lw, phi, dec, n, M, L) {
  const w = hourAngle(h, phi, dec);
  const a = approxTransit(w, lw, n);
  return solarTransitJ(a, M, L);
}

const SUN_TIMES = [
  [-0.833, 'sunrise', 'sunset'],
  [-6, 'dawn', 'dusk'], // civil twilight
  [-12, 'nauticalDawn', 'nauticalDusk'],
];

/**
 * Sun event times for the day containing `date` (which should be ~local noon
 * for unambiguous results). Returns Dates, or null for events that don't occur
 * (polar cases — irrelevant in the Midlands but handled).
 */
export function getSunTimes(date, lat, lng) {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L, 0);
  const Jnoon = solarTransitJ(ds, M, L);
  const result = { solarNoon: fromJulian(Jnoon), nadir: fromJulian(Jnoon - 0.5) };
  for (const [angle, riseName, setName] of SUN_TIMES) {
    const Jset = getSetJ(angle * rad, lw, phi, dec, n, M, L);
    if (Number.isNaN(Jset)) {
      result[riseName] = null;
      result[setName] = null;
    } else {
      const Jrise = Jnoon - (Jset - Jnoon);
      result[riseName] = fromJulian(Jrise);
      result[setName] = fromJulian(Jset);
    }
  }
  return result;
}

// ---- Moon ------------------------------------------------------------------

function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d); // ecliptic longitude
  const M = rad * (134.963 + 13.064993 * d); // mean anomaly
  const F = rad * (93.272 + 13.22935 * d); // mean distance
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  const dt = 385001 - 20905 * Math.cos(M); // km
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
}

/** Moon position; also returns the local hour angle (radians, -PI..PI). */
export function getMoonPosition(date, lat, lng) {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(date);
  const c = moonCoords(d);
  let H = siderealTime(d, lw) - c.ra;
  H = Math.atan2(Math.sin(H), Math.cos(H)); // normalise to -PI..PI
  let h = altitude(H, phi, c.dec);
  h += astroRefraction(h);
  return { azimuth: azimuth(H, phi, c.dec), altitude: h, distance: c.dist, hourAngle: H };
}

/**
 * Moon illumination. `phase` is 0..1: 0 new, 0.25 first quarter, 0.5 full,
 * 0.75 last quarter. `fraction` is illuminated fraction 0..1.
 */
export function getMoonIllumination(date) {
  const d = toDays(date);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sdist = 149598000; // km, Earth-Sun
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra),
  );
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / PI, angle };
}

export function moonPhaseName(phase) {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.03 || p > 0.97) return 'New moon';
  if (p < 0.22) return 'Waxing crescent';
  if (p < 0.28) return 'First quarter';
  if (p < 0.47) return 'Waxing gibbous';
  if (p < 0.53) return 'Full moon';
  if (p < 0.72) return 'Waning gibbous';
  if (p < 0.78) return 'Last quarter';
  return 'Waning crescent';
}

const hoursLater = (date, h) => new Date(date.valueOf() + h * 3600000);

/**
 * Moonrise / moonset within the 24h starting at `dayStart` (a Date at local
 * midnight). Either may be undefined on days without that event.
 * `alwaysUp` / `alwaysDown` flag the edge cases.
 */
export function getMoonTimes(dayStart, lat, lng) {
  const t = new Date(dayStart.valueOf());
  const hc = 0.133 * rad;
  let h0 = getMoonPosition(t, lat, lng).altitude - hc;
  let rise;
  let set;
  let ye = 0;
  for (let i = 1; i <= 24; i += 2) {
    const h1 = getMoonPosition(hoursLater(t, i), lat, lng).altitude - hc;
    const h2 = getMoonPosition(hoursLater(t, i + 1), lat, lng).altitude - hc;
    const a = (h0 + h2) / 2 - h1;
    const b = (h2 - h0) / 2;
    const xe = -b / (2 * a);
    ye = (a * xe + b) * xe + h1;
    const dsc = b * b - 4 * a * h1;
    let roots = 0;
    let x1 = 0;
    let x2 = 0;
    if (dsc >= 0) {
      const dx = Math.sqrt(dsc) / (Math.abs(a) * 2);
      x1 = xe - dx;
      x2 = xe + dx;
      if (Math.abs(x1) <= 1) roots++;
      if (Math.abs(x2) <= 1) roots++;
      if (x1 < -1) x1 = x2;
    }
    if (roots === 1) {
      if (h0 < 0) rise = i + x1;
      else set = i + x1;
    } else if (roots === 2) {
      rise = i + (ye < 0 ? x2 : x1);
      set = i + (ye < 0 ? x1 : x2);
    }
    if (rise !== undefined && set !== undefined) break;
    h0 = h2;
  }
  const result = {};
  if (rise !== undefined) result.rise = hoursLater(t, rise);
  if (set !== undefined) result.set = hoursLater(t, set);
  if (rise === undefined && set === undefined) result[ye > 0 ? 'alwaysUp' : 'alwaysDown'] = true;
  return result;
}

/**
 * Moon upper transit (overhead) and lower transit (underfoot) within the 24h
 * from `dayStart`, found by scanning the hour angle for zero / ±PI crossings
 * at 5-minute resolution then interpolating. Each may be absent on a given day
 * (the lunar day is ~24h50m so roughly one day a month lacks one).
 */
export function getMoonTransits(dayStart, lat, lng) {
  const stepMin = 5;
  const steps = (24 * 60) / stepMin;
  let prev = getMoonPosition(dayStart, lat, lng).hourAngle;
  const result = {};
  for (let i = 1; i <= steps; i++) {
    const t = new Date(dayStart.valueOf() + i * stepMin * 60000);
    const H = getMoonPosition(t, lat, lng).hourAngle;
    // Upper transit: H crosses 0 going negative -> positive.
    if (prev < 0 && H >= 0 && H - prev < PI) {
      const f = -prev / (H - prev);
      result.transit = new Date(t.valueOf() - (1 - f) * stepMin * 60000);
    }
    // Lower transit: H wraps from near +PI to near -PI.
    if (prev > 0 && H < 0 && prev - H > PI) {
      const f = (PI - prev) / (PI - prev + (H + PI));
      result.underfoot = new Date(t.valueOf() - (1 - f) * stepMin * 60000);
    }
    prev = H;
  }
  return result;
}

/**
 * Solunar periods for one day. Majors: ±1h around moon transit/underfoot.
 * Minors: ±30min around moonrise/moonset. These are the conventional
 * definitions from Knight's solunar tables; the evidence for them in
 * freshwater is weak, so the engine only gives them a small weight.
 */
export function getSolunarPeriods(dayStart, lat, lng) {
  const transits = getMoonTransits(dayStart, lat, lng);
  const times = getMoonTimes(dayStart, lat, lng);
  const periods = [];
  const push = (kind, centre, halfWidthMin) => {
    if (!centre) return;
    periods.push({
      kind,
      start: new Date(centre.valueOf() - halfWidthMin * 60000),
      end: new Date(centre.valueOf() + halfWidthMin * 60000),
      centre,
    });
  };
  push('major', transits.transit, 60);
  push('major', transits.underfoot, 60);
  push('minor', times.rise, 30);
  push('minor', times.set, 30);
  periods.sort((a, b) => a.start - b.start);
  return { periods, transits, moonTimes: times };
}

/** Returns 'major' | 'minor' | null for a given instant. */
export function solunarAt(date, periods) {
  const t = date.valueOf();
  let hit = null;
  for (const p of periods) {
    if (t >= p.start.valueOf() && t <= p.end.valueOf()) {
      if (p.kind === 'major') return 'major';
      hit = 'minor';
    }
  }
  return hit;
}
