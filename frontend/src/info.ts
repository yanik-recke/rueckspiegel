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
