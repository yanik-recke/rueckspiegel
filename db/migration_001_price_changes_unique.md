# Migration 001 — `price_changes` uniqueness

Adds `UNIQUE (station_id, created_at)` to `price_changes` so the daily price ingestion (`bun run load-prices`) is fully idempotent: reruns on the same day insert no duplicates because PostgREST's `onConflict` upsert collapses repeats.

The dedup `DELETE` ahead of the `ALTER` is a safety belt — on a clean DB it removes nothing. It only matters if `price_changes` somehow already contains duplicate `(station_id, created_at)` rows from before this migration.

Run the whole block in the Supabase SQL editor:

```sql
-- 1. One-time dedup (no-op on a clean DB; safety belt).
DELETE FROM price_changes a
USING price_changes b
WHERE a.id > b.id
  AND a.station_id = b.station_id
  AND a.created_at = b.created_at;

-- 2. Add the unique constraint that makes ingestion idempotent.
ALTER TABLE price_changes
  ADD CONSTRAINT price_changes_station_time_unique UNIQUE (station_id, created_at);
```
