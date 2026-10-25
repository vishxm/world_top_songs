import type { ChartTrack, ChartWeek } from "./chartTypes";

/**
 * One upstream fetch returns both kinds for a country, so the cache is keyed by
 * country and the route serialises both lists into one response. Changing tabs
 * therefore costs neither an upstream call nor a request.
 */
export interface CachedCharts {
  country: string;
  week: ChartWeek;
  songs: ChartTrack[];
  videos: ChartTrack[];
  fetchedAt: number;
}

/** Weekly charts move slowly, and the upstream is unofficial and rate-limit
 *  friendly to nobody. Eight hours is the source's own cadence, not a guess. */
const TTL_MS = 8 * 60 * 60 * 1000;

/** Fresh: served as live while inside the TTL. */
const fresh = new Map<string, CachedCharts>();
/** Last good: served marked stale when the upstream fails, regardless of age. */
const lastGood = new Map<string, CachedCharts>();

export function getFresh(country: string): CachedCharts | null {
  const entry = fresh.get(country);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    fresh.delete(country);
    return null;
  }
  return entry;
}

export function getLastGood(country: string): CachedCharts | null {
  return lastGood.get(country) ?? null;
}

/** Test seam: lets the browser gate prove the no-last-good path deterministically
 *  without depending on which countries earlier runs happened to view. */
export function clearCached(country: string): void {
  fresh.delete(country);
  lastGood.delete(country);
}

export function setCached(
  country: string,
  charts: Pick<CachedCharts, "week" | "songs" | "videos">
): CachedCharts {
  const entry: CachedCharts = { country, ...charts, fetchedAt: Date.now() };
  fresh.set(country, entry);
  lastGood.set(country, entry);
  return entry;
}
