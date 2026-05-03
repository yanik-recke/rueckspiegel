import type { PriceIncrease, Station } from "./supabase";

let currentStationId: string | null = null;

export function showStation(station: Station, opts: { increasesPending?: boolean } = {}) {
  const sheet = document.getElementById("sheet");
  const content = sheet?.querySelector(".sheet-content");
  if (!sheet || !content) return;

  currentStationId = station.id;

  const increasesBlock = opts.increasesPending
    ? `<div id="sheet-increases" class="sheet-increases sheet-increases--loading">lädt…</div>`
    : `<div id="sheet-increases" class="sheet-increases">${renderIncreases([], station.is_compliant)}</div>`;

  const statusLabel =
    station.increases_count >= 2
      ? "Mehrere Preiserhöhungen"
      : station.increases_count === 1
        ? "1 Preiserhöhung"
        : "Keine Preiserhöhung";
  content.innerHTML = `
    <div class="status status-${station.is_compliant ? "ok" : "bad"}">
      <span class="dot"></span>
      <span class="status-label">${statusLabel}</span>
      <span class="status-meta">heute erfasst</span>
    </div>
    <h2>${escape(station.name)}</h2>
    <div class="meta">${[station.brand, station.street, station.postcode]
      .filter(Boolean)
      .map(escape)
      .join(" · ")}</div>
    <div class="prices">
      ${priceCard("E5", station.price_e5)}
      ${priceCard("E10", station.price_e10)}
      ${priceCard("Diesel", station.price_diesel)}
    </div>
    ${increasesBlock}
  `;
  sheet.hidden = false;
}

export function setStationIncreases(
  stationId: string,
  increases: PriceIncrease[],
  compliant: boolean,
) {
  if (currentStationId !== stationId) return;
  const slot = document.getElementById("sheet-increases");
  if (!slot) return;
  slot.classList.remove("sheet-increases--loading");
  slot.innerHTML = renderIncreases(increases, compliant);
}

export function hideSheet() {
  const sheet = document.getElementById("sheet");
  if (sheet) sheet.hidden = true;
  currentStationId = null;
}

function renderIncreases(increases: PriceIncrease[], _compliant: boolean): string {
  if (increases.length === 0) {
    return `<div class="rule-note">Keine Preiserhöhungen an diesem Tag erfasst.</div>`;
  }
  const rows = increases
    .map((inc) => {
      const delta = ((inc.to_e5 - inc.from_e5) / 1000).toFixed(3);
      return `
        <li>
          <span class="time">${formatTime(inc.at)}</span>
          <span class="delta">€${(inc.from_e5 / 1000).toFixed(3)} → €${(
            inc.to_e5 / 1000
          ).toFixed(3)} <em>(+€${delta})</em></span>
        </li>`;
    })
    .join("");
  const count = increases.length;
  return `
    <h3 class="section-title">Preiserhöhungen (E5)</h3>
    <ul class="increases">${rows}</ul>
    <div class="rule-note">
      An diesem Tag ${count === 1 ? "wurde 1 Preiserhöhung" : `wurden ${count} Preiserhöhungen`} für E5 erfasst.
      Daten ohne Gewähr.
    </div>
  `;
}

function priceCard(label: string, priceE5: number | null) {
  const value = priceE5 == null ? "—" : `€${(priceE5 / 1000).toFixed(3)}`;
  return `
    <div class="price">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>
  `;
}

const berlinTimeFmt = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(iso: string): string {
  return berlinTimeFmt.format(new Date(iso));
}

function escape(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
