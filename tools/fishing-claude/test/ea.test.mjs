import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRainGauge, fetchGaugeHourly, applyGaugeRain, distanceKm } from '../public/src/ea.js';

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test('distanceKm: Coventry to Birmingham ≈ 28 km', () => {
  const d = distanceKm(52.41, -1.51, 52.48, -1.9);
  assert.ok(d > 26 && d < 30, `${d}`);
});

test('findRainGauge picks the nearest station that has a 15-min rainfall measure', async () => {
  const fetchImpl = async () =>
    okJson({
      items: [
        { stationReference: 'FAR', label: 'Far', lat: 52.9, long: -1.5, measures: [{ parameter: 'rainfall', '@id': 'https://x/FAR-rainfall-tipping_bucket_raingauge-t-15_min-mm' }] },
        { stationReference: 'NEAR', label: 'Near', lat: 52.42, long: -1.52, measures: [{ parameter: 'rainfall', '@id': 'https://x/NEAR-rainfall-tipping_bucket_raingauge-t-15_min-mm' }] },
        { stationReference: 'DAILY', label: 'Daily only', lat: 52.41, long: -1.51, measures: [{ parameter: 'rainfall', '@id': 'https://x/DAILY-rainfall-t-1_day-mm' }] },
      ],
    });
  const g = await findRainGauge({ lat: 52.41, lng: -1.51 }, { fetchImpl });
  assert.equal(g.stationReference, 'NEAR');
  assert.ok(g.km < 2);
});

test('fetchGaugeHourly buckets quarter-hour readings and drops incomplete hours; applyGaugeRain only touches the past', async () => {
  const base = Date.UTC(2026, 8, 1, 6, 0, 0) / 1000; // 06:00Z
  const items = [];
  // Complete hour 06:00–07:00: readings stamped 06:15, 06:30, 06:45, 07:00 → 0.2 each = 0.8 mm
  for (const m of [15, 30, 45, 60]) items.push({ dateTime: new Date((base + m * 60) * 1000).toISOString(), value: 0.2 });
  // Incomplete hour 07:00–08:00: only two readings
  for (const m of [75, 90]) items.push({ dateTime: new Date((base + m * 60) * 1000).toISOString(), value: 1 });
  const fetchImpl = async () => okJson({ items });
  const hourly = await fetchGaugeHourly({ measureId: 'https://x/m' }, base - 3600, { fetchImpl });
  assert.equal(hourly.get(base), 0.8);
  assert.equal(hourly.has(base + 3600), false);

  const wx = { time: [base - 3600, base, base + 3600, base + 7200], precip: [9, 9, 9, 9] };
  const replaced = applyGaugeRain(wx, hourly, base + 7200 + 1800); // "now" is 08:30Z
  assert.equal(replaced, 1);
  assert.deepEqual(wx.precip, [9, 0.8, 9, 9]);
});
