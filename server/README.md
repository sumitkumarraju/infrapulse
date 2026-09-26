# InfraPulse API

The backend the frontend was designed around: phones report impacts, the server
decides what every stretch of road is worth, and dashboards subscribe to the
result.

```bash
cd server
npm install
npm run dev          # http://localhost:8787
```

**There is no database.** The API runs on an in-memory repository seeded from
the same deterministic generator the browser mock uses, so it returns a full,
realistic city on first boot and loses everything on restart. That is the
intended state for now — see [Adding Postgres](#adding-postgres).

## What it actually does

The mock in the browser simulates road condition. This server **derives** it:

- A phone posts a trip's worth of detected impacts to `POST /api/ingest/bumps`.
- Each impact is matched to the nearest point on a road segment within 40m
  (`src/domain/geo.ts`), not to the nearest midpoint — a 50m segment's midpoint
  can be 25m from an impact that is genuinely on it.
- A segment's live score is its wear baseline minus what has been observed
  since: impacts in the last 7 days, and photo reports an engineer has
  **approved**. A citizen's report is a claim until then.
- Anything that changed is pushed to every connected dashboard over SSE, and a
  segment crossing into critical raises an alert.

Scores are derived on read and never written back. An earlier version persisted
them, so every read subtracted the same impacts again and a segment sank from 25
to 19.6 to 14.2 across three requests. `rollUpDay()` exists for the nightly job
that folds a day's observations into the baseline; nothing in a request path
calls it.

## Endpoints

| Method  | Path                            | Purpose                                                                |
| ------- | ------------------------------- | ---------------------------------------------------------------------- |
| `GET`   | `/api/health`                   | Liveness.                                                              |
| `GET`   | `/api/segments`                 | The road network. Static between imports.                              |
| `GET`   | `/api/segments/status`          | Score, band, risk, priority and cost per segment.                      |
| `GET`   | `/api/segments/projected?days=` | Every segment's score N days out (0–90).                               |
| `GET`   | `/api/segments/:id/history`     | 180 days of daily scores.                                              |
| `GET`   | `/api/segments/:id/forecast`    | 90-day forecast with an uncertainty band.                              |
| `POST`  | `/api/ingest/bumps`             | Impacts from a phone. Returns matched/unmatched and what was rescored. |
| `GET`   | `/api/reports`                  | Citizen photo reports.                                                 |
| `POST`  | `/api/reports`                  | Submit one. Created `pending`.                                         |
| `PATCH` | `/api/reports/:id`              | Approve or reject.                                                     |
| `GET`   | `/api/work-orders`              | The kanban board.                                                      |
| `POST`  | `/api/work-orders`              | Create from segment ids.                                               |
| `PATCH` | `/api/work-orders/:id`          | Move status or reassign.                                               |
| `GET`   | `/api/kpis`                     | The dashboard's top bar.                                               |
| `GET`   | `/api/live`                     | SSE stream of bumps, photos and alerts.                                |
| `POST`  | `/api/demo/reset`               | Only with `ENABLE_DEMO_ROUTES=true`.                                   |

Errors are always `{ error: { code, message } }`, and `message` is written to be
shown to a person. Validation failures add a `fields` array.

### Rules the server enforces, not the client

- **Work order transitions.** Open cannot jump to verified; the legal moves are
  in `WORK_ORDER_TRANSITIONS`. A client that tries gets a 409.
- **One live work order per segment.** Two crews sent to the same 50m of road is
  how a works department learns to distrust software.
- **Verification measures the repair**, comparing the impact rate since work
  completed against the rate before it started.
- **Only approved photo reports affect a score.**

## Configuration

| Variable             | Default                                       | Notes                                                      |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `PORT`               | `8787`                                        |                                                            |
| `CORS_ORIGINS`       | `http://localhost:5173,http://localhost:4173` | Comma-separated.                                           |
| `ENABLE_DEMO_ROUTES` | `false`                                       | Mounts `/api/demo/reset`.                                  |
| `DATABASE_URL`       | unset                                         | **Read but unused.** Reserved for the Postgres repository. |

## Pointing the frontend at it

```bash
cd server && npm run dev
# in another terminal, from the repo root
VITE_API_URL=http://localhost:8787 npm run dev
```

Without `VITE_API_URL` the app runs entirely in the browser against the mock —
no server needed. The swap is one line in `src/data/index.ts`.

## Adding Postgres

1. Apply `db/schema.sql` (it assumes PostGIS for the road geometry).
2. Write `PostgresRepository implements Repository`. The interface in
   `src/repository/Repository.ts` is the whole contract — nothing above it knows
   where rows live.
3. Change the one line in `src/index.ts` that constructs the repository.

Two things to watch when you do:

- **`getStatuses` is an N+1 waiting to happen.** In memory it reads 1,108
  histories in a loop. In SQL that must become one query with a window function,
  not 1,108 round trips.
- **`bump_observations` is the only table that grows without bound.** It wants
  monthly partitioning on `at` and a retention policy once the rollup has run.

## Testing

```bash
npm test
```

20 tests over the real app — a fresh in-memory repository per suite, exercised
through `app.request()` rather than a live socket. They cover the ingest and
scoring path, the idempotency regression above, status-transition enforcement,
validation limits, and that impacts off the mapped network are kept rather than
silently dropped.

## Not done

- **No authentication.** Every endpoint is open. Before this is exposed to
  anything, the engineer routes need a session and `/api/ingest/bumps` needs at
  least a device token and a rate limit — it is the one endpoint an untrusted
  device posts to.
- **No persistence**, so all data is lost on restart.
- **No deployment.** Nothing here has run anywhere but localhost.
- **Single process.** `EventBus` fans out in memory; a second instance would not
  see the first's ingests. That becomes Postgres `LISTEN`/`NOTIFY` or Redis.
