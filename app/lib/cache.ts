import type { ChartTrack, ChartWeek } from "./analyticsCharts";

export interface CacheEntry {
  tracks: ChartTrack[];
  playlistTitle: string;
  week: ChartWeek | null;
  chartKind: string;
  provider: "youtube" | "spotify";
  fetchedAt: number;
}

const TTL_MS = 8 * 60 * 60 * 1000; // 8h: weekly charts move slowly

// Fresh cache (served as authoritative) + last-good cache (served stale on upstream failure).
const fresh = new Map<string, CacheEntry>();
const lastGood = new Map<string, CacheEntry>();

export function getFresh(key: string): CacheEntry | null {
  const e = fresh.get(key);
  if (!e) return null;
  if (Date.now() - e.fetchedAt > TTL_MS) return null;
  return e;
}

export function getLastGood(key: string): CacheEntry | null {
  return lastGood.get(key) ?? null;
}

export function setCached(key: string, entry: Omit<CacheEntry, "fetchedAt">): CacheEntry {
  const full = { ...entry, fetchedAt: Date.now() };
  fresh.set(key, full);
  lastGood.set(key, full);
  return full;
}
