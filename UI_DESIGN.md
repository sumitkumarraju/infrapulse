# InfraPulse — Visual Design Specification

> The visual source of truth. `CLAUDE.md` says _how_ to build; this file says _what it looks like_.
> Edit this file freely — the code follows it, not the reverse.

**Design read:** a civic-infrastructure command center for municipal road engineers, plus a
companion driver PWA for citizens. Mission-control language: dark, dense, instrument-like, numbers
in monospace, colour spent almost entirely on road health. The audience is a public-works engineer
who must find the most dangerous road in ten seconds, and a driver holding a phone in sunlight.
Neither is browsing for pleasure.

**Anti-goals.** No purple-to-pink gradients. No centred hero text over a stock photo. No
rounded-everything cards floating in empty space. No decorative glass — glass appears only where a
panel genuinely floats above the map. Density is a feature.

---

## 1. Colour

### 1.1 Base (dark navy, desktop)

| Token               | Hex                      | Use                                                 |
| ------------------- | ------------------------ | --------------------------------------------------- |
| `--void`            | `#060B18`                | Page behind everything; the 3D scenes' clear colour |
| `--base`            | `#0A1022`                | App background                                      |
| `--surface-1`       | `#0F172E`                | Cards, drawer body, kanban columns                  |
| `--surface-2`       | `#16203C`                | Raised rows, hover, input fields                    |
| `--surface-3`       | `#1E2B4D`                | Active or selected row, tab underlay                |
| `--hairline`        | `rgba(255,255,255,0.08)` | 1px dividers and card borders                       |
| `--hairline-strong` | `rgba(255,255,255,0.16)` | Glass rims, focused borders                         |

### 1.2 Text

| Token      | Hex       | Contrast on `--base` | Use                                                     |
| ---------- | --------- | -------------------- | ------------------------------------------------------- |
| `--text-1` | `#E8EDF7` | 14.6:1               | Headings, values, primary labels                        |
| `--text-2` | `#97A3BD` | 7.2:1                | Secondary labels, table headers                         |
| `--text-3` | `#5F6E8C` | 3.5:1                | **Large text and non-essential only** — never body copy |

### 1.3 Accent — cyan

Cyan is the interface's own colour: selection, focus, live telemetry, the brand. It never means
"healthy" and never competes with the health ramp.

| Token             | Hex                     | Use                                                           |
| ----------------- | ----------------------- | ------------------------------------------------------------- |
| `--accent`        | `#22D3EE`               | Primary buttons, selected state, live pulse rings, focus ring |
| `--accent-bright` | `#67E8F9`               | Hover, glow cores, the landing city's road light              |
| `--accent-deep`   | `#0E7490`               | Pressed, accent-tinted fills, chart grid emphasis             |
| `--accent-wash`   | `rgba(34,211,238,0.12)` | Selected-row tint, badge background                           |

### 1.4 Road health — the only semantic ramp

These three colours mean road condition and nothing else. They are never used for buttons, links,
or generic success/error chrome — a form error is `--text-1` plus an icon and a red hairline, never
a red fill.

| Band     | Score | Token               | Hex       | Map line                     | Tower          |
| -------- | ----- | ------------------- | --------- | ---------------------------- | -------------- |
| Good     | ≥ 70  | `--health-good`     | `#6EE7B7` | 3px, 35% glow                | short, dim     |
| Watch    | 40–69 | `--health-watch`    | `#FBBF24` | 4px, 55% glow                | medium         |
| Critical | < 40  | `--health-critical` | `#F43F5E` | 5px, 80% glow + slow breathe | tall, emissive |

Continuous ramp for the map (score 0 to 100), interpolated in Oklab so the mid-tones do not go
muddy:

```
0    #B4123C   deep crimson
25   #F43F5E   critical
45   #FB923C   orange — the "about to fail" zone reads distinctly
65   #FBBF24   watch
100  #6EE7B7   good — emerald, the lightest stop
```

**The ramp must climb in lightness across its whole length**, so that no two scores render as the
same grey. This constraint is what fixes the good end at emerald `#6EE7B7` rather than a deeper
green: saturated amber is intrinsically lighter than a mid green, so a ramp ending at `#34D399`
peaks in lightness around score 80 and then falls, which made score 100 and score 55 the same grey.
There is no lime stop for the same reason. `src/lib/health.test.ts` asserts the monotonicity, so a
future edit to the ramp cannot silently break it.

The reverse ordering — brightest at the failing end, which would suit a dark map — is not available:
sRGB has no vivid red that is also light, only pastel pink.

Lightness separation across the watch/good boundary is thin by nature (0.579 against 0.587), so
colour is never the only signal. Critical segments also get a wider stroke, a taller tower and a `!`
glyph in lists; that redundancy, not hue, is what carries the ranking for a deuteranopic viewer.

### 1.5 Mobile (driver) — light theme

The driver screen is used in a windscreen mount in Punjab sunlight, so it inverts:

| Token         | Hex                                                    |
| ------------- | ------------------------------------------------------ |
| `--m-base`    | `#F6F8FC`                                              |
| `--m-surface` | `#FFFFFF`                                              |
| `--m-text-1`  | `#0A1022`                                              |
| `--m-text-2`  | `#4A5876`                                              |
| `--m-accent`  | `#0E7490` — the deep cyan, which passes 4.5:1 on white |

Health colours darken for the light background: good `#059669`, watch `#B45309`,
critical `#BE123C`.

---

## 2. Typography

- **Inter** — all UI text. Variable weight, system fallback stack.
- **JetBrains Mono** — every number a person compares or reads aloud: scores, segment IDs, costs,
  risk percentages, timestamps, sensor readings. Tabular figures always
  (`font-variant-numeric: tabular-nums`), so digits do not jitter during count-ups.

| Token            | Size / line | Weight                   | Use                                  |
| ---------------- | ----------- | ------------------------ | ------------------------------------ |
| `--text-display` | 64 / 1.0    | 600, `-0.03em`           | Landing headline only                |
| `--text-h1`      | 34 / 1.15   | 600, `-0.02em`           | Page titles                          |
| `--text-h2`      | 26 / 1.2    | 600, `-0.015em`          | Drawer segment name, section heads   |
| `--text-h3`      | 20 / 1.3    | 600                      | Card titles                          |
| `--text-body`    | 15 / 1.5    | 400                      | Prose, descriptions                  |
| `--text-sm`      | 13 / 1.45   | 450                      | Labels, table cells                  |
| `--text-xs`      | 11 / 1.35   | 550, `0.06em`, uppercase | Eyebrow labels, axis ticks, captions |
| `--metric-lg`    | 40 / 1.0    | 550 mono                 | KPI values                           |
| `--metric-md`    | 22 / 1.1    | 500 mono                 | Score in a row, cost                 |
| `--metric-sm`    | 13 / 1.2    | 500 mono                 | Segment IDs, coordinates             |

Never more than three type sizes in one panel. A `--text-xs` uppercase label with a mono value
beside it is the app's signature pairing.

---

## 3. Space, shape, elevation

A 4px base grid. Allowed steps only: `4 8 12 16 24 32 48 64 96`.

Radii: `4` chips and map tooltips, `8` buttons and inputs, `12` cards, `20` floating glass panels,
`999` pills. Nothing else.

Elevation is three levels, not a continuum:

1. **Flat** — on the page. Hairline border, no shadow.
2. **Raised** — `0 2px 8px rgba(0,0,0,.35)`. Cards over the page, dropdowns.
3. **Floating glass** — panels over the live map (Section 3.1).

### 3.1 Glass, used sparingly

Only four things are glass: the top KPI bar, the "Fix these first" queue and activity feed over the
map, the segment drawer, and the mobile bottom sheet. Everything else is opaque `--surface-1`.

```css
.glass {
  background: rgba(15, 23, 46, 0.55);
  backdrop-filter: blur(20px) saturate(150%);
  -webkit-backdrop-filter: blur(20px) saturate(150%);
  border: 1px solid var(--hairline-strong);
  border-radius: 20px;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.1),
    inset 0 -1px 0 rgba(0, 0, 0, 0.25);
}
```

Readability rules, which take priority over the effect:

- Any glass panel containing body text gets a scrim beneath its content
  (`linear-gradient(rgba(6,11,24,.35), rgba(6,11,24,.6))`).
- `@supports not (backdrop-filter: blur(1px))` falls back to solid `--surface-1` at 96% opacity.
- `prefers-reduced-transparency` renders solid with no blur. The layout must not shift.
- Glass never sits on glass.

---

## 4. The 3D map (`/command`) — the centrepiece

MapLibre GL with OpenFreeMap tiles restyled dark, centred on Chandigarh University, Gharuan
(30.768 N, 76.575 E).

**Camera.** Pitch 55°, bearing −20°, zoom 14.6 at rest. Buildings extruded from the vector tiles,
filled `#111A30`, no stroke, 55% opacity — present but recessive. Water `#0A1628`. Labels in
`--text-3`, road names in mono, shown only above zoom 15.

**Layer stack, bottom to top:**

1. **Base map** — dark tiles, dimmed buildings.
2. **Health paths** (deck.gl `PathLayer`) — every 50m segment coloured by the Section 1.4 ramp,
   width 3–5px by band, plus a second wider pass at 20% alpha for glow.
3. **Risk towers** (`ColumnLayer`) — one per watch or critical segment, 8m footprint, height
   `risk_30 × 220m`, emissive in the band colour at 65% opacity so towers behind stay legible.
   Good segments get no tower; the absence of towers is the "this district is fine" signal.
4. **Live pulse rings** (`ScatterplotLayer` with animated radius) — a ring expands 0 → 60m over
   900ms and fades, in `--accent`, each time a bump arrives. Three concurrent rings maximum;
   further events queue.
5. **Photo pins** — small rounded squares textured with the photo, hairline cyan border.
6. **Hexagon density** (`HexagonLayer`, toggleable) — replaces layers 2 and 3 when on. 120m cells,
   elevation by bump count, cyan-to-red ramp.

**Interaction.** Hovering a segment brightens it, thickens it 1px, and shows a mono tooltip:
`SEG-0214 · score 31 · risk30 78%`. Clicking flies the camera to it over 1200ms
(`easeInOutCubic`) and slides the drawer in from the right. Hovering a row in the priority queue
brightens the same segment without moving the camera.

**Lite mode.** If WebGL fails, or FPS stays below 30 for 2s: towers off, glow pass off, the map
flattens to pitch 0, and pulse rings become a single DOM dot. A `LITE MODE` chip appears in the KPI
bar, tappable, explaining why in one sentence. The demo must never show a blank canvas — the 2D map
renders first and 3D upgrades on top of it.

---

## 5. Screens

### 5.1 `/` — Landing

A full-bleed R3F night city: low-poly blocks in `#0B1226`, roads as emissive cyan ribbons, slow
light particles travelling along them, red rings breathing where potholes are, bloom at 0.6
strength. The camera drifts 6° over 20s. Headline in `--text-display`, bottom-left rather than
centred: **"Predict before it breaks."** One line of `--text-2` beneath it, and one cyan button,
**Enter Command Center**, which triggers a 1.6s camera fly-down handing off to `/command` at the
same bearing. Three mono stat chips sit along the bottom edge: segments monitored, bumps logged
today, ₹ at risk. Under reduced motion or lite mode this becomes a still render with no particles
and instant navigation.

### 5.2 `/command` — Command Center

The map fills the viewport, overlaid with:

- **KPI bar** — top, full width, glass, 72px tall. Five tiles: City Health Index (0–100 with a
  sparkline), Critical Segments, Bumps Today (live, ticking), ₹ Cost Exposure, Open Work Orders.
  Each is a `--text-xs` caption above a `--metric-lg` mono value. A `LIVE` pip pulses at the right.
- **Fix these first** — left rail, glass, 360px wide, scrollable. Ranked rows: rank in mono,
  segment name, `ScoreBadge`, a thin `RiskBar`, estimated cost. Row hover lifts the segment on the
  map.
- **Activity feed** — bottom-left, glass, 300px tall, newest at top, each entry fading in and
  sliding down. Bump entries are a single mono line; photo entries show a 32px thumbnail.
- **Alerts** — toasts top-right, with a red hairline for "Seg 214 turned red", auto-dismissing
  after 8s.

The ten-second test governs this screen: a stranger must be able to point at the most dangerous
road within ten seconds of it loading. Anything that does not serve that moves into the drawer.

### 5.3 `/command?segment=ID` — Segment drawer

Right side, 520px, glass, sliding in over 260ms. Top to bottom: segment name, road-class chip and
mono ID; a 3D road tile (R3F, 220px tall, the real geometry with pothole dents, rotating slowly,
tap to stop); a `ScoreRing` whose score counts up in mono; **why this score** — a horizontal
waterfall from 100 down through bump penalty, roughness and photo reports to the final value; a
180-day history line chart with the simulated stretch dashed and labelled "simulated" in
`--text-3`; a 90-day forecast with an uncertainty band widening to the right and a dashed critical
line at 30; three risk tiles (30/60/90 day) as mono percentages; a photo strip with AI boxes; and
the actions **Create work order**, **Add to budget plan**, **Mark inspected**.

### 5.4 `/forecast` — Time Machine

The same map without the queue. A wide timeline slider docked bottom-centre in glass runs Today to
+90 days, with a play button that advances two days per frame. Roads recolour and towers grow as
the date moves. A `follow the plan` toggle splits the readout into two mono columns — _do nothing_
against _do the plan_ — counting critical segments and ₹ exposure. Month ticks are labelled, and
the monsoon months Jul–Sep carry a faint amber band on the slider track, because that is when the
decay doubles.

### 5.5 `/budget` — Budget Planner

Left: a large budget slider (₹0 to ₹5 crore) in mono, the greedy-knapsack result list, and two
mono readouts — _segments funded_ and _% of city risk removed_. Right: the map, where funded
segments lift 40m and glow cyan while everything else dims to 25%. A small area chart plots risk
removed against spend with the current position marked. **Create N work orders** sits at the
bottom and navigates to the kanban with the new cards flashing in.

### 5.6 `/work-orders` — Kanban

Five columns: Open, In progress, Repaired, Verified, Reopened. `--surface-1` columns with hairline
borders and `--text-xs` uppercase headers beside a mono count. Cards show segment, `ScoreBadge`,
assignee initials, cost, and age in days. Dragging uses Motion `layout` with a 400/30 spring, and
the drop target gets a cyan dashed inset. Moving a card to Verified plays a 700ms celebration: the
card flips to show before and after bump rate, a green sweep crosses it, and a toast reports the
improvement. No confetti.

### 5.7 `/reports` — Photo reports

A responsive grid of 240px cards, each showing the photo with its AI bounding box drawn over it and
a mono `pothole 0.87` label. Filters run along the top as pills: severity, status, date, and a
confidence-threshold slider. Clicking opens a lightbox with the full photo, the box, metadata, and
**Approve** / **Reject**. Empty and rejected states are designed, not blank.

### 5.8 Mobile — `/app/*`

Light theme, bottom tab bar (Drive, Report, Impact), 48px minimum touch targets, primary actions
within thumb reach.

- **Drive** — a single 200px circular **Start Trip** button dead centre, with mono trip stats
  beneath.
- **Trip** — speed as a 240° arc gauge in mono; below it a live canvas seismograph of vertical
  acceleration at 60fps over a 6s window, with a red spike flash and 40ms vibration on a detected
  bump; a small 3D orientation cube following the real phone; `+1 bump` chips rising and fading.
  Stopping shows a summary: the route polyline coloured by roughness, distance, bump count, and the
  roughest 100m.
- **Report** — camera preview, capture, a cyan scanning line sweeping the image over 1.2s, a
  bounding box snapping in with a mono label and confidence, severity chips (Minor / Moderate /
  Severe), then **Submit** and a thank-you with the citizen's running count.
- **Impact** — three mono counters that count up on mount, a vertical timeline of the user's
  reports with status dots, and badge tiles where locked badges are desaturated and show their
  threshold.

---

## 6. Motion

Motion explains state change; it never decorates. All of it respects `prefers-reduced-motion`,
which collapses every duration to zero except opacity fades of 120ms or less.

| Preset           | Duration        | Easing                      | Where                                   |
| ---------------- | --------------- | --------------------------- | --------------------------------------- |
| `micro`          | 120ms           | `cubic-bezier(.4,0,.2,1)`   | Hover, focus, chip toggle               |
| `panelEnter`     | 260ms           | `cubic-bezier(.22,1,.36,1)` | Drawer, glass panels, feed rows         |
| `countUp`        | 900ms           | ease-out-expo               | KPI values, score ring, impact counters |
| `pulseRing`      | 900ms           | linear, infinite            | Live bump rings, the `LIVE` pip         |
| `pageTransition` | 320ms           | `cubic-bezier(.22,1,.36,1)` | Route changes: fade plus an 8px rise    |
| `cameraFly`      | 1200ms          | ease-in-out-cubic           | Map fly-to, landing fly-down            |
| `drag`           | spring 400 / 30 | —                           | Kanban cards                            |
| `celebrate`      | 700ms           | ease-out-back               | Verified repair                         |

Numbers count up rather than snapping. Lists stagger at 40ms per item, capped at six items — beyond
that they appear together.

---

## 7. Accessibility floor (non-negotiable)

- Body text at 4.5:1 or better; large text and UI borders at 3:1 or better. `--text-3` is banned
  from body copy.
- A visible 2px `--accent` focus ring with a 2px `--void` offset on every interactive element,
  including map overlay controls. Never `outline: none` without a replacement.
- The map has a keyboard-accessible equivalent: the priority queue is a real focusable list and
  `Enter` opens the drawer, so nothing is reachable only by clicking the canvas.
- Every icon-only button carries an `aria-label`. A polite live region announces alerts, not every
  bump.
- Touch targets at least 44px on desktop overlays and 48px on mobile.
- Charts carry a text summary for screen readers, for example "score fell from 78 to 31 over 180
  days".
