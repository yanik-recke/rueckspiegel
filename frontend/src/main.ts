import { createMap, renderStations } from "./map";
import {
  supabase,
  type DailyComplianceRow,
  type PriceChangeRow,
  type PriceIncrease,
  type Station,
  type StationRow,
} from "./supabase";
import { hideSheet, setStationIncreases, showStation } from "./sheet";
import { mountList } from "./list";
import { parsePointHex } from "./wkb";

const mapEl = document.getElementById("map");
if (!(mapEl instanceof HTMLElement)) throw new Error("#map missing");

const map = createMap(mapEl);
map.on("click", () => hideSheet());

const stationsByDate = new Map<string, Station[]>();
let allStationRows: StationRow[] | null = null;
let activeDate: string | null = null;

const list = mountList({
  map,
  getStations: () => (activeDate ? stationsByDate.get(activeDate) ?? [] : []),
  onSelect: (s) => {
    if (activeDate) void onStationClick(s, activeDate);
  },
});

map.once("load", async () => {
  const dates = await loadAvailableDates(5);
  if (dates.length === 0) {
    renderDayPills([], null);
    return;
  }
  await selectDate(dates[0], dates);
});

async function selectDate(date: string, dates: string[]) {
  activeDate = date;
  renderDayPills(dates, date);
  hideSheet();

  let stations = stationsByDate.get(date);
  if (!stations) {
    if (!allStationRows) allStationRows = await loadAllStationRows();
    const compliance = await loadComplianceForDate(date);
    stations = mergeStations(allStationRows, compliance);
    stationsByDate.set(date, stations);
  }
  renderStations(map, stations, (s) => onStationClick(s, date));
  list.refresh();
}

async function onStationClick(station: Station, date: string) {
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
  const { data, error } = await supabase
    .from("price_changes")
    .select("id, station_id, price_e5, price_e10, price_diesel, created_at")
    .eq("station_id", stationId)
    .gte("created_at", startISO)
    .lt("created_at", endISO)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    console.error("[price_changes] per-station fetch failed", error);
    return [];
  }
  const { increases } = computeCompliance((data ?? []) as PriceChangeRow[]);
  return increases;
}

// MTSK rule allows one daily increase (conventionally at noon). We use a peak-based
// count: an upward step counts as an "increase" only when it pushes E5 above the day's
// previous high. This filters out flickers where MTSK records a brief drop and re-bump
// to the same level (e.g. a station bumps to 2.149 at 12:02, drops to 1.979 at 12:07,
// returns to 2.149 at 12:09 — that's one daily step up, not two).
//
// Only price_e5 is considered (the canonical fuel for the rule). Null prices are skipped
// rather than treated as 0, which would fabricate increases out of "no information".
function computeCompliance(history: PriceChangeRow[]): {
  increases: PriceIncrease[];
  is_compliant: boolean;
} {
  const increases: PriceIncrease[] = [];
  let prev: number | null = null;
  let dayHigh: number | null = null;
  for (const row of history) {
    const curr = row.price_e5;
    if (curr == null) continue;
    if (prev != null && curr > prev && (dayHigh == null || curr > dayHigh)) {
      increases.push({
        at: row.created_at,
        from_e5: prev,
        to_e5: curr,
        violates: false,
      });
    }
    if (dayHigh == null || curr > dayHigh) dayHigh = curr;
    prev = curr;
  }

  const isCompliant = increases.length <= 1;
  if (!isCompliant) {
    for (const inc of increases) {
      if (!isNoonBerlin(inc.at)) inc.violates = true;
    }
    if (increases.every((i) => !i.violates)) {
      for (const inc of increases) inc.violates = true;
    }
  }

  return { increases, is_compliant: isCompliant };
}

const berlinHourFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

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

function isNoonBerlin(iso: string): boolean {
  const parts = berlinHourFmt.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return get("hour") === "12" && get("minute") === "00" && get("second") === "00";
}

function pillMarkup(date: string, opts: { active?: boolean } = {}): string {
  const today = berlinDateFmt.format(new Date());
  const yesterday = berlinDateFmt.format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const [, mm, dd] = date.split("-");
  const probe = new Date(`${date}T12:00:00Z`);
  let sublabel: string;
  if (date === today) sublabel = "Heute";
  else if (date === yesterday) sublabel = "Gestern";
  else sublabel = berlinWeekdayFmt.format(probe);
  return `
    <button
      class="day-pill${opts.active ? " day-pill--active" : ""}"
      data-date="${date}"
      aria-pressed="${opts.active ? "true" : "false"}"
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
  const moreButton =
    others.length > 0
      ? `<button class="day-more" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Weitere Tage">…</button>
         <div class="day-popover" role="menu" hidden>
           ${others.map((d) => `
             <button class="day-popover__item" role="menuitem" data-date="${d}">
               ${pillItemLabel(d)}
             </button>
           `).join("")}
         </div>`
      : "";

  nav.innerHTML = `
    ${pillMarkup(activeDateStr, { active: true })}
    ${moreButton}
  `;

  // Active pill: clicking does nothing (already selected) but keeps the affordance.
  // Switching happens via the popover.

  const moreBtn = nav.querySelector<HTMLButtonElement>(".day-more");
  const popover = nav.querySelector<HTMLDivElement>(".day-popover");
  if (moreBtn && popover) {
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willShow = popover.hidden;
      popover.hidden = !willShow;
      moreBtn.setAttribute("aria-expanded", willShow ? "true" : "false");
    });
    popover.querySelectorAll<HTMLButtonElement>(".day-popover__item").forEach((item) => {
      item.addEventListener("click", () => {
        const d = item.dataset.date;
        popover.hidden = true;
        moreBtn.setAttribute("aria-expanded", "false");
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
  const moreBtn = document.querySelector<HTMLButtonElement>(".day-more");
  if (!popover || popover.hidden) return;
  if (e.target instanceof Node && (popover.contains(e.target) || moreBtn?.contains(e.target))) return;
  popover.hidden = true;
  moreBtn?.setAttribute("aria-expanded", "false");
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const popover = document.querySelector<HTMLDivElement>(".day-popover");
  const moreBtn = document.querySelector<HTMLButtonElement>(".day-more");
  if (popover && !popover.hidden) {
    popover.hidden = true;
    moreBtn?.setAttribute("aria-expanded", "false");
    return;
  }
  if (list.isOpen()) list.close();
});
