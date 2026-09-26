# InfraPulse — frontend-only build plan

> Predict which roads fail before they do. Every phone that drives a road is a
> sensor; InfraPulse turns bumps into a condition score for every 50 metres of
> the network around Chandigarh University, Gharuan.

`UI_DESIGN.md` is the visual source of truth — colours, the 3D map, every
screen, motion. This file says **how** it is built.

---

## 0. Rules for anyone (human or agent) working here

1. **Two halves, one contract.** The browser app runs standalone against a mock
   by default; `server/` is a real API it can be pointed at with
   `VITE_API_URL`. There is deliberately **no database yet** — the server keeps
   everything in memory. See `server/README.md`.
2. **Types and maths live in `shared/`**, imported by both sides as
   `@shared/*`. A threshold that disagreed between client and server would show
   up as a map contradicting its own list, so neither side redefines one.
3. Swapping data sources is **one line**: `src/data/index.ts`. **No component
   fetches data directly** — everything goes through `src/data/hooks.ts`.
4. Every 3D or heavy effect needs a 2D or lite fallback. The demo must never
   freeze or show a blank screen.
5. After a change, run `npm test` and `npm run e2e` (and `npm test` inside
   `server/` if you touched it), then commit.

## 1. Running it

```bash
npm install
npm run dev          # http://localhost:5173 — mock data, no server needed
```

Against the real API:

```bash
cd server && npm install && npm run dev     # http://localhost:8787
VITE_API_URL=http://localhost:8787 npm run dev
```

| Script                          | What it does                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `npm run dev`                   | Dev server. Syncs the MapLibre worker first.                                          |
| `npm run build`                 | Typecheck and production build.                                                       |
| `npm test`                      | Vitest: the data model, the ramp, the knapsack.                                       |
| `npm run e2e`                   | Playwright: every route at 1440×900 and 390×844, plus the demo flow three times over. |
| `npm run fetch-roads`           | Re-downloads roads from Overpass (output is committed).                               |
| `npm run calibrate`             | Prints the health-band mix the generator produces.                                    |
| `python scripts/make-photos.py` | Regenerates the mock road photos and their boxes.                                     |

## 2. Stack

| Purpose        | Library                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| App            | React 19 + Vite + TypeScript, React Router                                       |
| Styling        | Tailwind CSS v4, tokens in `src/design/tokens.css`                               |
| Animation      | `motion` (Motion for React), presets in `src/design/motion.ts`                   |
| 3D map         | `maplibre-gl` + `react-map-gl/maplibre`, OpenFreeMap tiles (free, no key)        |
| 3D data layers | deck.gl — paths, columns, scatterplot, hexagons                                  |
| 3D scenes      | `@react-three/fiber`, `@react-three/postprocessing`                              |
| Charts         | Recharts                                                                         |
| State          | Zustand (demo state, persisted), TanStack Query (everything from the DataSource) |
| Geo            | Turf.js (in the fetch script only)                                               |

Two deviations from the original plan, both deliberate: React 19 rather than 18
(what `create-vite` now scaffolds, and every dependency supports it), and
**oxlint** rather than ESLint (what the template ships with).

## 3. Mock data layer

### 3.1 The swap point — `src/data/DataSource.ts`

One interface covering segments, status, history, forecast, photo reports, work
orders, KPIs, projections and the live subscription. Two implementations:
`MockDataSource` (in-browser, deterministic) and `HttpDataSource` (the API in
`server/`, using SSE for live events). `src/data/index.ts` picks one from
`VITE_API_URL`.

The important difference: the mock **simulates** condition, the server
**derives** it from reported impacts and approved photo reports. The server is
the authority when it is in play.

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

| Route                 | Screen                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/`                   | Landing: low-poly night city in R3F with bloom, "Predict before it breaks."                                               |
| `/command`            | 3D map, health-coloured roads, risk towers, live pulse rings, KPI bar, "Fix these first", activity feed, alerts           |
| `/command?segment=ID` | Segment drawer: 3D road tile, score ring, why-this-score waterfall, 180-day history, 90-day forecast, risk tiles, actions |
| `/forecast`           | Time Machine: Today → +90 days, roads recolour and towers grow, "follow the plan" comparison                              |
| `/budget`             | Budget slider, greedy knapsack, funded segments lift and glow, risk-removed curve, bulk work orders                       |
| `/work-orders`        | Kanban across five columns, drag or arrows, verified celebration with before/after bump rate                              |
| `/reports`            | Photo grid with AI boxes, filters, lightbox, approve / reject                                                             |
| `/app`                | Driver home — one big Start Trip button                                                                                   |
| `/app/trip`           | Speed arc, live seismograph, orientation cube, real bump detection, trip summary                                          |
| `/app/report`         | Capture → scanning sweep → detection box → severity → submit                                                              |
| `/app/impact`         | Counters, report timeline, badges                                                                                         |
| `/styleguide`         | Token reference. Scaffolding, not a product screen.                                                                       |

Adding `?demo=1` to any URL turns on the presenter remote (`src/demo/`): simulate
a drive, project the city 30 or 60 days forward without leaving the map, verify
a repair, run a three-stop camera tour, and reset. It starts collapsed, because
every corner of the app already holds a panel. It stays on as you navigate until
`?demo=0`.

## 4. The 3D map

`src/components/map/darkStyle.ts` declares the basemap rather than restyling a
published one: landuse and parks tinted so a campus is recognisable, water,
road casings, buildings extruded and shaded by height, and four tiers of labels
(places, then POIs — schools, hospitals, colleges — then road names).

On top, deck.gl draws what the basemap cannot: health-coloured paths with a
glow pass, risk towers whose height is `risk30`, live pulse rings, and
individual **pothole markers** from `shared/potholes.ts`. What appears depends
on altitude, because legibility does:

| Zoom   | What appears                                               |
| ------ | ---------------------------------------------------------- |
| < 15.2 | Roads, towers, pulses. The city as a whole.                |
| ≥ 15.2 | Pothole markers, sized in real metres by width             |
| ≥ 15.4 | Names and scores on the 24 highest-priority segments       |
| ≥ 17   | Risk towers dissolve — at inspection height they are walls |
| ≥ 17.2 | Depth labels on severe defects                             |

**Inspecting a defect** (from the drawer, or an alert's "Inspect") plays a
two-stage camera move: the camera lifts and turns first, then descends onto the
target. Sliding straight across at high zoom loses the viewer — the ground
rushes past with nothing to track — where pulling back keeps the surroundings
visible through the whole move. A contracting ring marks where it lands. The
map exposes `data-map-zoom` so this is testable; `e2e/demo.spec.ts` asserts it.

Defects are **derived from the condition score**, not surveyed, and the UI says
so: the drawer labels them "modelled". When the backend starts clustering real
impact positions, `potholesFor` is the single function that gets replaced.

## 4c. Escalating to the authority that owns the road

`shared/escalation.ts` turns a failing road into a complaint a works department
can act on: where it is, how bad, what evidence exists, likely cost, and a map
link. Roads route by class — NHAI for national highways, state PWD for major
roads, the municipal corporation for everything else.

**Drafting is automatic. Sending is not.** A detector cannot tell a pothole
from a speed bump, a manhole cover or a driver braking hard, and a few spurious
complaints to a works department do lasting damage: they waste an official's
time and teach them to ignore the next report, including the true ones. So a
draft is prepared automatically, an engineer reads it, and only then does it
go — from their own mail client, where the reply reaches a human.

Three rules keep the queue honest:

- **Corroboration.** Eight impacts on the same 50m within a week, or one photo
  report an engineer approved. One phone hitting something once is not evidence.
- **Cooldown.** The same road is not reported again for 30 days.
- **A cap of ten per run.** A department that receives two hundred reports in a
  morning acts on none of them.

Authority addresses are **deliberately empty** (`server/src/escalation/authorities.ts`).
Publishing a guessed address for a public office would be worse than having
none, so the server refuses to transmit until one is configured, and the app
always offers the mail-client route instead.

## 4b. Calibrating the detector against a real road

The detection algorithm lives in `shared/bumpDetector.ts` as a pure state
machine, deliberately outside React. Its thresholds are **educated guesses**
until someone drives a real road, and the only way to turn a guess into a
number is to record the raw sensor stream once and replay it through many
settings — impossible if the algorithm is welded to a component.

The workflow:

1. On the trip screen, tick **Record raw sensor trace** before starting.
2. Drive a route whose bad patches you already know. Tap **I felt that one** at
   each pothole: that is the ground truth, and without it a replay can only
   count detections, never tell whether they were the right ones.
3. Stop the trip and **Save trace to this phone**. Nothing is uploaded.
4. Replay it:

```bash
npm run replay -- path/to/trace.json --sweep
```

It reports, per setting, how many impacts were found, how many matched a
marker, how many were missed and how many were spurious — then recall and
precision. Recall matters more: a missed pothole is invisible, while a false
positive is diluted by every other driver who reported nothing at that spot.

The first number to check is `gravityAlpha`. At 60Hz the current 0.85 is about
a 2.6Hz cutoff, which is fast for a gravity estimator — the usual range is
0.2–0.5Hz (0.98–0.995 at that rate). Too fast and the "gravity" estimate starts
tracking the road and cancels the signal being measured. On synthetic traces the
sweep already prefers 0.95–0.99.

One drive is one road, one car and one mount. Do not tune to a single trace.

## 4a. The backend — `server/`

Hono on Node, no database. Phones post impacts to `/api/ingest/bumps`; the
server matches each to the nearest road segment within 40m, rescores it, and
pushes the change to dashboards over SSE. It owns the rules a client must not
be trusted with: work-order transitions, one live order per segment, and that
only an approved photo report affects a score.

`src/repository/Repository.ts` is the database seam and `db/schema.sql` is the
Postgres shape it will take — written, not applied. `server/README.md` has the
endpoint list and what is still missing (no auth, no persistence, single
process).

## 5. Known gaps

- **The PWA is built but unverified.** `vite-plugin-pwa` emits `sw.js`, a
  manifest and icons, and all three serve correctly, but Claude's built-in
  browser blocks service-worker registration in its partition — so installing
  and opening offline has not actually been seen working. Test it in a normal
  browser before claiming it.
- **Phone sensors are untested on real hardware**, so every detector threshold
  is still a guess. `DeviceMotion` and geolocation need a secure context: either
  deploy, tunnel (`npx cloudflared tunnel --url http://localhost:5173`), or use
  Chrome's USB port forwarding, which makes the phone see `localhost` and needs
  nothing public. Then record a trace and see section 4b.
- **Not deployed**, and no Lighthouse run, so the performance and PWA score
  targets are unmeasured.
- **No deployment**, and the database is optional: without `DATABASE_URL` the
  server keeps everything in memory and loses it on restart. `PostgresRepository`
  is written and `server/db/schema.sql` applies as-is to any Postgres with
  PostGIS, but **it has never been run against a real database** — `npm run
db:check` in `server/` is what proves it, and needs a connection string.
- **The engineer routes are open when running locally.** `REQUIRE_LOGIN`
  defaults off in development and on in production. Anything reachable beyond
  localhost — a tunnel, a deployment — needs it set to `true`.
- **One shared operator role.** The engineer routes now require a sign-in and
  ingest requires a device token, but everyone who signs in is the same
  operator: no per-person audit trail, and revoking access means rotating the
  secret for everyone. Needs the users table that comes with Postgres.
- **The driver's Impact screen has nothing to read against the server**, since
  the report queue became operator-only. It needs a device-scoped endpoint.
- **The wake lock is unverified on real hardware.** The trip screen requests
  `navigator.wakeLock` on start and reports honestly when it does not get it,
  but Claude's browser refuses the request outright
  (`NotAllowedError`), so the granted path has never been seen working — the
  same blind spot as the service worker. Both need a normal browser.
- The engineer console below 1024px collapses its rails behind a toggle and
  scrolls the KPI bar. It is usable, not designed for that width — the driver
  routes are the phone experience.
- **The pothole detector in the report flow is still drawn, not detected.** The
  camera is real and the photograph is real; the bounding box is placed over
  the frame with a plausible confidence. Reports need an engineer's approval
  before they move a score, which is what keeps that honest.
- **Imported regions have no condition data**, by design — they stay grey until
  vehicles drive them. Only the seeded Chandigarh region has history, and that
  history is simulated.
- The fallback sample images are procedurally drawn SVGs
  (`scripts/make-photos.py`), used only when no camera is available.
