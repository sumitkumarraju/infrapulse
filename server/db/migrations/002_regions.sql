-- Regions: the system stops being about one campus.
--
-- Roads were imported once from a committed file covering a 3km box around
-- Chandigarh University. A region is that same idea made repeatable: any
-- bounding box, imported on demand, with its segments hanging off it.

CREATE TABLE regions (
    id          serial       PRIMARY KEY,
    name        text         NOT NULL,
    south       double precision NOT NULL,
    west        double precision NOT NULL,
    north       double precision NOT NULL,
    east        double precision NOT NULL,
    created_at  timestamptz  NOT NULL DEFAULT now(),
    CHECK (north > south AND east > west)
);

-- Re-importing the same place should update it, not accumulate duplicates.
CREATE UNIQUE INDEX regions_box_idx ON regions (south, west, north, east);

ALTER TABLE segments ADD COLUMN region_id integer REFERENCES regions(id) ON DELETE CASCADE;

-- Everything already imported belongs to the region it was imported for.
INSERT INTO regions (name, south, west, north, east)
VALUES ('Chandigarh University, Gharuan', 30.7545, 76.5593, 30.7815, 76.5907)
ON CONFLICT DO NOTHING;

UPDATE segments
SET region_id = (SELECT id FROM regions ORDER BY id LIMIT 1)
WHERE region_id IS NULL;

ALTER TABLE segments ALTER COLUMN region_id SET NOT NULL;
CREATE INDEX segments_region_idx ON segments (region_id);

-- Segment ids came from a file and were assigned by hand. Imports need the
-- database to allocate them, or two regions collide on the first insert.
CREATE SEQUENCE IF NOT EXISTS segments_id_seq OWNED BY segments.id;
SELECT setval('segments_id_seq', COALESCE((SELECT max(id) FROM segments), 0) + 1, false);
ALTER TABLE segments ALTER COLUMN id SET DEFAULT nextval('segments_id_seq');

-- osm_way_id was NOT NULL with no default and imports do not always have one.
ALTER TABLE segments ALTER COLUMN osm_way_id DROP NOT NULL;
