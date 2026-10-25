// Chart data shared by the server route, the client hook and the panel.
//
// Deliberately separate from `analyticsCharts.ts`: that module is the upstream
// fetcher and must never be reachable from the browser bundle. Only these shapes
// cross the wire.

export type ChartKind = "songs" | "videos";

/**
 * The one-sentence explanation that accompanies every no-chart answer. Shared
 * by the route and the panel so the notice a client shows before the request
 * lands is literally the same sentence the payload carries.
 */
export const NO_CHART_REASON =
  "The official chart source publishes no weekly chart for this country.";

/** Whether the payload came from the chart source in this request, or is the
 *  last good copy served because the source failed. There is no third value:
 *  the app never fabricates chart data. */
export type ChartSource = "live" | "stale";

export type Trend = "up" | "down" | "same" | "new";

export interface ChartTrack {
  rank: number;
  videoId: string;
  title: string;
  artists: string;
  weeklyViews: number;
  thumbnail: string;
  previousRank: number | null;
  weeksOnChart: number | null;
  trend: Trend;
}

export interface ChartWeek {
  id: string;
  start: string;
  end: string;
}

/**
 * One payload carries both kinds. The upstream fetch already returns them
 * together, so splitting them per request buys nothing and costs a round trip
 * (or at best a server cache hit) every time the user changes tab.
 */
export interface ChartedPayload {
  charted: true;
  country: string;
  week: ChartWeek | null;
  source: ChartSource;
  /** ISO timestamp of the upstream fetch, not of this response. */
  fetchedAt: string;
  songs: ChartTrack[];
  videos: ChartTrack[];
}

export interface UnchartedPayload {
  charted: false;
  country: string;
  reason: string;
}

export type ChartPayload = ChartedPayload | UnchartedPayload;

export function isCharted(data: ChartPayload | null): data is ChartedPayload {
  return data?.charted === true;
}
