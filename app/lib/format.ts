import type { ChartWeek } from "~/lib/analyticsCharts";

/** 6.5M / 42.1K / 908 — short enough for a dense row, never wraps. */
export function fmtViews(n: number): string {
  if (!n) return "";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${v >= 100 ? Math.round(v) : Math.round(v)}K`;
  }
  return String(n);
}

export function fmtNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function fmtDay(iso: string): string {
  return DAY.format(new Date(`${iso}T00:00:00Z`));
}

/** "Sep 18 – 24" when we have a range, "Sep 18" when we only have a point. */
export function fmtWeek(week: ChartWeek | null): string {
  if (!week?.start) return "";
  if (week.end && week.end !== week.start) {
    // Same month reads better collapsed: "Sep 18 – 24".
    const start = new Date(`${week.start}T00:00:00Z`);
    const end = new Date(`${week.end}T00:00:00Z`);
    const sameMonth = start.getUTCMonth() === end.getUTCMonth();
    if (sameMonth) {
      const d = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" });
      return `${fmtDay(week.start)} – ${d.format(end)}`;
    }
    return `${fmtDay(week.start)} – ${fmtDay(week.end)}`;
  }
  return fmtDay(week.start);
}

export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Gabon" -> "GA", falls back to the first two letters of the name. */
export function initials(iso: string): string {
  return /^[A-Z]{2}$/.test(iso) ? iso : iso.slice(0, 2).toUpperCase();
}
