import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn(
    "[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY missing — see .env.example",
  );
}

export const supabase = createClient(url ?? "", anonKey ?? "", {
  auth: { persistSession: false },
});

export type StationRow = {
  id: string;
  name: string;
  brand: string | null;
  location: string;
  street: string | null;
  postcode: string | null;
};

export type PriceChangeRow = {
  id: number;
  station_id: string;
  price_e5: number | null;
  price_e10: number | null;
  price_diesel: number | null;
  created_at: string;
};

export type PriceIncrease = {
  at: string;
  from_e5: number;
  to_e5: number;
};

export type Station = {
  id: string;
  name: string;
  brand: string | null;
  street: string | null;
  postcode: string | null;
  lng: number;
  lat: number;
  is_compliant: boolean;
  increases_count: number;
  price_e5: number | null;
  price_e10: number | null;
  price_diesel: number | null;
};

export type DailyComplianceRow = {
  station_id: string;
  increases_count: number;
  is_compliant: boolean;
  price_e5: number | null;
  price_e10: number | null;
  price_diesel: number | null;
};
