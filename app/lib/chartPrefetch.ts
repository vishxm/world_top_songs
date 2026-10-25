import type { ChartPayload } from "./chartTypes";

/**
 * Speculative chart loading for the country under the pointer.
 *
 * A deliberate hover is the cheapest possible signal that a click is coming, and
 * the chart request is the slowest thing in the app, so the two are worth
 * connecting: rest on a country for a moment and its chart is already on its way
 * by the time the click lands. The rules that keep that from becoming noise live
 * here rather than in the hook, because they are the part worth proving without a
 * browser — see `scripts/chart-prefetch-check.mjs`.
 *
 * The three rules:
 *
 *  - **Only a charted country is prefetched.** Countries the source publishes no
 *    chart for answer instantly from static coverage; a request would only
 *    produce a "no chart" payload nobody asked for.
 *  - **Only a *resting* pointer prefetches.** The timer restarts on every pointer
 *    move (`{ restart: true }`), so sweeping the globe — or dragging it — issues
 *    nothing. Waiting for an unchanged country instead would have prefetched
 *    Russia simply because the pointer took a while to cross it.
 *  - **Leaving cancels.** Moving to another country aborts an in-flight prefetch,
 *    because the next gesture is probably a click on the new one. Once the panel
 *    adopts a request, though, it is load-bearing: a hover that ends afterwards
 *    (the pointer moving off the canvas while a selection loads) must not kill it.
 */

export interface ChartPrefetchSource {
  /** Whether this build can answer for the country at all. Static coverage, not
   *  a network question. */
  charted(iso: string): boolean;
  /** A payload already in memory or the persisted browser store. */
  peek(iso: string): ChartPayload | null;
  /** The one layer that talks to the network. `refresh` asks the server to skip
   *  its own fresh tier; the caller handles persistence. */
  load(iso: string, signal: AbortSignal, refresh: boolean): Promise<ChartPayload>;
}

/** What the panel should wait on for a country: an answer it already has, or a
 *  request that is (or just became) in flight. */
export type ChartAnswer =
  | { cached: ChartPayload }
  | { pending: Promise<ChartPayload> };

export interface ChartPrefetcher {
  /** Synchronous cache lookup, used by the hook before it asks for anything. */
  peek(iso: string): ChartPayload | null;
  /**
   * Tell the prefetcher what the pointer is resting on. `restart` re-arms the
   * timer for the same country when the pointer moves within it; a request that
   * has already started is never restarted.
   */
  hover(iso: string | null, options?: { restart?: boolean }): void;
  /** The panel's request for a country. Joins a prefetch already in flight and
   *  takes ownership of it, so hover changes can no longer abort it. */
  load(iso: string): ChartAnswer;
  /** Retry: bypasses both the cache and any flight in progress. */
  refresh(iso: string): Promise<ChartPayload>;
}

/** How long the pointer must rest on a country before a speculative fetch.
 *  Long enough that crossing the globe issues nothing, short enough that a
 *  deliberate hover has usually finished before the click. */
export const HOVER_PREFETCH_MS = 150;

interface Flight {
  ctrl: AbortController;
  promise: Promise<ChartPayload>;
  /** A prefetch may be abandoned when the pointer leaves; an adopted request
   *  may not. */
  cancellable: boolean;
}

export interface ChartPrefetcherOptions {
  source: ChartPrefetchSource;
  delayMs?: number;
  /** Injectable so the check can advance the debounce by hand instead of
   *  sleeping through it. */
  schedule?: (run: () => void, delayMs: number) => unknown;
  clear?: (handle: unknown) => void;
}

const defaultSchedule = (run: () => void, delayMs: number) => setTimeout(run, delayMs);
const defaultClear = (handle: unknown) =>
  clearTimeout(handle as ReturnType<typeof setTimeout>);

export function createChartPrefetcher({
  source,
  delayMs = HOVER_PREFETCH_MS,
  schedule = defaultSchedule,
  clear = defaultClear,
}: ChartPrefetcherOptions): ChartPrefetcher {
  const flights = new Map<string, Flight>();
  /** What the pointer is resting on. `null` covers land with no chart, ocean and
   *  having left the canvas entirely. */
  let resting: string | null = null;
  /** Wrapped so a scheduler that returns 0 or undefined is still "armed". */
  let timer: { handle: unknown } | null = null;
  /** A callback that has already been superseded must fire nothing, even if the
   *  scheduler ran it anyway. Comparing against the current arm is the only way
   *  to know that from inside the callback. */
  let armId = 0;

  function disarm(): void {
    armId++;
    if (!timer) return;
    clear(timer.handle);
    timer = null;
  }

  /** Abandon a speculative request. Adopted requests are left alone. */
  function cancel(iso: string): void {
    const flight = flights.get(iso);
    if (!flight?.cancellable) return;
    flights.delete(iso);
    flight.ctrl.abort();
  }

  function start(iso: string, cancellable: boolean, refresh: boolean): Promise<ChartPayload> {
    const ctrl = new AbortController();
    const promise = source.load(iso, ctrl.signal, refresh).finally(() => {
      // Only the flight that is still registered may remove itself: a retry
      // deliberately runs beside the map entry rather than inside it.
      if (flights.get(iso)?.ctrl === ctrl) flights.delete(iso);
    });
    if (!refresh) flights.set(iso, { ctrl, promise, cancellable });
    return promise;
  }

  function begin(iso: string): void {
    if (!source.charted(iso) || source.peek(iso) || flights.has(iso)) return;
    // Nobody awaits a speculative request, so a rejection has to be swallowed
    // here or it surfaces as an unhandled rejection in the page.
    start(iso, true, false).catch(() => undefined);
  }

  function arm(iso: string): void {
    const id = ++armId;
    const handle = schedule(() => {
      // A cancelled wait may still have been queued; `clear` is not a promise
      // that it will not run.
      if (id !== armId) return;
      timer = null;
      // And the pointer must still be resting on this country.
      if (resting !== iso) return;
      begin(iso);
    }, delayMs);
    timer = { handle };
  }

  function hover(iso: string | null, options?: { restart?: boolean }): void {
    if (iso !== null && iso === resting) {
      // A move within the same country: restart the wait, but never touch a
      // request that is already on its way.
      if (!options?.restart || !timer) return;
      disarm();
      arm(iso);
      return;
    }

    const previous = resting;
    resting = iso;
    disarm();
    if (previous) cancel(previous);
    if (!iso || !source.charted(iso)) return;
    arm(iso);
  }

  function load(iso: string): ChartAnswer {
    // The hook peeks first, so a hit here is a race with a prefetch that landed
    // between the two calls — still an answer, never a second request.
    const cached = source.peek(iso);
    if (cached) return { cached };
    const flight = flights.get(iso);
    if (flight) {
      flight.cancellable = false;
      return { pending: flight.promise };
    }
    return { pending: start(iso, false, false) };
  }

  return {
    peek: source.peek,
    hover,
    load,
    refresh: (iso) => start(iso, false, true),
  };
}
