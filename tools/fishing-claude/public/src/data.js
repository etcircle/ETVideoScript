// Data layer: fetches free, key-less sources and normalises them for the engine.
//  * Open-Meteo forecast API — hourly weather, 14 days back + 8 ahead, no key,
//    CORS-enabled, ~10k calls/day for non-commercial use.
//  * gov.uk bank holidays JSON — for the boat-traffic component.
// Everything is wrapped so a failed optional source degrades gracefully.

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
export const BANK_HOLIDAYS_URL = 'https://www.gov.uk/bank-holidays.json';

export const HOURLY_VARS = [
  'temperature_2m',
  'precipitation',
  'cloud_cover',
  'pressure_msl',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'weather_code',
  'visibility',
];
export const DAILY_VARS = ['sunrise', 'sunset'];

export const PAST_DAYS = 14;
export const FORECAST_DAYS = 8;

export function buildForecastUrl({ lat, lng, tz = 'Europe/London', model }) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    hourly: HOURLY_VARS.join(','),
    daily: DAILY_VARS.join(','),
    timezone: tz,
    past_days: String(PAST_DAYS),
    forecast_days: String(FORECAST_DAYS),
    wind_speed_unit: 'mph',
    timeformat: 'unixtime',
  });
  if (model) q.set('models', model);
  return `${OPEN_METEO_URL}?${q.toString()}`;
}

const num = (v) => (v === null || v === undefined ? NaN : Number(v));

/** Normalise an Open-Meteo response into the engine's `wx` shape. */
export function normaliseOpenMeteo(json) {
  const h = json.hourly;
  if (!h || !Array.isArray(h.time)) throw new Error('Open-Meteo response missing hourly data');
  const map = (key) => (h[key] ? h[key].map(num) : new Array(h.time.length).fill(NaN));
  return {
    time: h.time.map(Number),
    temp: map('temperature_2m'),
    precip: map('precipitation'),
    cloud: map('cloud_cover'),
    pressure: map('pressure_msl'),
    wind: map('wind_speed_10m'),
    gust: map('wind_gusts_10m'),
    windDir: map('wind_direction_10m'),
    weatherCode: map('weather_code'),
    visibility: map('visibility'),
    daily: json.daily
      ? json.daily.time.map((t, i) => ({ time: Number(t), sunrise: num(json.daily.sunrise?.[i]), sunset: num(json.daily.sunset?.[i]) }))
      : [],
    elevation: json.elevation,
    generated: Date.now(),
  };
}

export async function fetchForecast(loc, { fetchImpl = fetch, model } = {}) {
  const url = buildForecastUrl({ ...loc, model });
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.reason || 'Open-Meteo error');
  return normaliseOpenMeteo(json);
}

/** England & Wales bank holidays as a Set of 'YYYY-MM-DD'. Optional source. */
export async function fetchBankHolidays({ fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(BANK_HOLIDAYS_URL);
    if (!res.ok) return new Set();
    const json = await res.json();
    const events = json['england-and-wales']?.events ?? [];
    return new Set(events.map((e) => e.date));
  } catch {
    return new Set();
  }
}

/** Human-readable label for a WMO weather code. */
export function weatherCodeLabel(code) {
  const c = Number(code);
  if (c === 0) return 'Clear';
  if (c === 1) return 'Mainly clear';
  if (c === 2) return 'Partly cloudy';
  if (c === 3) return 'Overcast';
  if (c === 45 || c === 48) return 'Fog';
  if (c >= 51 && c <= 55) return 'Drizzle';
  if (c >= 56 && c <= 57) return 'Freezing drizzle';
  if (c >= 61 && c <= 65) return c === 61 ? 'Light rain' : c === 63 ? 'Rain' : 'Heavy rain';
  if (c >= 66 && c <= 67) return 'Freezing rain';
  if (c >= 71 && c <= 77) return 'Snow';
  if (c >= 80 && c <= 82) return c === 80 ? 'Light showers' : c === 81 ? 'Showers' : 'Heavy showers';
  if (c >= 85 && c <= 86) return 'Snow showers';
  if (c >= 95) return 'Thunderstorm';
  return '—';
}
