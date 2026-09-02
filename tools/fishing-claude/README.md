# Fishing Claude

Hour-by-hour feeding forecast for **perch, pike and zander** on Midlands canals, scored from free, key-less data and installable on your phone. Static files only — no build, no backend, no accounts.

- Scoring spec and evidence: [`ALGORITHM.md`](./ALGORITHM.md)
- Engine: [`public/src/engine.js`](./public/src/engine.js) (pure functions; all weights are constants at the top)
- Data: Open-Meteo (weather, 14 days back + 8 ahead), Environment Agency rain gauges, GOV.UK bank holidays, on-device sun/moon maths

## Run it

```bash
cd tools/fishing-claude
npm test              # node --test, no dependencies
npm run serve         # http://127.0.0.1:4390  (python3 http.server)
```

Open `http://127.0.0.1:4390/?mock=1` for a deterministic synthetic fortnight when you have no network. Add `&nosw=1` to skip the service worker while developing.

## Put it on your phone

**GitHub Pages (recommended).** `.github/workflows/fishing-claude-pages.yml` runs the tests and deploys `tools/fishing-claude/public` on pushes to `main`. One-time setup: repo *Settings → Pages → Source: GitHub Actions*. Then open the Pages URL on your phone and *Add to Home Screen* (Android: Chrome menu → Install app; iOS: Share → Add to Home Screen).

**LAN.** `npm run serve` on any machine on your Wi-Fi, then `http://<lan-ip>:4390` on the phone. Service-worker install needs HTTPS or `localhost`, so over plain HTTP on the LAN you get the app but not offline caching.

## Using it

**Forecast** — the hero card is *now*; the strip below is the next 7 days. Tap a day for its hourly chart, then tap any hour to see the itemised reason for its score (season + light + water temp + colour + …, with the soft cap shown when it bites).

**History** — the last 14 days scored from recorded weather, with a daily bar chart, a "Good" threshold line and period stats. This is the calibration view: compare it against your own catch log. If your good sessions cluster above 3.4 the weights are working; if they don't, tune them (below).

**Species** — perch / pike / zander switch the whole model, not just a label: different season curves, thermal bands, diel windows and reaction to coloured water. Pike carry PAC welfare warnings (≥18 °C, and the 16 Jun – 1 Oct summer break); zander carry a Schedule 9 permit reminder.

**Location** — tap the chip. Presets cover Solihull (Grand Union at Catherine-de-Barnes, Stratford Canal at Shirley), Leamington (Grand Union town centre and Radford Semele), Warwick, Hawkesbury, Braunston, Gas Street, Fradley and Market Bosworth; or use your GPS position, or type a lat/lng. Weather grids are 2–10 km so precision doesn't matter much.

The forecast is cached, so the last one you loaded still shows on the towpath with no signal (the status line says how old it is).

## Tuning

Everything lives in `public/src/engine.js`: `SEASON`, `WATER_TEMP`, `PROFILES`, `WEIGHTS`, `WATER_TAU_HOURS`, `COLOUR_HALF_LIFE_HOURS`, `BOAT_COLOUR_INPUT`. The in-app "How the score is built" panel renders those constants, so the documentation can't drift from the code. Run `npm test` after changing them — the tests pin the behaviours that matter (the 30 Aug reference day, perch-vs-zander divergence on bright and coloured days, cold snaps, pike welfare, NaN tolerance).

## Layout

```
public/            served root (this is what GitHub Pages deploys)
  index.html, app.js, styles.css, sw.js, manifest.webmanifest, icons/
  src/engine.js    scoring
  src/astro.js     sun / moon / solunar (Meeus / SunCalc algorithms)
  src/data.js      Open-Meteo + bank holidays
  src/ea.js        Environment Agency rain gauges
  src/timezone.js  Europe/London helpers that also work in node
test/              node --test suites
scripts/           icon generator (zero-dependency PNG encoder)
```

Weather data by [Open-Meteo](https://open-meteo.com/) (CC BY 4.0). Rainfall observations © Environment Agency (OGL v3).
