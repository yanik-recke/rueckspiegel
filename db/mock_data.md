# Mock Data for Gas Stations

Run these SQL scripts in your Supabase SQL Editor to populate your database with mock stations and price changes for testing.

```sql
-- 1. Insert 3 Mock Stations
INSERT INTO stations (id, name, brand, location, street, postcode) VALUES
('11111111-1111-1111-1111-111111111111', 'Shell Hamburg Zentrum', 'Shell', ST_SetSRID(ST_MakePoint(9.9937, 53.5511), 4326), 'Mönckebergstraße 1', '20095'),
('22222222-2222-2222-2222-222222222222', 'Aral Berlin Mitte', 'Aral', ST_SetSRID(ST_MakePoint(13.4050, 52.5200), 4326), 'Alexanderplatz 1', '10178'),
('33333333-3333-3333-3333-333333333333', 'HEM München Altstadt', 'HEM', ST_SetSRID(ST_MakePoint(11.5820, 48.1351), 4326), 'Marienplatz 1', '80331');]

-- 2. Insert Mock Price Changes (Current date: 2026-05-01)
INSERT INTO price_changes (station_id, price_e5, price_e10, price_diesel, created_at) VALUES
-- Station 1: Compliant (One increase exactly at 12:00)
('11111111-1111-1111-1111-111111111111', 1859, 1799, 1659, '2026-05-01 08:00:00+02'),
('11111111-1111-1111-1111-111111111111', 1899, 1839, 1699, '2026-05-01 12:00:00+02'),
('11111111-1111-1111-1111-111111111111', 1879, 1819, 1679, '2026-05-01 16:00:00+02'),

-- Station 2: Violation (Increased twice: at 10:00 and 12:00)
('22222222-2222-2222-2222-222222222222', 1800, 1740, 1600, '2026-05-01 08:00:00+02'),
('22222222-2222-2222-2222-222222222222', 1850, 1790, 1650, '2026-05-01 10:00:00+02'),
('22222222-2222-2222-2222-222222222222', 1880, 1820, 1680, '2026-05-01 12:00:00+02'),

-- Station 3: Violation (Increased at 14:00, not 12:00)
('33333333-3333-3333-3333-333333333333', 1820, 1760, 1620, '2026-05-01 09:00:00+02'),
('33333333-3333-3333-3333-333333333333', 1860, 1800, 1660, '2026-05-01 14:00:00+02');
```
