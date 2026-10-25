import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { chartLoader } from "~/lib/chartClient";
import type { ChartPayload } from "~/lib/chartTypes";

interface State {
  /** The country this state answers for. Without it, the render between a
   *  country change and the effect that loads it would show the previous
   *  country's error under the new country's heading. */
  country: string | null;
  data: ChartPayload | null;
  loading: boolean;
  error: string | null;
}

/** Layout effects do not exist on the server, and React warns if they run there.
 *  On the client the cache read must happen before the browser paints. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const EMPTY: State = { country: null, data: null, loading: false, error: null };

/**
 * Chart fetching for the selected country, over the shared browser-side loader.
 *
 * The persisted read happens in a layout effect rather than a passive one: on a
 * reload the server HTML is the loading skeleton, and the cached rows must land
 * in the same commit the browser is about to paint. `readCharts` underneath is
 * synchronous, so the first client frame already has the list. The same is true
 * of a click on a country that was hovered long enough to prefetch — the payload
 * is in memory by then, and the panel never shows a skeleton for it.
 *
 * The request carries both kinds, so the effect is keyed by country alone and
 * changing the active tab is a pure render — it must never re-run this effect
 * or cost a second request.
 *
 * `retry` deliberately bypasses every cache tier and any request in flight: a
 * "Try again" that hits the same cached failure is not a retry. It also tells the
 * server to skip its fresh tier, so recovery is possible without reloading the
 * page.
 */
export function useChart(country: string | null) {
  const [state, setState] = useState<State>(EMPTY);
  /** Identifies the load whose answer the panel is allowed to show. A request is
   *  never aborted for leaving a country: it is shared with the prefetcher and
   *  its payload is worth keeping. The generation is what makes a late answer
   *  for the previous country harmless. */
  const generation = useRef(0);

  const load = useCallback((iso: string, refresh = false) => {
    const mine = ++generation.current;

    if (!refresh) {
      const cached = chartLoader.peek(iso);
      if (cached) {
        setState({ country: iso, data: cached, loading: false, error: null });
        return;
      }
    }

    const answer = refresh
      ? ({ pending: chartLoader.refresh(iso) } as const)
      : chartLoader.load(iso);

    if ("cached" in answer) {
      setState({ country: iso, data: answer.cached, loading: false, error: null });
      return;
    }

    setState({ country: iso, data: null, loading: true, error: null });
    answer.pending.then(
      (payload) => {
        if (generation.current !== mine) return;
        setState({ country: iso, data: payload, loading: false, error: null });
      },
      (error: unknown) => {
        if (generation.current !== mine) return;
        setState({
          country: iso,
          data: null,
          loading: false,
          error: error instanceof Error ? error.message : "Could not reach the charts service",
        });
      }
    );
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!country) {
      generation.current++;
      setState(EMPTY);
      return;
    }
    load(country);
    return () => {
      generation.current++;
    };
  }, [country, load]);

  const retry = useCallback(() => {
    if (country) load(country, true);
  }, [country, load]);

  // Only the current country's answer may reach the panel. On the render before
  // the layout effect runs, `state.country` is still the previous one; reporting
  // it as "loading" is what keeps the skeleton up instead of an empty list.
  const current = country != null && state.country === country;
  return {
    data: current ? state.data : null,
    loading: country != null && (!current || state.loading),
    error: current ? state.error : null,
    retry,
  };
}

/**
 * Warm the chart of the country the pointer is resting on.
 *
 * `pointermove` carries the "still resting" part. The hover value only changes
 * when the country under the pointer does, so keying the debounce off it alone
 * would prefetch Russia once the pointer had spent 150ms crossing it — and would
 * turn the gate's hover sweep into a burst of requests. Any movement restarts
 * the wait; a drag ends the hover entirely, which cancels it.
 *
 * `enabled` is the camera's own rest state. A drag keeps gliding under the
 * pointer after the button is released, and the re-pick during that glide looks
 * exactly like a deliberate hover — 150ms of a country being under a still
 * pointer. Disabling the prefetcher for the duration of the movement means the
 * first request can only start once the globe has actually stopped.
 */
export function useChartPrefetch(iso: string | null, enabled = true): void {
  useEffect(() => {
    if (!iso || !enabled) {
      chartLoader.hover(null);
      return;
    }
    chartLoader.hover(iso);
    const restart = () => chartLoader.hover(iso, { restart: true });
    window.addEventListener("pointermove", restart, { passive: true });
    return () => {
      window.removeEventListener("pointermove", restart);
      // Leaving the country (or the page) abandons a speculative request. A
      // request the panel has adopted survives this by design.
      chartLoader.hover(null);
    };
  }, [iso, enabled]);
}
