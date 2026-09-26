-- InfraPulse — Postgres schema.
--
-- NOT APPLIED. Nothing in the server opens a database connection today; the API
-- runs on src/repository/InMemoryRepository.ts. This file is the shape a
-- PostgresRepository would read and write, written now so the in-memory
-- implementation has a target to match rather than being reverse-engineered
-- into one later.
--
-- Assumes PostGIS for the road geometry. Without it, `geom` can be a JSONB
-- array of coordinates and the nearest-segment query moves into application
-- code (src/domain/geo.ts already implements exactly that).

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- Road network. Imported from OpenStreetMap by scripts/fetch-roads.ts and
-- essentially static: a re-import replaces rows, nothing mutates them per-request.
-- ---------------------------------------------------------------------------

CREATE TYPE road_class AS ENUM ('arterial', 'collector', 'local');

CREATE TABLE segments (
    id              integer PRIMARY KEY,
    osm_way_id      bigint       NOT NULL,
    name            text         NOT NULL,
    highway         text         NOT NULL,
    road_class      road_class   NOT NULL,
    length_m        numeric(7,1) NOT NULL CHECK (length_m > 0),
    -- Within 300m of a school or hospital; raises repair priority by 1.5x.
    near_sensitive  boolean      NOT NULL DEFAULT false,
    bus_route       boolean      NOT NULL DEFAULT false,
    geom            geometry(LineString, 4326) NOT NULL,
    -- Midpoint, kept denormalised because the map asks for it on every segment
    -- of every frame and ST_LineInterpolatePoint is not free at that rate.
    center          geometry(Point, 4326)      NOT NULL,
    imported_at     timestamptz  NOT NULL DEFAULT now()
);

-- The ingest path's hot query: "which segment is this impact on?"
CREATE INDEX segments_geom_idx ON segments USING gist (geom);
CREATE INDEX segments_road_class_idx ON segments (road_class);

-- ---------------------------------------------------------------------------
-- Condition history. One row per segment per day: the wear baseline.
--
-- The live score is this baseline minus what has been observed since, computed
-- on read. A nightly job folds the day's observations in (see rollUpDay in
-- src/domain/service.ts). Writing the derived score back on every ingest would
-- make each read subtract the same impacts again.
-- ---------------------------------------------------------------------------

CREATE TABLE segment_daily_scores (
    segment_id  integer     NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    day         date        NOT NULL,
    score       numeric(4,1) NOT NULL CHECK (score BETWEEN 0 AND 100),
    -- True for the seeded backfill, so a chart can label what is modelled
    -- rather than measured. Honesty about provenance is a product requirement.
    simulated   boolean     NOT NULL DEFAULT false,
    PRIMARY KEY (segment_id, day)
);

CREATE INDEX segment_daily_scores_day_idx ON segment_daily_scores (day DESC);

-- ---------------------------------------------------------------------------
-- Observations from phones.
--
-- This is the only table that grows without bound: one row per pothole hit per
-- vehicle. At city scale it wants monthly partitioning on `at` and a retention
-- policy — the raw points stop being interesting once they have been rolled up.
-- ---------------------------------------------------------------------------

CREATE TABLE bump_observations (
    id          uuid        PRIMARY KEY,
    -- Null when the impact did not fall within 40m of any known segment. Kept
    -- rather than discarded: a cluster of unmatched points usually means a real
    -- road is missing from the import.
    segment_id  integer     REFERENCES segments(id) ON DELETE SET NULL,
    at          timestamptz NOT NULL,
    position    geometry(Point, 4326) NOT NULL,
    magnitude   numeric(5,2) NOT NULL CHECK (magnitude >= 0),
    speed_ms    numeric(5,2) NOT NULL CHECK (speed_ms >= 0),
    -- An anonymous per-install identifier, never a person. There is no users
    -- table and no account: the system needs to tell two devices apart and
    -- nothing more.
    device_id   text        NOT NULL,
    trip_id     text        NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);

-- Scoring reads "bumps for this segment in the last 7 days" constantly.
CREATE INDEX bump_observations_segment_at_idx
    ON bump_observations (segment_id, at DESC);
CREATE INDEX bump_observations_at_idx ON bump_observations (at DESC);
-- Rate-limiting and abuse investigation.
CREATE INDEX bump_observations_device_idx ON bump_observations (device_id, at DESC);

-- ---------------------------------------------------------------------------
-- Citizen photo reports.
-- ---------------------------------------------------------------------------

CREATE TYPE photo_severity AS ENUM ('minor', 'moderate', 'severe');
CREATE TYPE photo_status   AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE photo_reports (
    id           text           PRIMARY KEY,
    segment_id   integer        NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    image_url    text           NOT NULL,
    label        text           NOT NULL,
    confidence   numeric(3,2)   NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    -- Normalised 0-1 box over the image.
    box_x        numeric(4,3)   NOT NULL,
    box_y        numeric(4,3)   NOT NULL,
    box_w        numeric(4,3)   NOT NULL,
    box_h        numeric(4,3)   NOT NULL,
    severity     photo_severity NOT NULL,
    -- A report is a claim until an engineer approves it; only approved reports
    -- affect a segment's score.
    status       photo_status   NOT NULL DEFAULT 'pending',
    reporter     text           NOT NULL,
    created_at   timestamptz    NOT NULL DEFAULT now(),
    reviewed_at  timestamptz,
    CHECK (status = 'pending' OR reviewed_at IS NOT NULL)
);

CREATE INDEX photo_reports_segment_idx ON photo_reports (segment_id);
CREATE INDEX photo_reports_status_idx  ON photo_reports (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Work orders.
-- ---------------------------------------------------------------------------

CREATE TYPE work_order_status AS ENUM
    ('open', 'in-progress', 'repaired', 'verified', 'reopened');

CREATE TYPE repair_type AS ENUM ('patching', 'resurfacing');

CREATE TABLE work_orders (
    id               text              PRIMARY KEY,
    segment_id       integer           NOT NULL REFERENCES segments(id) ON DELETE RESTRICT,
    status           work_order_status NOT NULL DEFAULT 'open',
    assignee         text              NOT NULL DEFAULT 'Unassigned',
    cost_inr         bigint            NOT NULL CHECK (cost_inr >= 0),
    repair_type      repair_type       NOT NULL,
    -- Impacts per day before work started and after it was verified. The pair
    -- is what proves the repair worked, so it is stored rather than recomputed
    -- against a moving window.
    bump_rate_before numeric(6,2)      NOT NULL DEFAULT 0,
    bump_rate_after  numeric(6,2),
    created_at       timestamptz       NOT NULL DEFAULT now(),
    updated_at       timestamptz       NOT NULL DEFAULT now(),
    CHECK (status <> 'verified' OR bump_rate_after IS NOT NULL)
);

-- At most one live order per segment: two crews dispatched to the same 50m of
-- road is the kind of thing that makes a works department stop trusting the
-- software. Enforced here as well as in the service, because the database is
-- the only place that can enforce it under concurrency.
CREATE UNIQUE INDEX work_orders_one_live_per_segment
    ON work_orders (segment_id)
    WHERE status <> 'verified';

CREATE INDEX work_orders_status_idx ON work_orders (status, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Audit of status changes. A work order's history is the paper trail for money
-- spent, so transitions are appended rather than overwritten.
-- ---------------------------------------------------------------------------

CREATE TABLE work_order_events (
    id            bigserial         PRIMARY KEY,
    work_order_id text              NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
    from_status   work_order_status,
    to_status     work_order_status NOT NULL,
    actor         text              NOT NULL,
    at            timestamptz       NOT NULL DEFAULT now()
);

CREATE INDEX work_order_events_order_idx ON work_order_events (work_order_id, at);

-- ---------------------------------------------------------------------------
-- Escalations: complaints drafted for the authority that owns the road.
--
-- The letter text is stored rather than regenerated on read. A complaint that
-- was sent is a record of what was actually said, and re-deriving it from
-- today's condition would quietly rewrite history — the road has changed since.
-- ---------------------------------------------------------------------------

CREATE TYPE escalation_status AS ENUM
    ('draft', 'approved', 'sent', 'dismissed');

CREATE TYPE authority_kind AS ENUM ('national', 'state', 'municipal');

CREATE TABLE escalations (
    id                 text              PRIMARY KEY,
    segment_id         integer           NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    status             escalation_status NOT NULL DEFAULT 'draft',

    -- Snapshotted, not joined: which office was written to, under the name it
    -- had at the time. Offices are reorganised and addresses change.
    authority_kind     authority_kind    NOT NULL,
    authority_name     text              NOT NULL,
    authority_email    text              NOT NULL DEFAULT '',

    subject            text              NOT NULL,
    body               text              NOT NULL,

    lat                double precision  NOT NULL,
    lon                double precision  NOT NULL,
    maps_url           text              NOT NULL,

    severity           text              NOT NULL,
    photo_report_ids   text[]            NOT NULL DEFAULT '{}',
    estimated_cost_inr bigint            NOT NULL,

    created_at         timestamptz       NOT NULL DEFAULT now(),
    approved_at        timestamptz,
    sent_at            timestamptz,
    dismissed_reason   text,

    -- Nothing is sent without a person approving it first. Enforced here as
    -- well as in the service, because this is the record anyone will audit.
    CHECK (sent_at IS NULL OR approved_at IS NOT NULL),
    CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

-- The 30-day cooldown asks "when was this segment last reported".
CREATE INDEX escalations_segment_created_idx
    ON escalations (segment_id, created_at DESC);
CREATE INDEX escalations_status_idx ON escalations (status, created_at DESC);
