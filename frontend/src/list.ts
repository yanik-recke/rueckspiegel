import type { Map as MLMap } from "maplibre-gl";
import { flyToStation } from "./map";
import type { Station } from "./supabase";

const MAX_ROWS = 300;
const MOBILE_QUERY = "(max-width: 767px)";
const nameCollator = new Intl.Collator("de");

interface MountOptions {
  map: MLMap;
  getStations: () => Station[];
  onSelect: (station: Station) => void;
}

interface ListController {
  refresh: () => void;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
}

export function mountList(opts: MountOptions): ListController {
  const panel = document.getElementById("list-panel");
  const toggle = document.getElementById("list-toggle");
  const closeBtn = document.getElementById("list-close");
  const searchInput = document.getElementById("list-search") as HTMLInputElement | null;
  const onlyViolationsInput = document.getElementById("list-only-violations") as HTMLInputElement | null;
  const rowsContainer = document.getElementById("list-rows");
  const footer = document.getElementById("list-footer");

  if (
    !panel ||
    !toggle ||
    !closeBtn ||
    !searchInput ||
    !onlyViolationsInput ||
    !rowsContainer ||
    !footer
  ) {
    throw new Error("list-panel markup missing");
  }

  let query = "";
  let onlyViolations = false;
  let debounceTimer: number | null = null;
  let deferredRender: number | null = null;

  function isMobile(): boolean {
    return window.matchMedia(MOBILE_QUERY).matches;
  }

  function syncTopbarOffset() {
    const topbar = document.querySelector<HTMLElement>(".topbar");
    if (!topbar) return;
    panel!.style.setProperty("--list-top", `${topbar.offsetHeight}px`);
  }

  function open() {
    syncTopbarOffset();
    panel!.hidden = false;
    toggle!.setAttribute("aria-expanded", "true");
    rowsContainer!.innerHTML = "";
    footer!.hidden = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(render);
    });
    if (!isMobile()) queueMicrotask(() => searchInput!.focus());
  }

  function close() {
    panel!.hidden = true;
    toggle!.setAttribute("aria-expanded", "false");
  }

  function isOpen(): boolean {
    return !panel!.hidden;
  }

  function render() {
    const stations = opts.getStations();
    const q = query.trim().toLowerCase();

    let filtered = stations;
    if (onlyViolations) filtered = filtered.filter((s) => !s.is_compliant);
    if (q) {
      filtered = filtered.filter((s) => {
        const hay = `${s.name} ${s.brand ?? ""} ${s.street ?? ""} ${s.postcode ?? ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    filtered = filtered.slice().sort((a, b) => {
      if (a.is_compliant !== b.is_compliant) return a.is_compliant ? 1 : -1;
      return nameCollator.compare(a.name, b.name);
    });

    const total = filtered.length;
    const visible = filtered.slice(0, MAX_ROWS);

    if (deferredRender != null) {
      cancelAnimationFrame(deferredRender);
      deferredRender = null;
    }

    const FIRST_PAINT = 10;
    rowsContainer!.innerHTML = visible.slice(0, FIRST_PAINT).map(rowMarkup).join("");
    if (visible.length > FIRST_PAINT) {
      deferredRender = requestAnimationFrame(() => {
        deferredRender = null;
        rowsContainer!.innerHTML = visible.map(rowMarkup).join("");
      });
    }

    if (total === 0) {
      footer!.hidden = false;
      footer!.textContent = "Keine Treffer.";
    } else if (total > MAX_ROWS) {
      footer!.hidden = false;
      footer!.textContent = `${total} Treffer — Suche verfeinern (zeige ${MAX_ROWS}).`;
    } else {
      footer!.hidden = false;
      footer!.textContent = `${total} Treffer.`;
    }
  }

  rowsContainer.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>(".list-row");
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;
    const station = opts.getStations().find((s) => s.id === id);
    if (!station) return;
    flyToStation(opts.map, station);
    opts.onSelect(station);
    if (isMobile()) close();
  });

  searchInput.addEventListener("input", () => {
    if (debounceTimer != null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      query = searchInput.value;
      render();
    }, 120);
  });

  onlyViolationsInput.addEventListener("change", () => {
    onlyViolations = onlyViolationsInput.checked;
    render();
  });

  toggle.addEventListener("click", () => {
    if (isOpen()) close();
    else open();
  });

  window.addEventListener("resize", () => {
    if (isOpen()) syncTopbarOffset();
  });

  closeBtn.addEventListener("click", () => close());

  return { refresh: render, open, close, isOpen };
}

function rowMarkup(s: Station): string {
  const cls = s.is_compliant ? "list-row__dot--ok" : "list-row__dot--bad";
  const meta = [s.brand, s.street, s.postcode].filter(Boolean).map(escape).join(" · ");
  const badge = !s.is_compliant
    ? `<span class="list-row__badge">${s.increases_count}</span>`
    : "";
  return `
    <button class="list-row" role="listitem" type="button" data-id="${escape(s.id)}">
      <span class="list-row__dot ${cls}"></span>
      <span class="list-row__body">
        <span class="list-row__name">${escape(s.name)}</span>
        <span class="list-row__meta">${meta}</span>
      </span>
      ${badge}
    </button>
  `;
}

function escape(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
