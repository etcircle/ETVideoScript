// Environment Agency flood-monitoring API: real rain-gauge observations to
// replace modelled past rainfall. Free, no key, CORS `*`, OGL v3 licence.
// https://environment.data.gov.uk/flood-monitoring/doc/reference

export const EA_BASE = 'https://environment.data.gov.uk/flood-monitoring';

const toRad = (d) => (d * Math.PI) / 180;
export function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest active rainfall gauge within `distKm`, or null. */
export async function findRainGauge({ lat, lng }, { distKm = 15, fetchImpl = fetch } = {}) {
  const url = `${EA_BASE}/id/stations?parameter=rainfall&lat=${lat.toFixed(4)}&long=${lng.toFixed(4)}&dist=${distKm}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`EA stations ${res.status}`);
  const json = await res.json();
  const items = (json.items ?? [])
    .map((s) => {
      const measure = (s.measures ?? []).find((m) => m.parameter === 'rainfall' && /15_min/.test(m['@id'] ?? ''));
      const sLat = Number(s.lat);
      const sLng = Number(s.long);
      if (!measure || !Number.isFinite(sLat) || !Number.isFinite(sLng)) return null;
      return {
        stationReference: s.stationReference,
        label: s.label ?? s.stationReference,
        lat: sLat,
        lng: sLng,
        measureId: measure['@id'],
        km: distanceKm(lat, lng, sLat, sLng),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.km - b.km);
  return items[0] ?? null;
}

/**
 * Hourly rainfall totals (mm) from a gauge since `sinceUnix`, keyed by the
 * hour's start (unix seconds). Only hours with ≥3 of 4 quarter-hour readings
 * are returned, so a gap never masquerades as "dry".
 */
export async function fetchGaugeHourly(gauge, sinceUnix, { fetchImpl = fetch } = {}) {
  const since = new Date(sinceUnix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const url = `${gauge.measureId}/readings?_sorted&since=${encodeURIComponent(since)}&_limit=2000`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`EA readings ${res.status}`);
  const json = await res.json();
  const buckets = new Map();
  for (const r of json.items ?? []) {
    const t = Date.parse(r.dateTime);
    const v = Number(r.value);
    if (!Number.isFinite(t) || !Number.isFinite(v) || v < 0) continue;
    // A reading stamped HH:15 covers the 15 min ending then; bucket by hour start.
    const hourStart = Math.floor((t / 1000 - 1) / 3600) * 3600;
    const b = buckets.get(hourStart) ?? { sum: 0, n: 0 };
    b.sum += v;
    b.n += 1;
    buckets.set(hourStart, b);
  }
  const out = new Map();
  for (const [h, b] of buckets) if (b.n >= 3) out.set(h, Math.round(b.sum * 100) / 100);
  return out;
}

/**
 * Overwrite modelled past precipitation in `wx` with gauge observations where
 * we have complete hours. Returns how many hours were replaced.
 */
export function applyGaugeRain(wx, hourly, nowUnix = Date.now() / 1000) {
  let replaced = 0;
  for (let i = 0; i < wx.time.length; i++) {
    const t = wx.time[i];
    if (t + 3600 > nowUnix) break;
    if (hourly.has(t)) {
      wx.precip[i] = hourly.get(t);
      replaced++;
    }
  }
  return replaced;
}
