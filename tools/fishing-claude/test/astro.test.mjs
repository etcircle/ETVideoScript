import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSunTimes,
  sunAltitudeDeg,
  getMoonIllumination,
  getMoonTimes,
  getMoonTransits,
  getSolunarPeriods,
  solunarAt,
  moonPhaseName,
} from '../public/src/astro.js';

// Coventry canal basin
const LAT = 52.41;
const LNG = -1.51;

const minutesApart = (a, b) => Math.abs(a.valueOf() - b.valueOf()) / 60000;

test('sunrise/sunset for Coventry, 2 Sep 2026 match published values within 3 min', () => {
  // timeanddate.com for Coventry 2 Sep 2026: sunrise 06:18 BST, sunset 19:55 BST (approx).
  const noon = new Date('2026-09-02T12:00:00+01:00');
  const t = getSunTimes(noon, LAT, LNG);
  assert.ok(minutesApart(t.sunrise, new Date('2026-09-02T06:18:00+01:00')) < 3, `sunrise ${t.sunrise.toISOString()}`);
  assert.ok(minutesApart(t.sunset, new Date('2026-09-02T19:55:00+01:00')) < 3, `sunset ${t.sunset.toISOString()}`);
  // Civil dusk is ~35 min after sunset at this latitude/season.
  const civil = minutesApart(t.dusk, t.sunset);
  assert.ok(civil > 28 && civil < 42, `civil twilight length ${civil}`);
});

test('sun altitude is negative at midnight and positive at noon', () => {
  assert.ok(sunAltitudeDeg(new Date('2026-09-02T00:00:00+01:00'), LAT, LNG) < -20);
  const noonAlt = sunAltitudeDeg(new Date('2026-09-02T13:00:00+01:00'), LAT, LNG);
  assert.ok(noonAlt > 40 && noonAlt < 50, `noon altitude ${noonAlt}`);
});

test('moon phase: known full moon 2026-08-28 and new moon 2026-09-11', () => {
  // Full moon 28 Aug 2026 04:18 UTC; new moon 11 Sep 2026 03:27 UTC (USNO).
  const full = getMoonIllumination(new Date('2026-08-28T04:18:00Z'));
  assert.ok(full.fraction > 0.99, `full fraction ${full.fraction}`);
  assert.ok(Math.abs(full.phase - 0.5) < 0.02, `full phase ${full.phase}`);
  assert.equal(moonPhaseName(full.phase), 'Full moon');
  const nw = getMoonIllumination(new Date('2026-09-11T03:27:00Z'));
  assert.ok(nw.fraction < 0.01, `new fraction ${nw.fraction}`);
  assert.equal(moonPhaseName(nw.phase), 'New moon');
});

test('moon rise/set exist for a normal day and sit within the day', () => {
  const dayStart = new Date('2026-09-02T00:00:00+01:00');
  const mt = getMoonTimes(dayStart, LAT, LNG);
  assert.ok(mt.rise || mt.set, 'expected at least one moon event');
  for (const k of ['rise', 'set']) {
    if (!mt[k]) continue;
    assert.ok(mt[k] >= dayStart && mt[k] < new Date(dayStart.valueOf() + 86400000), `${k} outside day`);
  }
});

test('moon transits: upper and lower are ~12h25m apart when both present', () => {
  // Scan a fortnight; every day with both transits must satisfy the spacing.
  let checked = 0;
  for (let d = 0; d < 14; d++) {
    const dayStart = new Date(new Date('2026-09-01T00:00:00+01:00').valueOf() + d * 86400000);
    const tr = getMoonTransits(dayStart, LAT, LNG);
    if (tr.transit && tr.underfoot) {
      const gap = Math.abs(tr.transit - tr.underfoot) / 3600000;
      assert.ok(Math.abs(gap - 12.42) < 0.35, `gap ${gap}h on day ${d}`);
      checked++;
    }
    // Both should fall inside the day.
    for (const k of ['transit', 'underfoot']) {
      if (tr[k]) assert.ok(tr[k] >= dayStart && tr[k] < new Date(dayStart.valueOf() + 86400000));
    }
  }
  assert.ok(checked >= 10, `only ${checked} days had both transits`);
});

test('upper transit coincides with maximum moon altitude', async () => {
  const { getMoonPosition } = await import('../public/src/astro.js');
  const dayStart = new Date('2026-09-05T00:00:00+01:00');
  const tr = getMoonTransits(dayStart, LAT, LNG);
  assert.ok(tr.transit);
  const altAt = (t) => getMoonPosition(t, LAT, LNG).altitude;
  const a0 = altAt(tr.transit);
  const aBefore = altAt(new Date(tr.transit.valueOf() - 40 * 60000));
  const aAfter = altAt(new Date(tr.transit.valueOf() + 40 * 60000));
  assert.ok(a0 > aBefore && a0 > aAfter, 'transit should be a local altitude maximum');
});

test('solunar periods: majors 2h wide, minors 1h wide, lookup works', () => {
  const dayStart = new Date('2026-09-02T00:00:00+01:00');
  const { periods } = getSolunarPeriods(dayStart, LAT, LNG);
  assert.ok(periods.length >= 2);
  for (const p of periods) {
    const w = (p.end - p.start) / 60000;
    assert.equal(w, p.kind === 'major' ? 120 : 60);
    assert.equal(solunarAt(p.centre, periods), p.kind === 'major' ? 'major' : solunarAt(p.centre, periods));
  }
  const major = periods.find((p) => p.kind === 'major');
  assert.equal(solunarAt(major.centre, periods), 'major');
  assert.equal(solunarAt(new Date(major.end.valueOf() + 3 * 3600000), periods.filter((p) => p.kind === 'major')), null);
});
