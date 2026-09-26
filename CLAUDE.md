# InfraPulse — frontend-only build plan

> Predict which roads fail before they do. Every phone that drives a road is a
> sensor; InfraPulse turns bumps into a condition score for every 50 metres of
> the network around Chandigarh University, Gharuan.

`UI_DESIGN.md` is the visual source of truth — colours, the 3D map, every
screen, motion. This file says **how** it is built.

---

## 0. Rules for anyone (human or agent) working here

1. **Frontend only. No backend, no database, no server code.** All data comes
   from a mock data layer that behaves like the real system, including live
   events.
2. A real backend plugs in by swapping **one file**: `src/data/index.ts`, which
   exports the active `DataSource`. **No component fetches data directly** —
   everything goes through `src/data/hooks.ts`.
3. Every 3D or heavy effect needs a 2D or lite fallback. The demo must never
   freeze or show a blank screen.
4. After a change, run `npm test` and `npm run e2e`, then commit.

## 1. Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | Dev server. Syncs the MapLibre worker first. |
| `npm run build` | Typecheck and production build. |
| `npm test` | Vitest: the data model, the ramp, the knapsack. |
| `npm run e2e` | Playwright: every route at 1440×900 and 390×844. |
| `npm run fetch-roads` | Re-downloads roads from Overpass (output is committed). |
| `npm run calibrate` | Prints the health-band mix the generator produces. |
| `python scripts/make-photos.py` | Regenerates the mock road photos and their boxes. |

## 2. Stack

| Purpose | Library |
|---|---|
| App | React 19 + Vite + TypeScript, React Router |
| Styling | Tailwind CSS v4, tokens in `src/design/tokens.css` |
| Animation | `motion` (Motion for React), presets in `src/design/motion.ts` |
| 3D map | `maplibre-gl` + `react-map-gl/maplibre`, OpenFreeMap tiles (free, no key) |
| 3D data layers | deck.gl — paths, columns, scatterplot, hexagons |
| 3D scenes | `@react-three/fiber`, `@react-three/postprocessing` |
| Charts | Recharts |
| State | Zustand (demo state, persisted), TanStack Query (everything from the DataSource) |
| Geo | Turf.js (in the fetch script only) |

Two deviations from the original plan, both deliberate: React 19 rather than 18
(what `create-vite` now scaffolds, and every dependency supports it), and
**oxlint** rather than ESLint (what the template ships with).

## 3. Mock data layer

### 3.1 The swap point — `src/data/DataSource.ts`

One interface covering segments, status, history, forecast, photo reports, work
orders, KPIs, projections and the live subscription. `MockDataSource`
implements it today; a `SupabaseDataSource` would replace it in `index.ts`
without touching a screen.

### 3.2 Real roads — `public/data/segments.geojson`

`scripts/fetch-roads.ts` downloads roads from the Overpass API for a 3km box
around Chandigarh University (30.768 N, 76.575 E), cuts them into 50m pieces
with `turf.lineChunk`, and flags pieces within 300m of a school or hospital.
The output is committed, so the app never depends on Overpass being reachable —
and if it is not, the script falls back to a synthetic street grid. The current
file holds **1,108 real OSM segments**, 129 of them near a sensitive site.

### 3.3 Deterministic generation — `src/data/mock/generate.ts`

Seeded with `"infrapulse-demo"`, per segment id rather than per sequence, so the
demo is identical on every machine and does not depend on generation order.

Each segment gets 180 days of daily scores: a start in the 70s to 100s, gradual
decay scaled by road class and a skewed per-segment susceptibility, ×2.5 in the
monsoon months, pothole shocks whose frequency is also driven by that
susceptibility, occasional repairs back to ~95, and small noise. The skew is
what makes the map bimodal — most roads fine, a minority much worse — instead of
a wash of amber.

Forecasts come from the trend of the last 30 days with a band widening as
√time; `risk30/60/90` is the normal CDF of the projected score against the
critical line at 30. Priority is `risk30 × impact × urgency`, where impact
weights arterials 3, collectors 2, local 1, ×1.5 near a school or hospital and
×1.3 on a bus route. Cost is length × ₹400 for patching, × ₹2,500 for
resurfacing below score 40.

Current mix: **~16% critical, ~35% watch, ~49% good** (`npm run calibrate`).

### 3.4 Live events — `src/data/mock/live.ts`

A bump every 3–7s, weighted cubically toward the worst roads, with occasional
photo reports and rare alerts. Pauses when the tab is hidden. Real bumps
detected on a phone are relayed to any dashboard open in the same browser over
`BroadcastChannel('infrapulse')`, and arrive flagged `real`.

### 3.5 Persistence — `src/store/demoStore.ts`

Work-order moves, budget plans, report decisions and the live bump count persist
to `localStorage` through Zustand. The generated dataset itself is never stored
— it is deterministic, so persisting it would only create a way for the two to
disagree.

## 4. Routes

| Route | Screen |
|---|---|
| `/` | Landing: low-poly night city in R3F with bloom, "Predict before it breaks." |
| `/command` | 3D map, health-coloured roads, risk towers, live pulse rings, KPI bar, "Fix these first", activity feed, alerts |
| `/command?segment=ID` | Segment drawer: 3D road tile, score ring, why-this-score waterfall, 180-day history, 90-day forecast, risk tiles, actions |
| `/forecast` | Time Machine: Today → +90 days, roads recolour and towers grow, "follow the plan" comparison |
| `/budget` | Budget slider, greedy knapsack, funded segments lift and glow, risk-removed curve, bulk work orders |
| `/work-orders` | Kanban across five columns, drag or arrows, verified celebration with before/after bump rate |
| `/reports` | Photo grid with AI boxes, filters, lightbox, approve / reject |
| `/app` | Driver home — one big Start Trip button |
| `/app/trip` | Speed arc, live seismograph, orientation cube, real bump detection, trip summary |
| `/app/report` | Capture → scanning sweep → detection box → severity → submit |
| `/app/impact` | Counters, report timeline, badges |
| `/styleguide` | Token reference. Scaffolding, not a product screen. |

## 5. Known gaps

- No PWA manifest or service worker yet, so the driver screens do not install
  or work offline.
- The landing page does not fly the camera into `/command`; it navigates.
- Demo mode (`?demo=1`) with fast-forward and presenter tour is not built.
- Phone sensors are untested on real hardware — they need HTTPS, so that waits
  on a deployment.
- Photo reports are procedurally drawn SVGs, not photographs.
