import {
  Chart,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
} from "chart.js";
import { supabase, type ComplianceStatRow } from "./supabase";
import { t } from "./i18n";

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip
);

export interface StatsView {
  open(): void;
  close(): void;
  isOpen(): boolean;
  toggle(): void;
}

type ChartKind = "bar" | "line" | "dot";

export function mountStats(): StatsView {
  const panel = document.getElementById("stats-panel") as HTMLElement | null;
  const closeBtn = document.getElementById("stats-close") as HTMLButtonElement | null;
  const canvas = document.getElementById("stats-chart-canvas") as HTMLCanvasElement | null;
  const loadingEl = document.getElementById("stats-loading") as HTMLElement | null;
  const errorEl = document.getElementById("stats-error") as HTMLElement | null;

  if (!panel || !closeBtn || !canvas || !loadingEl || !errorEl) {
    throw new Error("stats-panel markup missing");
  }

  let chart: Chart | null = null;
  let pendingHideTimer: number | null = null;
  let currentChartType: ChartKind = "bar";
  let lastRows: ComplianceStatRow[] | null = null;

  closeBtn.addEventListener("click", () => close());

  const switcherBtns = panel.querySelectorAll<HTMLButtonElement>(".chart-type-btn");
  switcherBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.chartType as ChartKind;
      if (kind === currentChartType) return;
      currentChartType = kind;
      switcherBtns.forEach((b) =>
        b.classList.toggle("chart-type-btn--active", b === btn)
      );
      if (lastRows) {
        if (chart) {
          chart.destroy();
          chart = null;
        }
        renderChart(lastRows);
      }
    });
  });

  async function open(): Promise<void> {
    if (pendingHideTimer != null) {
      window.clearTimeout(pendingHideTimer);
      pendingHideTimer = null;
    }
    panel!.hidden = false;
    // Force reflow so the transform transition fires from the hidden state.
    void panel!.offsetWidth;
    panel!.classList.add("is-open");

    errorEl!.hidden = true;
    loadingEl!.hidden = false;

    try {
      const { data, error } = await supabase.rpc("compliance_stats_by_date", { n: 30 });
      if (error) throw error;
      const rows = (data ?? []) as ComplianceStatRow[];
      loadingEl!.hidden = true;
      lastRows = rows;
      renderChart(rows);
    } catch (err) {
      console.error("[stats] load failed", err);
      loadingEl!.hidden = true;
      errorEl!.textContent = t("statsLoadError");
      errorEl!.hidden = false;
    }
  }

  function close(): void {
    panel!.classList.remove("is-open");
    if (pendingHideTimer != null) window.clearTimeout(pendingHideTimer);
    pendingHideTimer = window.setTimeout(() => {
      panel!.hidden = true;
      pendingHideTimer = null;
    }, 250);
  }

  function isOpen(): boolean {
    return !panel!.hidden && panel!.classList.contains("is-open");
  }

  function toggle(): void {
    if (isOpen()) close();
    else void open();
  }

  function renderChart(rows: ComplianceStatRow[]): void {
    const labels = rows.map((r) => formatDate(r.stat_date));
    const values = rows.map((r) => r.non_compliant_count);

    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets[0].data = values;
      chart.data.datasets[0].label = t("statsChartTitle");
      chart.update();
      return;
    }

    // --bad token (#ef4444) — read once from the document so a future theme tweak
    // automatically propagates without touching this file.
    const badColor = getComputedStyle(document.documentElement)
      .getPropertyValue("--bad")
      .trim() || "#ef4444";

    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          // --border (#2a2f37) at 80% alpha
          grid: { color: "rgba(42,47,55,0.8)" },
          // --text-muted (#8a93a0)
          ticks: { color: "#8a93a0" },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#8a93a0", precision: 0 },
          grid: { color: "rgba(42,47,55,0.8)" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx: any) => `${ctx.parsed.y} ${t("statsTooltipLabel")}`,
          },
        },
      },
    };

    if (currentChartType === "bar") {
      chart = new Chart(canvas!, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: t("statsChartTitle"),
              data: values,
              backgroundColor: badColor,
              borderRadius: 4,
            },
          ],
        },
        options: commonOptions,
      });
    } else if (currentChartType === "line") {
      chart = new Chart(canvas!, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: t("statsChartTitle"),
              data: values,
              borderColor: badColor,
              backgroundColor: badColor + "33",
              fill: true,
              tension: 0.3,
              pointRadius: 3,
              pointHoverRadius: 5,
            },
          ],
        },
        options: commonOptions,
      });
    } else {
      chart = new Chart(canvas!, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: t("statsChartTitle"),
              data: values,
              showLine: false,
              borderColor: badColor,
              backgroundColor: badColor,
              pointRadius: 5,
              pointHoverRadius: 7,
            },
          ],
        },
        options: commonOptions,
      });
    }
  }

  return { open, close, isOpen, toggle };
}

function formatDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}.${m}.`;
}
