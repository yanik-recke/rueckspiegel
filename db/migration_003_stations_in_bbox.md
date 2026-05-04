# Migration 003 — `stations_in_bbox` RPC

Adds a single Postgres function the frontend calls on `moveend` to fetch only stations inside the current map viewport, pre-joined with `daily_compliance` for the active date and pre-projected to numeric `lng`/`lat` (so the client no longer parses EWKB hex for the map view).

The existing GiST index `stations_location_idx` (on `stations.location`) is what makes this fast. No new indexes required.

Run in the Supabase SQL editor. Re-running is safe — `CREATE OR REPLACE` + idempotent grants.

```sql
CREATE OR REPLACE FUNCTION stations_in_bbox(
  min_lng double precision,
  min_lat double precision,
  max_lng double precision,
  max_lat double precision,
  target_date date
)
RETURNS TABLE (
  id              uuid,
  name            text,
  brand           text,
  street          text,
  postcode        varchar(5),
  lng             double precision,
  lat             double precision,
  is_compliant    boolean,
  increases_count integer,
  price_e5        integer,
  price_e10       integer,
  price_diesel    integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
-- PostGIS lives in the `extensions` schema on Supabase; include it so
-- `geometry`, `ST_X`, `ST_MakeEnvelope`, and the `&&` operator resolve.
SET search_path = public, extensions
AS $$
  SELECT
    s.id,
    s.name,
    s.brand,
    s.street,
    s.postcode,
    ST_X(s.location::geometry) AS lng,
    ST_Y(s.location::geometry) AS lat,
    COALESCE(dc.is_compliant, true)    AS is_compliant,
    COALESCE(dc.increases_count, 0)    AS increases_count,
    dc.price_e5,
    dc.price_e10,
    dc.price_diesel
  FROM public.stations s
  LEFT JOIN public.daily_compliance dc
    ON dc.station_id = s.id AND dc.date = target_date
  WHERE s.location && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)::geography;
$$;

GRANT EXECUTE ON FUNCTION stations_in_bbox(
  double precision, double precision, double precision, double precision, date
) TO anon, authenticated;
```

Smoke test:

```sql
SELECT * FROM stations_in_bbox(9.0, 48.0, 11.0, 50.0, current_date - 1) LIMIT 5;
```

Expect rows with numeric `lng`/`lat` and joined compliance fields (`is_compliant`, `increases_count`, `price_*`).
