# Fishing Claude — scoring algorithm

Species: **perch**, **pike**, **zander** on Midlands canals (~1.2–1.5 m deep, pound-regulated, boat-coloured).
Scale: 0–5 per hour; day score = mean of the best three fishable hours.

This document is the spec for `public/src/engine.js`. Every weight below is a constant in that file — change it there, the in-app "How the score is built" panel reads the same constants.

## 0. What changed from your original algorithm, and why

| Original (daily, perch only) | Now | Reason |
|---|---|---|
| Season base 2.6 / 2.8 (late Aug / early Sep) | 12-month curve per species, interpolated daily; perch anchored to your 2.6 / 2.8 | Needed year-round and for three species |
| Precipitation +1.0 light rain | +0.3 (perch) | Rain acts mainly through light and colour, which are scored directly; evidence grade B |
| Cloud cover as its own factor (+0.8 / +0.3 / −0.5) | Folded into a single **light** component = sun elevation × cloud × fog, with species-specific diel curve | Prevents double-counting dusk + overcast; makes hourly forecasts possible |
| Pressure falling +0.7 / rising −0.4 | Falling +0.2, post-frontal rise −0.3 (needs rise ≥ 8 hPa **and** clearing **and** colder) | Two controlled angling studies found **no** direct pressure effect (Kuparinen 2010; Escanaba 2021). What's real in the folklore is the covarying weather, already scored |
| Temperature (air) bands | **Water temperature proxy** (2.5-day EWMA of air + solar term) with species-specific bands; plus a 3-day **trend** term | Water, not air, drives fish; Casselman / Craig / Frisk give the bands |
| Wind speed thresholds | Kept, with ripple bonus and gust penalty; wind **direction weight 0** | "East wind" acts via air mass (temperature, cloud) — grade C on its own |
| Solunar +0.3 optional | Off by default, +0.15 major / +0.05 minor if enabled; **new/full moon ±3 days +0.15** on by default | Quigley 2023: solunar tables have zero predictive value; syzygy effect (~5%) is real in two large datasets |
| — | **Canal colour index** (rain run-off + boat wash, 48 h half-life) | The main perch-vs-zander differentiator (Ljunggren & Sandström 2007) |
| — | **Boat traffic** disturbance (season × weekday × bank holiday × hour) | Biggest non-weather driver on canals |
| — | Cold-snap / mild-spell / frost / ice / thunder / pike-welfare flags | Safety and welfare |
| Hard clamp at 5 | Soft cap: above 4.0 excess counts ⅓, hard cap 5 | Reproduces your "5.6 → ~4.5" behaviour explicitly |

## 1. Inputs (all free, no keys, fetched from the phone)

| Source | Used for |
|---|---|
| **Open-Meteo forecast API** (`past_days=14`, `forecast_days=8`, hourly `temperature_2m, precipitation, cloud_cover, pressure_msl, wind_speed_10m, wind_gusts_10m, wind_direction_10m, weather_code, visibility`) | Everything weather-side, incl. 14 days of history for the water-temperature proxy and pressure trend. CC BY 4.0 |
| **Environment Agency flood-monitoring API** — nearest 15-min rainfall gauge within 15 km | Observed rain replaces modelled past rain in the colour index (optional; CORS `*`, OGL v3) |
| **GOV.UK bank-holidays.json** | Boat-traffic weekend logic |
| **On-device astronomy** (Meeus / SunCalc algorithms in `astro.js`) | Sun altitude, civil dawn/dusk, moon phase, moon transit/underfoot and rise/set for solunar |

Not used, deliberately: Met Office DataHub (needs a key), Open-Meteo archive (2–5 day lag; `past_days` is better), CRT stoppage notices (no CORS — would need a scheduled snapshot), any water-temperature feed (none exists for canals).

## 2. Derived series

- **Water temperature proxy** `Tw = EWMA(air, τ = 60 h) + 1.5 × EWMA(brightness, 24 h)`, floored at 0 °C. τ from ρ·c<sub>p</sub>·h / K with h ≈ 1.3 m, K ≈ 25 W m⁻² K⁻¹ (Edinger 1968). Cross-check with a thermometer; feeders, lock flows and urban outfalls shift the offset.
- **Brightness** `B = √sin(sun altitude) × (1 − 0.7 × cloud/100)`, halved when visibility < 2 km. 0 at night, ≈1 clear noon, ≈0.3 overcast noon.
- **Colour index** `C[t] = C[t−1] × 0.5^(1/48) + rain_mm[t] + boat_input[t]` with boat input 0.6 / 0.3 / 0.1 mm-eq per hour for busy / moderate / light traffic. Bands: <5 clear, 5–12 tinged, 12–25 coloured, ≥25 chocolate. Calibrate against what you see.
- **Boat traffic** (09:00–18:00 only): May–Sep weekends/bank holidays and all of Jul–Aug → *busy*; May–Sep weekdays → *moderate*; Apr/Oct → moderate (weekend) / light (weekday); Mar/Nov weekends → light; otherwise none (CRT winter stoppages Nov–Mar).
- **Air-temperature trend** = mean(last 72 h) − mean(previous 72 h).

## 3. Components and weights

Evidence grade: **A** peer-reviewed on the species (or a close congener), **B** consistent angler consensus / transferred science, **C** folklore.

### 3.1 Season base (grade B, anchored by A for spawning and thermal windows)

| Month | Perch | Pike | Zander |
|---|---|---|---|
| Jan | 2.0 | 2.3 | 2.3 |
| Feb | 2.2 | 2.6 | 2.3 |
| Mar | 2.4 | 2.0 | 2.0 |
| Apr | 1.4 | 1.3 | 1.3 |
| May | 1.8 | 1.6 | 1.3 |
| Jun | 2.1 | 1.3 | 2.0 |
| Jul | 2.1 | 0.7 | 2.3 |
| Aug | 2.4 | 0.7 | 2.3 |
| Sep | 2.8 | 1.6 | 2.6 |
| Oct | 3.1 | 2.6 | 2.9 |
| Nov | 3.0 | 2.9 | 2.9 |
| Dec | 2.4 | 2.9 | 2.6 |

Perch spawn Mar–May at 9–13 °C; pike late Feb–Apr at 8–15 °C; zander Apr–May at 12–15 °C. The pike summer trough is welfare-driven (PAC: refrain 16 Jun – 1 Oct). Canals have **no statutory close season** (removed by byelaw in 2000) — check club rules.

### 3.2 Light (grade A for the diel pattern; thresholds are engineering choices)

| Regime | Perch | Pike | Zander |
|---|---|---|---|
| Dark (sun < −6°), not within 3 h of dusk | −0.4 | −0.2 | +0.4 |
| First 3 h after civil dusk | −0.4 | −0.1 | **+0.9** |
| Twilight / low sun (−6° … +10°) | +0.8 × S | +0.5 × S | +0.7 × S |
| Day (> +10°) | 0.8 − 1.5·B·(1 − R) | 0.5 − 0.8·B | 0.2 − 1.5·B·(1 − R) |

S = seasonal factor for crepuscular peaks: 1.0 Oct–Apr, 0.8 May/Sep, 0.6 Jun–Aug (Craig 1977; Jacobsen 2002). R = colour relief when C ≥ 12: 0.3 perch, 0.5 zander (coloured water flattens the diel curve — Angling Times consensus; Ljunggren & Sandström). Sources: Craig 1977; Jacobsen et al. 2002; Horký et al. 2008 (zander activity peaks at twilight, rests at night); Kuparinen et al. 2010 (pike CPUE highest at dusk).

### 3.3 Water temperature (grade A/B)

| Tw °C | Perch | Pike | Zander |
|---|---|---|---|
| < 2 | −0.8 | −0.3 | −0.2 |
| 2–4 | −0.5 | −0.3 | −0.2 |
| 4–6 | −0.1 | −0.1 | +0.2 |
| 6–8 | −0.1 | +0.2 | +0.2 |
| 8–9 | +0.5 | +0.2 | +0.2 |
| 9–10 | +0.5 | +0.5 | +0.2 |
| 10–18 | +0.5 | +0.5 | +0.4 |
| 18–20 | +0.1 | −0.6 ⚠ | +0.4 |
| 20–23 | +0.1 | −1.2 ⚠ | +0.4 |
| 23–27 | −0.3 | −1.2 ⚠ | +0.4 |
| > 27 | −0.3 | −1.2 ⚠ | −0.3 |

⚠ = pike welfare flag shown in the app (PAC: don't target pike at ≥ 18 °C). Sources: Craig 1977 (perch activity ∝ temperature); specialist consensus that big perch rarely feed < 4 °C; Casselman 1978 (pike peak 15–18 °C, markedly less active < 6 °C); Frisk et al. 2012 (zander aerobic-scope plateau 10–27 °C).

### 3.4 Trend (grade A/B)

- Cold snap: 3-day mean ≤ −5 °C vs previous 3 days → −0.5 (perch, pike), −0.25 (zander).
- Mild spell: ≥ +3 °C, Nov–Mar → +0.3.
- Summer cooling: pike only, ≤ −2 °C with Tw > 16 °C → +0.2 (Kuparinen: pike CPUE ↑ with lower water temperature).
- While < 6 days of history exist, a 24 h version of the cold-snap test is used.

### 3.5 Colour (grade A lab / B field)

| C index | Perch | Pike | Zander |
|---|---|---|---|
| < 5 clear | +0.1 | 0 | 0 |
| 5–12 tinged | 0 | 0 | +0.25 |
| 12–25 coloured | −0.35 | +0.1 | +0.5 |
| ≥ 25 chocolate | −0.7 | 0 | +0.5 |

Perch foraging falls sharply at ~25 NTU while pikeperch are unaffected (Ljunggren & Sandström 2007); a tinge may *raise* perch catchability (search activity ↑).

### 3.6 Rain now (grade B; small because rain mostly acts via light and colour)

Light 0.1–1.5 mm/h: +0.3 / +0.2 / +0.2 (perch / pike / zander). Moderate 1.5–4: +0.1 / +0.1 / +0.2. Heavy ≥ 4: −0.2 / −0.2 / +0.1. Thunderstorm (WMO 95+): −0.5 and a safety flag.

### 3.7 Wind (grade A for pike/wind, B for thresholds)

| 10 m wind | Points |
|---|---|
| < 4 mph and B > 0.5 (flat calm, bright) | −0.1 |
| 4–12 mph | +0.15 |
| 13–20 mph | −0.15 perch / +0.1 pike / 0 zander |
| 21–28 mph | −0.5 |
| > 28 mph | −0.8 |
| Gusts ≥ 30 mph | −0.3 extra |
| Direction | 0 |

### 3.8 Boat traffic disturbance (grade B)

Busy −0.3 / −0.2 / −0.15; moderate −0.15 / −0.1 / −0.05; light −0.05 / −0.05 / 0 (perch / pike / zander). Colour from boats is handled in the colour index, not here.

### 3.9 Pressure (grade A — null result; kept as tie-breaker)

Falling ≥ 3 hPa/24 h → +0.2. Rising ≥ 8 hPa/24 h **and** cloud < 30 % **and** 24 h temperature falling ≥ 1 °C → −0.3. Otherwise 0. Absolute level ignored.

### 3.10 Moon (grade A, small)

New or full moon ± 3 days → +0.15 (Kuparinen 2010; Vinson & Angradi 2014, 342 k muskellunge records, ~+5 %). Zander only: night with < 25 % illumination or ≥ 80 % cloud → +0.1 (Horký; UK "dark moon" anecdote). Solunar major/minor periods (Knight 1936 convention: transit/underfoot ± 60 min, rise/set ± 30 min) are **opt-in** at +0.15 / +0.05 — Quigley et al. 2023 found no relationship between any solunar service and catch rate.

### 3.11 Frost / ice

Tw < 3 °C and 24 h air minimum < −1 °C → −0.5; ice flag when Tw < 1.5 and air min < −3.

## 4. Aggregation

- `raw = Σ components`; `score = raw` up to 4.0, then `4 + (raw − 4)/3`, capped at 5, floored at 0.
- Fishable hours: sun altitude ≥ −8° for perch and pike; all hours for zander.
- Day score = mean of the best three fishable hours. Best window = highest-scoring 3 consecutive fishable hours. Rating bands: ≥ 4.2 Excellent, ≥ 3.4 Good, ≥ 2.6 Fair, ≥ 1.8 Poor, else Stay home.

Worked example (your 30 Aug day, perch, 16 °C for a week, 85 % cloud, showers, pressure falling 4 hPa/day, 8 mph): season 2.6 + light (dawn) 0.8×0.6 − 0.3·B + water +0.5 + colour ≈ 0 + rain +0.3 + wind +0.15 + pressure +0.2 ≈ 4.2 raw → day score ≈ 4.1 "Good/Excellent". Bright, calm midday in the same week scores ≈ 3.2.

## 5. Views

**Forecast** — now + 7 days ahead. **History** — the previous 14 days scored from recorded weather (Open-Meteo `past_days=14`, with EA gauge rainfall substituted where available). History exists to be checked against a catch log: the score is only worth what it predicts, and nothing here has been validated against Midlands canal catches yet.

## 6. Known limitations / calibration hooks

1. Colour index and water temperature are **proxies**; log what you observe and adjust `COLOUR_HALF_LIFE_HOURS`, `BOAT_COLOUR_INPUT`, `WATER_TAU_HOURS`.
2. Boat traffic is a calendar heuristic; a specific stretch (marina, popular hire base, remote summit pound) will differ. CRT stoppage notices would refine winter traffic but need a scheduled server-side snapshot.
3. Season curves are angler consensus scaled to leave headroom — the shape is well supported, the absolute numbers are yours to tune.
4. No catch-log feedback loop yet. The single most valuable upgrade is logging sessions (score shown vs fish caught) and re-fitting weights.

## 7. Key references

- Craig J.F. (1977) seasonal/diel activity of perch, Windermere. *J. Fish Biol.*
- Jacobsen L. et al. (2002) piscivorous perch telemetry, shallow lake. *Freshwater Biol.*
- Ljunggren L. & Sandström A. (2007) turbidity: perch vs pikeperch foraging. *J. Fish Biol.*
- Horký P. et al. (2008) pikeperch diel distribution, River Elbe. *Hydrobiologia*; Horký — moon phase and seasonality in pikeperch.
- Kuparinen A., Klefoth T., Arlinghaus R. (2010) pike catch rates vs environment; no pressure effect. *Fisheries Research*
- Escanaba Lake walleye/muskellunge angler catch 2003–2015. *PLOS ONE* (2021)
- Vinson M.R. & Angradi T.R. (2014) "Muskie Lunacy". *PLOS ONE*
- Quigley et al. (2023) solunar tables fail to predict trout fishing success. *SN Applied Sciences*
- Casselman J.M. (1978) pike activity vs temperature and light (via EA pike literature review)
- Frisk M. et al. (2012) thermal optimum of pikeperch. *Aquaculture*
- Edinger J.E. et al. (1968) response of water temperatures to meteorological conditions. *Water Resources Research*
- Pike Anglers' Club — warm-water piking guidance (≥ 18 °C).
- EA close-season byelaw background (canal exemption, 2000); CRT zander FAQs; Angling Trust zander position (2021).
