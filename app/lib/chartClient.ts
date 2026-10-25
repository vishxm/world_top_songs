import { createChartPrefetcher, type ChartPrefetcher } from "./chartPrefetch";
import { readCharts, writeCharts } from "./chartStore";
import type { ChartPayload } from "./chartTypes";
import { isChartCountry } from "./countries";

/**
 * The browser's chart pipeline: one request path, one cache, shared by the panel
 * and the hover prefetch.
 *
 * They have to share *both* halves. A prefetch that wrote only to the persisted
 * store would still make the panel show a skeleton for a frame, because its
 * synchronous read happens before paint; and a prefetch that owned its request
 * separately would let a click start a second one for the same country, which is
 * the latency the prefetch exists to hide. So the rules live in
 * `chartPrefetch.ts` and this file supplies the two real dependencies: browser
 * storage and `fetch`.
 */

async function readPayload(response: Response): Promise<ChartPayload> {
  const body = (await response.json().catch(() => null)) as
    | ChartPayload
    | { error?: string }
    | null;
  if (!response.ok) {
    throw new Error(
      body && "error" in body && body.error ? body.error : `HTTP ${response.status}`
    );
  }
  if (!body || !("charted" in body)) throw new Error("Malformed chart response");
  return body;
}

/**
 * Payloads this tab has fetched, insertion-ordered so the oldest can go first.
 *
 * The persisted store is not a substitute: it is capped at 24 countries and is
 * deliberately parsed on read (it can be edited by anything), and the panel's
 * first frame has to come from memory. Prefetching makes this cache more
 * important than it was — the whole point is that the click finds the payload
 * here already. The bound is generous enough for every country a session can
 * realistically hover, and stops a long sweep from pinning the whole world.
 */
const MAX_MEMORY = 64;
const memory = new Map<string, ChartPayload>();

function remember(iso: string, payload: ChartPayload): void {
  memory.delete(iso);
  memory.set(iso, payload);
  if (memory.size <= MAX_MEMORY) return;
  const oldest = memory.keys().next();
  if (!oldest.done) memory.delete(oldest.value);
}

function peek(iso: string): ChartPayload | null {
  const known = memory.get(iso);
  if (known) return known;
  // Coverage is static per build: a persisted chart is only usable while the
  // country still has one, so a coverage change cannot serve a list the picker
  // now calls uncharted.
  if (!isChartCountry(iso)) return null;
  const stored = readCharts(iso);
  if (stored) remember(iso, stored);
  return stored;
}

async function load(
  iso: string,
  signal: AbortSignal,
  refresh: boolean
): Promise<ChartPayload> {
  const params = new URLSearchParams({ country: iso });
  if (refresh) params.set("refresh", "1");
  const response = await fetch(`/api/charts?${params}`, {
    signal,
    // A retry must not be answered by the browser's HTTP cache either.
    cache: refresh ? "no-store" : "default",
  });
  const payload = await readPayload(response);
  // Uncharted answers are kept in memory too (they are static and cheap) but
  // the persisted store deliberately stores no list for them.
  remember(iso, payload);
  writeCharts(payload);
  return payload;
}

export const chartLoader: ChartPrefetcher = createChartPrefetcher({
  source: { charted: isChartCountry, peek, load },
});
