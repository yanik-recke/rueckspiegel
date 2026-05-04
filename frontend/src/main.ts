import {
  createMap,
  getViewportBbox,
  renderStations,
  setSelectedStation,
  STATIONS_MIN_ZOOM,
  type Bbox,
} from "./map";
import {
  supabase,
  type BboxStationRow,
  type DailyComplianceRow,
  type PriceChangeRow,
  type PriceIncrease,
  type Station,
  type StationRow,
} from "./supabase";
import { hideSheet, setStationIncreases, showStation } from "./sheet";
import { mountList } from "./list";
import { mountInfoModal } from "./info";
import { parsePointHex } from "./wkb";

const mapEl = document.getElementById("map");
if (!(mapEl instanceof HTMLElement)) throw new Error("#map missing");

const map = createMap(mapEl);
map.on("click", () => {
  hideSheet();
  setSelectedStation(map, null);
});

const listToggleEl = document.getElementById("list-toggle");
function setListLoading(loading: boolean) {
  if (!listToggleEl) return;
  listToggleEl.classList.toggle("is-loading", loading);
  if (loading) listToggleEl.setAttribute("aria-busy", "true");
  else listToggleEl.removeAttribute("aria-busy");
}
setListLoading(true);

// Per-date dedup map of stations the client has currently loaded — populated
// incrementally by bbox fetches on moveend, and replaced wholesale once the
// list view has triggered a full load for the date.
const stationsByDate = new Map<string, Map<string, Station>>();
const fullyLoadedDates = new Set<string>();
const inflightFullLoad = new Map<string, Promise<void>>();
// Tiles (padded bboxes) we've already fetched per date, used to skip refetches
// when the new viewport is fully contained in something we already have.
const loadedBboxes = new Map<string, Bbox[]>();
let allStationRows: StationRow[] | null = null;
let activeDate: string | null = null;
let moveendTimer: number | null = null;

mountInfoModal();

const list = mountList({
  map,
  getStations: () =>
    activeDate ? Array.from(stationsByDate.get(activeDate)?.values() ?? []) : [],
  onSelect: (s) => {
    if (activeDate) void onStationClick(s, activeDate);
  },
  ensureLoaded: async () => {
    if (!activeDate) return;
    await ensureFullyLoaded(activeDate);
  },
});

map.once("load", async () => {
  try {
    const dates = await loadAvailableDates(5);
    if (dates.length === 0) {
      renderDayPills([], null);
      return;
    }
    await selectDate(dates[0], dates);
  } finally {
    setListLoading(false);
  }
});

map.on("moveend", () => {
  if (moveendTimer != null) window.clearTimeout(moveendTimer);
  moveendTimer = window.setTimeout(handleViewportChange, 200);
});

async function handleViewportChange() {
  if (!activeDate) return;
  if (map.getZoom() < STATIONS_MIN_ZOOM) return;
  if (fullyLoadedDates.has(activeDate)) return;
  const bbox = padBbox(getViewportBbox(map), 0.1);
  if (bboxAlreadyCovered(activeDate, bbox)) return;
  await loadBboxIntoCache(activeDate, bbox);
  if (activeDate) renderStations(map, currentStations(activeDate), (s) => onStationClick(s, activeDate!));
}

async function selectDate(date: string, dates: string[]) {
  activeDate = date;
  renderDayPills(dates, date);
  hideSheet();
  setSelectedStation(map, null);

  // Render whatever we have cached for this date right away (may be empty —
  // that's fine, it bootstraps the GeoJSON source + layers so moveend handlers
  // and selection halos can attach immediately).
  renderStations(map, currentStations(date), (s) => onStationClick(s, date));
  list.refresh();

  if (fullyLoadedDates.has(date)) return;
  // Trigger a viewport-scoped fetch only if dots would actually be visible.
  if (map.getZoom() >= STATIONS_MIN_ZOOM) {
    const bbox = padBbox(getViewportBbox(map), 0.1);
    if (!bboxAlreadyCovered(date, bbox)) {
      await loadBboxIntoCache(date, bbox);
      if (activeDate === date) {
        renderStations(map, currentStations(date), (s) => onStationClick(s, date));
        list.refresh();
      }
    }
  }
}

function currentStations(date: string): Station[] {
  return Array.from(stationsByDate.get(date)?.values() ?? []);
}

async function loadBboxIntoCache(date: string, bbox: Bbox): Promise<void> {
  const rows = await loadStationsInBbox(date, bbox);
  const target = stationsByDate.get(date) ?? new Map<string, Station>();
  for (const r of rows) {
    target.set(r.id, {
      id: r.id,
      name: r.name,
      brand: r.brand,
      street: r.street,
      postcode: r.postcode,
      lng: r.lng,
      lat: r.lat,
      is_compliant: r.is_compliant,
      increases_count: r.increases_count,
      price_e5: r.price_e5,
      price_e10: r.price_e10,
      price_diesel: r.price_diesel,
    });
  }
  stationsByDate.set(date, target);
  const tiles = loadedBboxes.get(date) ?? [];
  tiles.push(bbox);
  loadedBboxes.set(date, tiles);
}

async function loadStationsInBbox(date: string, bbox: Bbox): Promise<BboxStationRow[]> {
  const { data, error } = await supabase.rpc("stations_in_bbox", {
    min_lng: bbox.minLng,
    min_lat: bbox.minLat,
    max_lng: bbox.maxLng,
    max_lat: bbox.maxLat,
    target_date: date,
  });
  if (error) {
    console.error("[stations_in_bbox] failed", error);
    return [];
  }
  return (data ?? []) as BboxStationRow[];
}

function ensureFullyLoaded(date: string): Promise<void> {
  if (fullyLoadedDates.has(date)) return Promise.resolve();
  const existing = inflightFullLoad.get(date);
  if (existing) return existing;
  const p = loadAllForDate(date).finally(() => inflightFullLoad.delete(date));
  inflightFullLoad.set(date, p);
  return p;
}

async function loadAllForDate(date: string): Promise<void> {
  if (!allStationRows) allStationRows = await loadAllStationRows();
  const compliance = await loadComplianceForDate(date);
  const merged = mergeStations(allStationRows, compliance);
  const target = stationsByDate.get(date) ?? new Map<string, Station>();
  for (const s of merged) target.set(s.id, s);
  stationsByDate.set(date, target);
  fullyLoadedDates.add(date);
  if (activeDate === date) {
    renderStations(map, currentStations(date), (s) => onStationClick(s, date));
  }
}

function padBbox(b: Bbox, ratio: number): Bbox {
  const dLng = (b.maxLng - b.minLng) * ratio;
  const dLat = (b.maxLat - b.minLat) * ratio;
  return {
    minLng: b.minLng - dLng,
    minLat: b.minLat - dLat,
    maxLng: b.maxLng + dLng,
    maxLat: b.maxLat + dLat,
  };
}

function bboxAlreadyCovered(date: string, b: Bbox): boolean {
  const tiles = loadedBboxes.get(date);
  if (!tiles) return false;
  return tiles.some(
    (t) =>
      t.minLng <= b.minLng &&
      t.minLat <= b.minLat &&
      t.maxLng >= b.maxLng &&
      t.maxLat >= b.maxLat,
  );
}

async function onStationClick(station: Station, date: string) {
  setSelectedStation(map, station);
  showStation(station, { increasesPending: true });
  const increases = await fetchStationIncreases(station.id, date);
  setStationIncreases(station.id, increases, station.is_compliant);
}

async function loadAvailableDates(n: number): Promise<string[]> {
  const { data, error } = await supabase.rpc("available_dates", { n });
  if (error) {
    console.error("[available_dates] failed", error);
    return [];
  }
  // RPC returns either ["2026-05-01", …] or [{ available_dates: "2026-05-01" }, …]
  // depending on PostgREST settings; handle both.
  return (data ?? []).map((row: unknown) =>
    typeof row === "string" ? row : (row as { available_dates: string }).available_dates,
  );
}

async function loadComplianceForDate(date: string): Promise<DailyComplianceRow[]> {
  const PAGE = 1000;
  const out: DailyComplianceRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("daily_compliance")
      .select("station_id, increases_count, is_compliant, price_e5, price_e10, price_diesel")
      .eq("date", date)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[daily_compliance] failed to load", error);
      break;
    }
    const rows = (data ?? []) as DailyComplianceRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// PostgREST caps a single response at 1000 rows — paginate until exhausted.
async function loadAllStationRows(): Promise<StationRow[]> {
  const PAGE = 1000;
  const out: StationRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("stations")
      .select("id, name, brand, location, street, postcode")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[stations] failed to load", error);
      break;
    }
    const rows = (data ?? []) as StationRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function mergeStations(
  stationRows: StationRow[],
  compliance: DailyComplianceRow[],
): Station[] {
  const byId = new Map(compliance.map((c) => [c.station_id, c]));
  return stationRows.flatMap((s) => {
    const coords = parsePointHex(s.location);
    if (!coords) return [];
    const c = byId.get(s.id);
    return [
      {
        id: s.id,
        name: s.name,
        brand: s.brand,
        street: s.street,
        postcode: s.postcode,
        lng: coords[0],
        lat: coords[1],
        is_compliant: c?.is_compliant ?? true,
        increases_count: c?.increases_count ?? 0,
        price_e5: c?.price_e5 ?? null,
        price_e10: c?.price_e10 ?? null,
        price_diesel: c?.price_diesel ?? null,
      },
    ];
  });
}

async function fetchStationIncreases(
  stationId: string,
  date: string,
): Promise<PriceIncrease[]> {
  const { startISO, endISO } = berlinDayBoundsForDate(date);
  const prevDate = previousDate(date);
  const [history, seed] = await Promise.all([
    supabase
      .from("price_changes")
      .select("id, station_id, price_e5, price_e10, price_diesel, created_at")
      .eq("station_id", stationId)
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    supabase
      .from("daily_compliance")
      .select("price_e5")
      .eq("station_id", stationId)
      .eq("date", prevDate)
      .maybeSingle(),
  ]);
  if (history.error) {
    console.error("[price_changes] per-station fetch failed", history.error);
    return [];
  }
  // Prior-day seed is best-effort — if it fails or is missing we fall back to
  // first-row-as-baseline, matching the pre-seed behavior.
  const seedE5 = seed.error ? null : seed.data?.price_e5 ?? null;
  const { increases } = computeCompliance(
    (history.data ?? []) as PriceChangeRow[],
    seedE5,
  );
  return increases;
}

function previousDate(date: string): string {
  const [yy, mm, dd] = date.split("-").map(Number);
  const prev = new Date(Date.UTC(yy, mm - 1, dd - 1));
  return prev.toISOString().slice(0, 10);
}

// MTSK rule allows one daily increase (conventionally at noon). We use a peak-based
// count: an upward step counts as an "increase" only when it pushes E5 above the day's
// previous high. This filters out flickers where MTSK records a brief drop and re-bump
// to the same level (e.g. a station bumps to 2.149 at 12:02, drops to 1.979 at 12:07,
// returns to 2.149 at 12:09 — that's one daily step up, not two).
//
// `seedE5` is the prior day's closing E5 price (from `daily_compliance.price_e5`).
// The tankerkoenig CSV only contains change events, so a station with a quiet morning
// has its noon raise as the first row of the day — without the seed, that raise would
// be silently treated as the baseline. Mirror of the SQL `recompute_daily_compliance`.
//
// Only price_e5 is considered (the canonical fuel for the rule). Null prices are skipped
// rather than treated as 0, which would fabricate increases out of "no information".
function computeCompliance(
  history: PriceChangeRow[],
  seedE5: number | null = null,
): {
  increases: PriceIncrease[];
  is_compliant: boolean;
} {
  const increases: PriceIncrease[] = [];
  let prev: number | null = seedE5;
  let dayHigh: number | null = seedE5;
  for (const row of history) {
    const curr = row.price_e5;
    if (curr == null) continue;
    if (prev != null && curr > prev && (dayHigh == null || curr > dayHigh)) {
      increases.push({
        at: row.created_at,
        from_e5: prev,
        to_e5: curr,
      });
    }
    if (dayHigh == null || curr > dayHigh) dayHigh = curr;
    prev = curr;
  }

  return { increases, is_compliant: increases.length <= 1 };
}

const berlinDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const berlinOffsetFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  timeZoneName: "longOffset",
});

const berlinWeekdayFmt = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  weekday: "short",
});

function berlinOffsetAt(d: Date): string {
  const part = berlinOffsetFmt.formatToParts(d).find((p) => p.type === "timeZoneName")?.value;
  return part ? part.replace("GMT", "") || "+01:00" : "+01:00";
}

function berlinDayBoundsForDate(date: string): { startISO: string; endISO: string } {
  // Probe at noon-of-that-date UTC to get the correct Berlin offset for the day,
  // sidestepping the DST transition edge.
  const probe = new Date(`${date}T12:00:00Z`);
  const offset = berlinOffsetAt(probe);
  const [yy, mm, dd] = date.split("-").map(Number);
  const nextUTC = new Date(Date.UTC(yy, mm - 1, dd + 1));
  const nextDate = nextUTC.toISOString().slice(0, 10);
  return {
    startISO: `${date}T00:00:00${offset}`,
    endISO: `${nextDate}T00:00:00${offset}`,
  };
}

function pillMarkup(
  date: string,
  opts: { active?: boolean; hasMenu?: boolean } = {},
): string {
  const today = berlinDateFmt.format(new Date());
  const yesterday = berlinDateFmt.format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const [, mm, dd] = date.split("-");
  const probe = new Date(`${date}T12:00:00Z`);
  let sublabel: string;
  if (date === today) sublabel = "Heute";
  else if (date === yesterday) sublabel = "Gestern";
  else sublabel = berlinWeekdayFmt.format(probe);
  const menuAttrs = opts.hasMenu
    ? `aria-haspopup="true" aria-expanded="false"`
    : "";
  return `
    <button
      class="day-pill${opts.active ? " day-pill--active" : ""}"
      data-date="${date}"
      aria-pressed="${opts.active ? "true" : "false"}"
      ${menuAttrs}
    >
      <span class="day-pill__date">${dd}.${mm}.</span>
      <span class="day-pill__sub">${sublabel}</span>
    </button>
  `;
}

function renderDayPills(dates: string[], active: string | null) {
  const nav = document.getElementById("day-selector");
  if (!nav) return;
  if (dates.length === 0) {
    nav.innerHTML = `<span class="day-empty">Keine Daten</span>`;
    return;
  }
  const activeDateStr = active ?? dates[0];
  const others = dates.filter((d) => d !== activeDateStr);
  const popoverMarkup =
    others.length > 0
      ? `<div class="day-popover" role="menu" hidden>
           ${others.map((d) => `
             <button class="day-popover__item" role="menuitem" data-date="${d}">
               ${pillItemLabel(d)}
             </button>
           `).join("")}
         </div>`
      : "";

  nav.innerHTML = `
    ${pillMarkup(activeDateStr, { active: true, hasMenu: others.length > 0 })}
    ${popoverMarkup}
  `;

  const triggerBtn = nav.querySelector<HTMLButtonElement>(".day-pill");
  const popover = nav.querySelector<HTMLDivElement>(".day-popover");
  if (triggerBtn && popover) {
    triggerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willShow = popover.hidden;
      popover.hidden = !willShow;
      triggerBtn.setAttribute("aria-expanded", willShow ? "true" : "false");
    });
    popover.querySelectorAll<HTMLButtonElement>(".day-popover__item").forEach((item) => {
      item.addEventListener("click", () => {
        const d = item.dataset.date;
        popover.hidden = true;
        triggerBtn.setAttribute("aria-expanded", "false");
        if (!d || d === activeDate) return;
        void selectDate(d, dates);
      });
    });
  }
}

function pillItemLabel(date: string): string {
  const today = berlinDateFmt.format(new Date());
  const yesterday = berlinDateFmt.format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const [, mm, dd] = date.split("-");
  const probe = new Date(`${date}T12:00:00Z`);
  let sublabel: string;
  if (date === today) sublabel = "Heute";
  else if (date === yesterday) sublabel = "Gestern";
  else sublabel = berlinWeekdayFmt.format(probe);
  return `<span class="day-popover__date">${dd}.${mm}.</span><span class="day-popover__sub">${sublabel}</span>`;
}

// Close popover on outside click / Escape.
document.addEventListener("click", (e) => {
  const popover = document.querySelector<HTMLDivElement>(".day-popover");
  const triggerBtn = document.querySelector<HTMLButtonElement>("#day-selector .day-pill");
  if (!popover || popover.hidden) return;
  if (e.target instanceof Node && (popover.contains(e.target) || triggerBtn?.contains(e.target))) return;
  popover.hidden = true;
  triggerBtn?.setAttribute("aria-expanded", "false");
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const popover = document.querySelector<HTMLDivElement>(".day-popover");
  const triggerBtn = document.querySelector<HTMLButtonElement>("#day-selector .day-pill");
  if (popover && !popover.hidden) {
    popover.hidden = true;
    triggerBtn?.setAttribute("aria-expanded", "false");
    return;
  }
  if (list.isOpen()) list.close();
});
