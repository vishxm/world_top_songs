import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartData, ChartKind } from "~/components/ChartPanel";

interface State {
  data: ChartData | null;
  loading: boolean;
  error: string | null;
}

/**
 * Chart fetching with request cancellation and a tiny in-session cache, so
 * flipping back to a country you already looked at is instant and never
 * re-hits the (slow, keyless) upstream.
 */
export function useChart(country: string | null, kind: ChartKind) {
  const [state, setState] = useState<State>({ data: null, loading: false, error: null });
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef(new Map<string, ChartData>());

  const load = useCallback((iso: string, k: ChartKind) => {
    const key = `${iso}:${k}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      setState({ data: cached, loading: false, error: null });
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ data: null, loading: true, error: null });
    fetch(`/api/charts?country=${encodeURIComponent(iso)}&type=${k}`, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ChartData>;
      })
      .then((json) => {
        cacheRef.current.set(key, json);
        setState({ data: json, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          data: null,
          loading: false,
          error: e instanceof Error ? e.message : "Could not reach the charts service",
        });
      });
  }, []);

  useEffect(() => {
    if (!country) {
      abortRef.current?.abort();
      setState({ data: null, loading: false, error: null });
      return;
    }
    load(country, kind);
    return () => abortRef.current?.abort();
  }, [country, kind, load]);

  return { ...state, retry: () => country && load(country, kind) };
}
