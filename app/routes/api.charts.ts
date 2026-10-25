import { fetchCountryCharts, type CountryCharts } from "~/lib/analyticsCharts";
import {
  clearCached,
  getFresh,
  getLastGood,
  setCached,
  type CachedCharts,
} from "~/lib/cache";
import { CHART_COUNTRIES } from "~/lib/countries";
import { NO_CHART_REASON, type ChartSource } from "~/lib/chartTypes";

/** Both tabs show the same depth. The upstream returns 100 of each; 20 is a
 *  deliberate slice, not everything that fits in a panel. */
const CHART_SIZE = 20;

/** Live: cacheable in the browser and at the CDN. The in-process cache is a
 *  second tier beneath them, so a warm request never leaves the server. */
const LIVE_CACHE = "public, max-age=300, s-maxage=300, stale-while-revalidate=86400";
/** Nothing about a country's chart coverage changes week to week. */
const NO_CHART_CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
/** Stale and failed responses must not be pinned by the browser or the CDN:
 *  the next retry has to be free to reach the upstream again. */
const NO_STORE = "no-store";

/**
 * Concurrent requests for one country share a single upstream fetch. Two tabs
 * opened in quick succession (or a prefetch that lands just before a click)
 * would otherwise both pay the keyless upstream's ~1.5s.
 */
const inflight = new Map<string, Promise<CountryCharts>>();

function fetchOnce(country: string): Promise<CountryCharts> {
  const existing = inflight.get(country);
  if (existing) return existing;
  const pending = fetchCountryCharts(country).finally(() => inflight.delete(country));
  inflight.set(country, pending);
  return pending;
}

function cacheable(charts: CountryCharts): CachedCharts {
  return setCached(charts.country, {
    week: charts.week,
    // Trim before caching rather than on the way out: 69 countries × 200 tracks
    // is a lot of strings to keep warm for a panel that can only show 40.
    songs: charts.songs.slice(0, CHART_SIZE),
    videos: charts.videos.slice(0, CHART_SIZE),
  });
}

function charted(entry: CachedCharts, source: ChartSource): Response {
  return Response.json(
    {
      charted: true,
      country: entry.country,
      week: entry.week,
      source,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      // Both kinds travel together: the browser can switch tabs without a
      // second round trip, and the CDN caches one representation instead of two
      // near-identical ones.
      songs: entry.songs,
      videos: entry.videos,
    },
    { headers: { "Cache-Control": source === "live" ? LIVE_CACHE : NO_STORE } }
  );
}

/**
 * Dev-only fault injection so the browser gate can prove the stale and
 * no-last-good paths over real HTTP. The headers are ignored in production
 * builds unless `WTS_TEST_HOOKS=1` is set on the gate's own server; there is no
 * switch a deployed client can reach.
 */
function testHooksEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.WTS_TEST_HOOKS === "1";
}

function upstreamFailureRequested(request: Request): boolean {
  return testHooksEnabled() && request.headers.get("x-wts-upstream-failure") === "1";
}

function cacheResetRequested(request: Request): boolean {
  return testHooksEnabled() && request.headers.get("x-wts-clear-cache") === "1";
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const country = (url.searchParams.get("country") ?? "").trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(country)) {
    return Response.json(
      { error: "country must be an ISO 3166-1 alpha-2 code" },
      { status: 400, headers: { "Cache-Control": NO_STORE } }
    );
  }

  // An uncharted country is a 200 with an explicit payload, not an error and
  // not a borrowed chart. It is never filled with another country's data.
  if (!(country in CHART_COUNTRIES)) {
    return Response.json(
      {
        charted: false,
        country,
        reason: NO_CHART_REASON,
      },
      { headers: { "Cache-Control": NO_CHART_CACHE } }
    );
  }

  // A retry passes `refresh=1`, which skips the fresh tier. It still falls back
  // to the last good copy if the upstream is down, marked stale.
  if (cacheResetRequested(request)) clearCached(country);
  const refresh = url.searchParams.get("refresh") === "1";
  if (!refresh) {
    const cached = getFresh(country);
    if (cached) return charted(cached, "live");
  }

  try {
    if (upstreamFailureRequested(request)) {
      throw new Error("simulated upstream failure");
    }
    return charted(cacheable(await fetchOnce(country)), "live");
  } catch (error) {
    console.error(`[charts] ${country} upstream failed:`, error);
    const lastGood = getLastGood(country);
    if (lastGood) return charted(lastGood, "stale");

    return Response.json(
      {
        error: "The official chart source is unavailable right now. Please try again.",
        country,
      },
      { status: 502, headers: { "Cache-Control": NO_STORE } }
    );
  }
}
