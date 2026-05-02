# Gas Station Compliance Tracker - Database Schema

This document contains the PostgreSQL schema (using PostGIS) for the gas station compliance tracker. It is designed to handle high-frequency time-series data while keeping frontend MapLibre queries instantaneous.

## 1. Prereq
```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

## 2. Static Data: `stations`
This table stores the master list of all gas stations.

```sql
CREATE TABLE stations (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT,
    -- GEOGRAPHY type is required for accurate PostGIS spatial queries
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    street TEXT,
    postcode VARCHAR(5)
);

-- Crucial: A GiST index makes querying stations by map bounding box extremely fast
CREATE INDEX stations_location_idx ON stations USING GIST (location);
```

## 3. Time-Series Ledger: `price_changes`
This is an append-only ledger for every single price change. Prices are stored as integers (e.g., 1859 for €1.859) to save space and avoid floating-point math errors.

```sql
CREATE TABLE price_changes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    station_id UUID REFERENCES stations(id) ON DELETE CASCADE,
    price_e5 INTEGER,
    price_e10 INTEGER,
    price_diesel INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Makes daily ingestion idempotent: one event per station per timestamp.
    UNIQUE (station_id, created_at)
);

-- Composite index to rapidly retrieve the most recent price for a specific station
CREATE INDEX price_changes_station_time_idx ON price_changes (station_id, created_at DESC);
```

## 4. Frontend State: `daily_compliance`
This table acts as a materialized view representing the current day's compliance state. Backend logic updates this table, and MapLibre frontend simply queries it to determine marker colors instantly.

```sql
CREATE TABLE daily_compliance (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    station_id UUID REFERENCES stations(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    increases_count INTEGER DEFAULT 0,
    last_increase_time TIME,
    -- Peak-based rule: true if increases_count <= 1.
    is_compliant BOOLEAN DEFAULT TRUE,
    -- Latest non-null fuel prices on `date` (tenths-of-cent), populated by the
    -- recompute_daily_compliance() function so the map UI doesn't need a second fetch.
    price_e5     INTEGER,
    price_e10    INTEGER,
    price_diesel INTEGER,
    -- Ensures only one summary record per station per day
    UNIQUE(station_id, date)
);

-- Speeds up queries for "today's" compliance status across the map
CREATE INDEX daily_compliance_date_idx ON daily_compliance (date);
-- Composite index used by the frontend per-day fetch.
CREATE INDEX daily_compliance_date_station_idx ON daily_compliance (date, station_id);
```
