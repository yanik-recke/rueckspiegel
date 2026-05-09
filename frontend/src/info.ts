import { getLang } from "./i18n";

const IMPRESSUM_URL = "/impressum.txt";
const DISCLAIMER_STORAGE_KEY = "ruckspiegel.disclaimer.v1";

let impressumLoaded = false;

export function mountInfoModal(): void {
  const modal = document.getElementById("info-modal");
  const toggle = document.getElementById("info-toggle");
  if (!modal || !toggle) throw new Error("info-modal markup missing");

  toggle.addEventListener("click", () => open());

  modal.addEventListener("click", (e) => {
    const target = e.target;
    if (target instanceof Element && target.closest("[data-info-close]")) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close();
  });

  mountDisclaimerModal();
  updateInfoModalContent();
}

function mountDisclaimerModal(): void {
  const modal = document.getElementById("disclaimer-modal");
  const accept = document.getElementById("disclaimer-accept");
  if (!modal || !accept) return;

  let accepted = false;
  try {
    accepted = localStorage.getItem(DISCLAIMER_STORAGE_KEY) === "1";
  } catch {
    // localStorage unavailable (private mode etc.) — show every time, that's fine.
  }
  if (accepted) return;

  updateInfoModalContent();
  modal.hidden = false;
  document.body.classList.add("modal-open");

  accept.addEventListener("click", () => {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    try {
      localStorage.setItem(DISCLAIMER_STORAGE_KEY, "1");
    } catch {
      // ignore
    }
  });
}

async function open(): Promise<void> {
  const modal = document.getElementById("info-modal");
  if (!modal) return;
  modal.hidden = false;
  document.body.classList.add("modal-open");
  if (!impressumLoaded) await loadImpressum();
}

function close(): void {
  const modal = document.getElementById("info-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

async function loadImpressum(): Promise<void> {
  const slot = document.getElementById("info-impressum");
  if (!slot) return;
  try {
    const res = await fetch(IMPRESSUM_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    slot.textContent = await res.text();
    impressumLoaded = true;
  } catch (err) {
    console.error("[impressum] failed to load", err);
    slot.textContent = "Impressum konnte nicht geladen werden.";
  }
}

const dataNoteBody: Record<string, string> = {
  de: `
<p>
  Diese Seite zeigt aufbereitete Preisänderungen deutscher Tankstellen.
  Die Daten werden ohne Gewähr auf Vollständigkeit oder Richtigkeit dargestellt.
  Aufgrund von Datenlücken, Meldeverzögerungen oder fehlerhaften Meldungen
  können angezeigte Preisänderungen von der tatsächlichen Preisentwicklung
  an der Zapfsäule abweichen.
</p>
<p>
  Die Anzahl der angezeigten Preiserhöhungen pro Tag ist eine rein
  deskriptive Auswertung der vorliegenden Datenpunkte. Es wird damit
  <strong>keine Aussage</strong> darüber getroffen, ob eine Tankstelle
  gegen gesetzliche oder kartellrechtliche Vorgaben verstoßen hat.
</p>`,
  en: `
<p>
  This site displays processed price changes of German fuel stations based on
  publicly available data from Tankerkönig. Data is provided
  <strong>without guarantee of completeness or accuracy</strong>.
  Due to data gaps, reporting delays, or erroneous reports, displayed price
  changes may differ from actual price developments at the pump.
</p>
<p>
  The number of price increases shown per day is a purely descriptive
  analysis of the available data points. It makes <strong>no statement</strong>
  about whether a station has violated legal or competition-law requirements.
</p>`,
};

const dataSourceBody: Record<string, string> = {
  de: `
<p>
  Die Tankstellen- und Preisdaten stammen von
  <a href="https://creativecommons.tankerkoenig.de/" target="_blank" rel="noreferrer noopener">Tankerkönig</a>
  und stehen unter der Lizenz
  <a href="https://creativecommons.org/licenses/by/4.0/deed.de" target="_blank" rel="noreferrer noopener">Creative Commons Namensnennung 4.0 International (CC BY 4.0)</a>.
</p>
<p>
  Namensnennung: „Tankstellen- und Preisdaten von
  <a href="https://creativecommons.tankerkoenig.de/" target="_blank" rel="noreferrer noopener">Tankerkönig</a>,
  lizenziert unter
  <a href="https://creativecommons.org/licenses/by/4.0/deed.de" target="_blank" rel="noreferrer noopener">CC BY 4.0</a>."
</p>
<p class="info-muted">
  Hinweis: Die Daten werden auf dieser Seite ausschließlich aufbereitet und ohne
  Anspruch auf Vollständigkeit oder Richtigkeit dargestellt. Es findet keine
  Endorsement-Beziehung zu Tankerkönig statt.
</p>
<p class="info-muted">
  Kartendaten: ©
  <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">OpenStreetMap</a>-Mitwirkende,
  Kartenstil: <a href="https://openfreemap.org/" target="_blank" rel="noreferrer noopener">OpenFreeMap</a>.
</p>`,
  en: `
<p>
  Fuel station and price data from
  <a href="https://creativecommons.tankerkoenig.de/" target="_blank" rel="noreferrer noopener">Tankerkönig</a>,
  licensed under
  <a href="https://creativecommons.org/licenses/by/4.0/deed.en" target="_blank" rel="noreferrer noopener">Creative Commons Attribution 4.0 International (CC BY 4.0)</a>.
</p>
<p>
  Attribution: "Fuel station and price data from Tankerkönig, licensed under CC BY 4.0."
</p>
<p class="info-muted">
  Note: Data on this site is displayed without any claim to completeness or accuracy.
  No endorsement relationship with Tankerkönig exists.
</p>
<p class="info-muted">
  Map data: ©
  <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">OpenStreetMap</a> contributors,
  map style: <a href="https://openfreemap.org/" target="_blank" rel="noreferrer noopener">OpenFreeMap</a>.
</p>`,
};

const disclaimerSectionBody: Record<string, string> = {
  de: `
<p>
  Rückspiegel zeigt Preisänderungen deutscher Tankstellen auf Basis öffentlich
  verfügbarer Daten von Tankerkönig.
</p>
<p>
  Die Daten werden <strong>ohne Gewähr auf Vollständigkeit oder Richtigkeit</strong>
  dargestellt. Aufgrund von Datenlücken, Meldeverzögerungen oder fehlerhaften
  Meldungen können angezeigte Preisänderungen von der tatsächlichen
  Preisentwicklung abweichen.
</p>
<p>
  Die Anzahl angezeigter Preiserhöhungen pro Tag ist eine deskriptive Auswertung
  der vorliegenden Datenpunkte. Es wird damit <strong>keine Aussage</strong>
  darüber getroffen, ob eine Tankstelle gegen gesetzliche oder kartellrechtliche
  Vorgaben verstoßen hat.
</p>`,
  en: `
<p>Rückspiegel shows price changes of German fuel stations based on publicly
available data from Tankerkönig.</p>
<p>Data is presented <strong>without guarantee of completeness or accuracy</strong>.
Due to data gaps, reporting delays, or erroneous reports, displayed price changes
may differ from actual price developments.</p>
<p>The number of price increases shown per day is a descriptive analysis of the
available data points. It makes <strong>no statement</strong> about whether a
station has violated legal or competition-law requirements.</p>`,
};

function setSectionBody(sectionEl: Element | null, html: string): void {
  if (!sectionEl) return;
  const h3 = sectionEl.querySelector("h3");
  sectionEl.innerHTML = html;
  if (h3) sectionEl.prepend(h3);
}

export function updateInfoModalContent(): void {
  const lang = getLang();

  setSectionBody(
    document.getElementById("info-section-data-note"),
    dataNoteBody[lang] ?? dataNoteBody.de,
  );
  setSectionBody(
    document.getElementById("info-section-data-source"),
    dataSourceBody[lang] ?? dataSourceBody.de,
  );

  const disclaimerSection = document
    .getElementById("disclaimer-body")
    ?.querySelector(".info-section");
  if (disclaimerSection) {
    disclaimerSection.innerHTML = disclaimerSectionBody[lang] ?? disclaimerSectionBody.de;
  }
}
