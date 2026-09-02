import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seasonBase,
  softCap,
  brightness,
  waterTempSeries,
  colourSeries,
  boatTraffic,
  scoreHours,
  summariseDays,
  ratingLabel,
  twilightSeasonFactor,
  pikeSummerBreak,
  BOAT_COLOUR_INPUT,
} from '../public/src/engine.js';

const LAT = 52.41;
const LNG = -1.51;
const TZ = 'Europe/London';
const ctxFor = (species, extra = {}) => ({ lat: LAT, lng: LNG, tz: TZ, species, bankHolidays: new Set(), solunar: false, ...extra });

/** Build a synthetic hourly series of `days` days starting at `startIso`. */
function synth(startIso, days, fn) {
  const start = Math.floor(new Date(startIso).valueOf() / 1000);
  const n = days * 24;
  const wx = { time: [], temp: [], precip: [], cloud: [], pressure: [], wind: [], gust: [], windDir: [], weatherCode: [], visibility: [] };
  for (let i = 0; i < n; i++) {
    const t = start + i * 3600;
    const v = fn(i, i % 24);
    wx.time.push(t);
    wx.temp.push(v.temp ?? 15);
    wx.precip.push(v.precip ?? 0);
    wx.cloud.push(v.cloud ?? 50);
    wx.pressure.push(v.pressure ?? 1015);
    wx.wind.push(v.wind ?? 8);
    wx.gust.push(v.gust ?? 15);
    wx.windDir.push(v.windDir ?? 240);
    wx.weatherCode.push(v.weatherCode ?? 3);
    wx.visibility.push(v.visibility ?? 20000);
  }
  return wx;
}

test("season base interpolates and matches the user's anchors", () => {
  const aug30 = seasonBase('perch', 242);
  const sep5 = seasonBase('perch', 248);
  assert.ok(aug30 > 2.5 && aug30 < 2.7, `aug30 ${aug30}`);
  assert.ok(sep5 > 2.55 && sep5 < 2.85, `sep5 ${sep5}`);
  const d365 = seasonBase('perch', 365);
  const d1 = seasonBase('perch', 1);
  assert.ok(Math.abs(d365 - d1) < 0.05);
  // Pike: spawning dip and summer welfare trough vs winter peak.
  assert.ok(seasonBase('pike', 105) < seasonBase('pike', 319));
  assert.ok(seasonBase('pike', 210) < 1.0);
  // Perch October peak.
  assert.ok(seasonBase('perch', 289) >= seasonBase('perch', 228));
});

test('soft cap: linear to 4, then one third, hard cap 5', () => {
  assert.equal(softCap(3.2), 3.2);
  assert.equal(softCap(4.0), 4.0);
  assert.ok(Math.abs(softCap(5.6) - 4.533) < 0.01);
  assert.equal(softCap(9), 5);
  assert.equal(softCap(-1), 0);
});

test('brightness: night 0, clear noon ~1, overcast noon ~0.3, fog halves it, NaN cloud tolerated', () => {
  assert.equal(brightness(-5, 0), 0);
  assert.ok(brightness(60, 0) > 0.9);
  const overcast = brightness(60, 100);
  assert.ok(overcast > 0.25 && overcast < 0.35, `overcast ${overcast}`);
  assert.ok(brightness(60, 0, 500) < 0.5);
  assert.ok(Number.isFinite(brightness(40, NaN)));
});

test('twilight peaks strongest Oct–Apr, weakest Jun–Aug', () => {
  assert.equal(twilightSeasonFactor(11), 1);
  assert.equal(twilightSeasonFactor(7), 0.6);
  assert.ok(twilightSeasonFactor(9) > twilightSeasonFactor(7));
});

test('water temperature proxy lags air temperature; solar gain small and non-negative', () => {
  const temps = [...Array(72).fill(10), ...Array(72).fill(20)];
  const w = waterTempSeries(temps);
  assert.ok(Math.abs(w[71] - 10) < 0.01);
  const at60 = w[71 + 60];
  assert.ok(at60 > 15.5 && at60 < 17.5, `at60 ${at60}`);
  assert.ok(w[143] < 20);
  const sunny = waterTempSeries(temps, new Array(144).fill(0.4));
  assert.ok(sunny[143] - w[143] > 0.4 && sunny[143] - w[143] < 0.7);
  assert.ok(waterTempSeries(new Array(48).fill(-5)).every((v) => v >= 0));
});

test('colour proxy: 48h half-life, boats keep a summer canal permanently tinged/coloured', () => {
  const p = new Array(100).fill(0);
  p[0] = 20;
  const c = colourSeries(p);
  assert.ok(Math.abs(c[0] - 20) < 1e-9);
  assert.ok(Math.abs(c[48] - 10) < 0.05, `half-life ${c[48]}`);
  // Busy boat traffic 9 hours/day for 3 weeks with no rain: settles in the coloured band.
  const n = 21 * 24;
  const boats = Array.from({ length: n }, (_, i) => (i % 24 >= 9 && i % 24 < 18 ? BOAT_COLOUR_INPUT.busy : 0));
  const cb = colourSeries(new Array(n).fill(0), boats);
  const noonLast = cb[n - 12];
  assert.ok(noonLast >= 12 && noonLast < 25, `summer boat colour ${noonLast}`);
});

test('boat traffic classes and pike summer break', () => {
  assert.equal(boatTraffic({ month: 8, hour: 13, weekday: 2, isBankHoliday: false }), 'busy');
  assert.equal(boatTraffic({ month: 6, hour: 13, weekday: 2, isBankHoliday: false }), 'normal');
  assert.equal(boatTraffic({ month: 6, hour: 13, weekday: 6, isBankHoliday: false }), 'busy');
  assert.equal(boatTraffic({ month: 6, hour: 7, weekday: 6, isBankHoliday: false }), 'none');
  assert.equal(boatTraffic({ month: 1, hour: 13, weekday: 6, isBankHoliday: false }), 'none');
  assert.equal(boatTraffic({ month: 9, hour: 13, weekday: 1, isBankHoliday: true }), 'busy');
  assert.equal(pikeSummerBreak(7, 10), true);
  assert.equal(pikeSummerBreak(6, 15), false);
  assert.equal(pikeSummerBreak(10, 1), false);
});

test("user's example day (30 Aug, showers, overcast, falling pressure, 16°C) is a Good/Excellent perch day", () => {
  // A week of 16°C lead-in so the water proxy settles; pressure falling 4 hPa/day; showers on the day.
  const wx = synth('2026-08-23T00:00:00Z', 8, (i) => ({
    temp: 16,
    cloud: 85,
    precip: i >= 168 ? 0.8 : 0,
    pressure: 1022 - i * (4 / 24),
    wind: 8,
  }));
  const hours = scoreHours(wx, ctxFor('perch'));
  const day = summariseDays(hours, ctxFor('perch')).find((d) => d.dateKey === '2026-08-30');
  assert.ok(day, 'expected 30 Aug summary');
  assert.ok(day.score >= 3.8 && day.score <= 4.6, `score ${day.score}`);
  const keys = new Set(day.hours[12].parts.map((p) => p.key));
  for (const k of ['season', 'light', 'water', 'pressure', 'rain', 'colour', 'wind']) assert.ok(keys.has(k), `missing ${k}`);
  // Pressure is a tie-breaker now: never more than +0.2.
  const pr = day.hours[12].parts.find((p) => p.key === 'pressure');
  assert.ok(pr.value <= 0.2);
});

test('bright, calm, post-frontal day is poor for perch at noon; zander peak is the hours after dusk', () => {
  const wx = synth('2026-10-01T00:00:00Z', 8, (i) => ({
    temp: i < 96 ? 16 : 11,
    cloud: 5,
    precip: 0,
    pressure: i < 96 ? 1005 : 1005 + Math.min(i - 96, 48) * 0.25,
    wind: 3,
  }));
  const perchDay = summariseDays(scoreHours(wx, ctxFor('perch')), ctxFor('perch')).find((d) => d.dateKey === '2026-10-07');
  const zander = scoreHours(wx, ctxFor('zander')).filter((h) => h.dateKey === '2026-10-07');
  const perchNoon = perchDay.hours.find((h) => h.hour === 13);
  assert.ok(perchNoon.score < 3.4, `perch noon ${perchNoon.score} should not rate Good`);
  assert.ok(perchDay.bestWindow && perchDay.score > perchNoon.score + 0.7, 'perch should still get a dawn/dusk window');
  const zNoon = zander.find((h) => h.hour === 13);
  const zDusk = zander.find((h) => h.hour === 20); // civil dusk ~19:20 BST in early Oct
  const zLate = zander.find((h) => h.hour === 2);
  assert.ok(zDusk.score > zNoon.score + 1.2, `zander dusk ${zDusk.score} vs noon ${zNoon.score}`);
  assert.ok(zDusk.score > zLate.score, `after-dusk ${zDusk.score} should beat deep night ${zLate.score}`);
  assert.ok(zDusk.parts.find((p) => p.key === 'light').note.includes('after dusk'));
});

test('heavy rain colours the canal: perch penalised, zander rewarded', () => {
  const wx = synth('2026-10-01T00:00:00Z', 4, (i) => ({
    temp: 12,
    cloud: 90,
    precip: i >= 48 && i < 60 ? 5 : 0,
    pressure: 1010,
    wind: 10,
  }));
  const perch = scoreHours(wx, ctxFor('perch'));
  const zander = scoreHours(wx, ctxFor('zander'));
  const idx = 72 + 12;
  const pc = perch[idx].parts.find((p) => p.key === 'colour');
  const zc = zander[idx].parts.find((p) => p.key === 'colour');
  assert.ok(pc.value < -0.3, `perch colour ${pc.value}`);
  assert.ok(zc.value > 0.2, `zander colour ${zc.value}`);
  assert.ok(perch[idx].colour > 25);
});

test('cold snap (3-day means) and frost are penalised; ice flag raised', () => {
  const wx = synth('2027-01-04T00:00:00Z', 9, (i) => ({
    temp: i < 96 ? 6 : -4,
    cloud: 20,
    pressure: 1030,
    wind: 4,
  }));
  const hours = scoreHours(wx, ctxFor('perch'));
  const h = hours[96 + 60];
  assert.ok(h.parts.some((p) => p.key === 'trend' && p.value <= -0.4), 'cold snap missing');
  const late = hours[hours.length - 1];
  assert.ok(late.parts.some((p) => p.key === 'frost'), 'frost missing');
  assert.ok(late.flags.includes('ice'));
  assert.equal(ratingLabel(late.score), 'Stay home');
});

test('pike: welfare flag at ≥18°C water and summer break flag; summer cooling bonus', () => {
  const wx = synth('2026-07-10T00:00:00Z', 8, (i) => ({ temp: i < 96 ? 24 : 19, cloud: 60 }));
  const hours = scoreHours(wx, ctxFor('pike'));
  const mid = hours[100];
  assert.ok(mid.flags.includes('pikeWelfare'));
  assert.ok(mid.flags.includes('pikeSummer'));
  assert.ok(mid.parts.find((p) => p.key === 'water').value <= -0.6);
  const cooling = hours.slice(150).some((h) => h.parts.some((p) => p.key === 'trend' && p.label === 'Summer cooling'));
  assert.ok(cooling, 'summer cooling bonus expected for pike');
});

test('moon: syzygy bonus within ±3 days of full moon, absent at quarter', () => {
  // Full moon 2026-09-26 16:49 UTC; first quarter 2026-09-18.
  const wx = synth('2026-09-10T00:00:00Z', 20, () => ({ temp: 14, cloud: 60 }));
  const hours = scoreHours(wx, ctxFor('perch'));
  const atFull = hours.find((h) => h.dateKey === '2026-09-26' && h.hour === 12);
  const atQuarter = hours.find((h) => h.dateKey === '2026-09-18' && h.hour === 12);
  assert.ok(atFull.parts.some((p) => p.key === 'moon'), 'syzygy bonus missing at full moon');
  assert.ok(!atQuarter.parts.some((p) => p.key === 'moon'), 'unexpected moon bonus at quarter');
});

test('solunar periods only when opted in, and never worth more than 0.15', () => {
  const wx = synth('2026-09-10T00:00:00Z', 3, () => ({ temp: 14, cloud: 60 }));
  const off = scoreHours(wx, ctxFor('perch', { solunar: false }));
  const on = scoreHours(wx, ctxFor('perch', { solunar: true }));
  assert.ok(off.every((h) => !h.parts.some((p) => p.key === 'solunar')));
  const sol = on.flatMap((h) => h.parts.filter((p) => p.key === 'solunar'));
  assert.ok(sol.length > 0);
  assert.ok(sol.every((p) => p.value <= 0.15));
});

test('scores are bounded 0..5 and every part is a finite number under extreme input', () => {
  const wx = synth('2026-06-01T00:00:00Z', 3, (i) => ({
    temp: 30,
    cloud: 0,
    precip: 12,
    pressure: 1040 - i,
    wind: 45,
    gust: 60,
    weatherCode: 96,
  }));
  const hours = scoreHours(wx, ctxFor('pike', { solunar: true }));
  for (const h of hours) {
    assert.ok(h.score >= 0 && h.score <= 5, `score ${h.score}`);
    for (const p of h.parts) assert.ok(Number.isFinite(p.value), `${p.key} not finite`);
    assert.ok(h.flags.includes('thunder'));
  }
});

test('NaN weather values (model gaps) do not poison the score', () => {
  const wx = synth('2026-09-01T00:00:00Z', 3, (i) => ({ temp: i % 7 === 0 ? NaN : 15, cloud: NaN, precip: NaN, pressure: NaN, wind: NaN, visibility: NaN }));
  const hours = scoreHours(wx, ctxFor('perch'));
  for (const h of hours) assert.ok(Number.isFinite(h.score), `score NaN at ${h.time}`);
});
