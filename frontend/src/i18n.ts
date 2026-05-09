export type Lang = "de" | "en";

const LANG_KEY = "ruckspiegel.lang.v1";

const strings = {
  de: {
    subtitle: "Preisänderungen bei Tankstellen",
    ariaTagSelector: "Tag wählen",
    ariaListToggle: "Liste anzeigen",
    ariaInfoToggle: "Informationen",
    ariaMap: "Karte",
    ariaStationList: "Tankstellen-Liste",
    ariaClose: "Schließen",
    today: "Heute",
    yesterday: "Gestern",
    noData: "Keine Daten",
    searchPlaceholder: "Suchen (Name, Marke, Straße, PLZ)",
    onlyViolations: "Nur mit mehreren Erhöhungen",
    loadingStations: "Lade Stationen…",
    loadStationsFailed: "Konnte Stationen nicht laden.",
    noResults: "Keine Treffer.",
    loading: "lädt…",
    multipleIncreases: "Mehrere Preiserhöhungen",
    oneIncrease: "1 Preiserhöhung",
    noIncrease: "Keine Preiserhöhung",
    recordedToday: "heute erfasst",
    noIncreasesRecorded: "Keine Preiserhöhungen an diesem Tag erfasst.",
    sectionTitleIncreases: "Preiserhöhungen (E5)",
    infoModalTitle: "Informationen",
    dataNoteTitle: "Hinweis zu den Daten",
    dataSourceTitle: "Datenquelle & Lizenz",
    disclaimerModalTitle: "Hinweis zu den Daten",
    disclaimerAccept: "Verstanden",
    weekdayLocale: "de-DE",
    timeLocale: "de-DE",
  },
  en: {
    subtitle: "Fuel price changes in Germany",
    ariaTagSelector: "Select day",
    ariaListToggle: "Show list",
    ariaInfoToggle: "Information",
    ariaMap: "Map",
    ariaStationList: "Station list",
    ariaClose: "Close",
    today: "Today",
    yesterday: "Yesterday",
    noData: "No data",
    searchPlaceholder: "Search (name, brand, street, postcode)",
    onlyViolations: "Only multiple increases",
    loadingStations: "Loading stations…",
    loadStationsFailed: "Could not load stations.",
    noResults: "No results.",
    loading: "loading…",
    multipleIncreases: "Multiple price increases",
    oneIncrease: "1 price increase",
    noIncrease: "No price increase",
    recordedToday: "recorded today",
    noIncreasesRecorded: "No price increases recorded for this day.",
    sectionTitleIncreases: "Price increases (E5)",
    infoModalTitle: "Information",
    dataNoteTitle: "Data notice",
    dataSourceTitle: "Data source & license",
    disclaimerModalTitle: "Data notice",
    disclaimerAccept: "Understood",
    weekdayLocale: "en-GB",
    timeLocale: "en-GB",
  },
} as const;

type StringKey = keyof typeof strings.de;

function detectInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === "de" || stored === "en") return stored;
  } catch {
    // localStorage unavailable — fall through to browser detection
  }
  return navigator.language.startsWith("en") ? "en" : "de";
}

let currentLang: Lang = detectInitialLang();

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  currentLang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // ignore
  }
  document.documentElement.lang = lang;
}

export function t(key: StringKey): string {
  return strings[currentLang][key];
}

export function applyStaticTranslations(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n as StringKey;
    if (key in strings.de) el.textContent = t(key);
  });
  document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.dataset.i18nPlaceholder as StringKey;
    if (key in strings.de) el.placeholder = t(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((el) => {
    const key = el.dataset.i18nAriaLabel as StringKey;
    if (key in strings.de) el.setAttribute("aria-label", t(key));
  });
}

export function tTooManyResults(total: number, max: number): string {
  if (currentLang === "en") return `${total} results — refine your search (showing ${max}).`;
  return `${total} Treffer — Suche verfeinern (zeige ${max}).`;
}

export function tResultCount(total: number): string {
  if (currentLang === "en") return `${total} results.`;
  return `${total} Treffer.`;
}

export function tIncreaseCountNote(n: number): string {
  if (currentLang === "en") {
    return `${n === 1 ? "1 price increase" : `${n} price increases`} for E5 recorded on this day. Data provided without guarantee.`;
  }
  return `An diesem Tag ${n === 1 ? "wurde 1 Preiserhöhung" : `wurden ${n} Preiserhöhungen`} für E5 erfasst. Daten ohne Gewähr.`;
}
