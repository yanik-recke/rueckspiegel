# Rückspiegel — Frontend

Mobile-first MapLibre frontend for tracking gas station price compliance in Germany.

## Stack
- Vite + TypeScript
- MapLibre GL (OpenFreeMap Positron tiles, no API key)
- Supabase JS client
- Bun as package manager

## Setup
```bash
cp .env.example .env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
bun install
bun run dev
```

## Backend contract
The frontend calls a Supabase RPC `stations_with_status()` which is expected to return rows shaped like the `Station` type in `src/supabase.ts` — joining `stations`, the latest `price_changes`, and today's `daily_compliance` row, with `location` decomposed into `lng`/`lat`.

Example SQL (to add to the DB later):
```sql
create or replace function stations_with_status()
returns table (
  id uuid, name text, brand text, street text, postcode varchar(5),
  lng double precision, lat double precision,
  is_compliant boolean, increases_count integer,
  price_e5 integer, price_e10 integer, price_diesel integer
) language sql stable as $$
  select
    s.id, s.name, s.brand, s.street, s.postcode,
    st_x(s.location::geometry) as lng,
    st_y(s.location::geometry) as lat,
    dc.is_compliant, dc.increases_count,
    pc.price_e5, pc.price_e10, pc.price_diesel
  from stations s
  left join lateral (
    select * from price_changes
    where station_id = s.id
    order by created_at desc
    limit 1
  ) pc on true
  left join daily_compliance dc
    on dc.station_id = s.id and dc.date = current_date;
$$;
```

## Layout
- `src/main.ts` — entry, wires map + data + sheet
- `src/map.ts` — MapLibre setup, marker rendering
- `src/sheet.ts` — bottom sheet (mobile) / side panel (desktop)
- `src/supabase.ts` — client + `Station` type
- `src/styles.css` — dark, mobile-first styling with safe-area insets
