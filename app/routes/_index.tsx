import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GlobeView, { GEOJSON_URL, featureToCountry, type CountryFeature } from "~/components/GlobeView";
import Top10Panel, { type ChartData, type ChartKind } from "~/components/Top10Panel";
import SearchBar from "~/components/SearchBar";
import { CHART_COUNTRIES, flagEmoji } from "~/lib/countries";

export default function Home() {
  const [features, setFeatures] = useState<CountryFeature[]>([]);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CountryFeature | null>(null);
  const [hovered, setHovered] = useState<CountryFeature | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; n: number } | null>(null);
  const [data, setData] = useState<ChartData | null>(null);
  const [kind, setKind] = useState<ChartKind>("songs");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(GEOJSON_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`geo http=${r.status}`);
        return r.json();
      })
      .then((geo: { features?: unknown[] }) => {
        if (cancelled) return;
        const list = (geo.features ?? [])
          .map((f) => featureToCountry(f))
          .filter((c): c is CountryFeature => c != null);
        // De-dupe by ISO (keep first).
        const seen = new Set<string>();
        setFeatures(list.filter((c) => (seen.has(c.iso) ? false : (seen.add(c.iso), true))));
      })
      .catch((e) => {
        if (!cancelled) setGeoError(e instanceof Error ? e.message : "map failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const byIso = useMemo(() => {
    const m = new Map<string, CountryFeature>();
    features.forEach((f) => {
      if (!m.has(f.iso)) m.set(f.iso, f);
    });
    return m;
  }, [features]);

  // Precise picker: every chart country, for taps too small for the globe.
  const quickList = useMemo(
    () =>
      Object.keys(CHART_COUNTRIES)
        .map((iso) => byIso.get(iso))
        .filter((c): c is CountryFeature => c != null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [byIso]
  );

  // Desktop: shift the globe left so the open panel never covers it.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const globeOffset: [number, number] = selected && wide ? [-150, 0] : [0, 0];

  const loadCharts = useCallback((iso: string, k: ChartKind) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    setData(null);
    setActiveIndex(null);
    fetch(`/api/charts?country=${iso}&type=${k}`, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`http=${r.status}`);
        return r.json();
      })
      .then((j) => {
        setData(j as ChartData);
        setLoading(false);
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : "fetch failed");
        setLoading(false);
      });
  }, []);

  const select = useCallback(
    (c: CountryFeature) => {
      setSelected(c);
      setFocus({ lat: c.lat, lng: c.lng, n: Date.now() });
      loadCharts(c.iso, kind);
    },
    [loadCharts, kind]
  );

  const changeTab = useCallback(
    (k: ChartKind) => {
      setKind(k);
      if (selected) loadCharts(selected.iso, k);
    },
    [loadCharts, selected]
  );

  // Pre-select the US so first paint already shows a live Top 10.
  const preselected = useRef(false);
  useEffect(() => {
    if (!preselected.current && byIso.has("US")) {
      preselected.current = true;
      const us = byIso.get("US")!;
      setSelected(us);
      loadCharts("US", "songs");
    }
  }, [byIso, loadCharts]);

  const surprise = useCallback(() => {
    const pool = Object.keys(CHART_COUNTRIES).filter((iso) => byIso.has(iso));
    if (pool.length === 0) return;
    const iso = pool[Math.floor(Math.random() * pool.length)];
    select(byIso.get(iso)!);
  }, [byIso, select]);

  const playNext = useCallback(() => {
    setActiveIndex((i) => {
      if (i == null || !data) return i;
      return (i + 1) % data.tracks.length;
    });
  }, [data]);

  // Stable callbacks so the memoized panel/search skip hover-only renders.
  const retryCharts = useCallback(() => {
    if (selected) loadCharts(selected.iso, kind);
  }, [loadCharts, selected, kind]);
  const closePanel = useCallback(() => {
    setSelected(null);
    setData(null);
    setActiveIndex(null);
  }, []);

  return (
    <main className="fixed inset-0 overflow-hidden bg-black text-white">
      {geoError ? (
        <div className="flex h-full items-center justify-center p-8 text-center">
          <p className="text-sm text-red-300">Map failed to load: {geoError}</p>
        </div>
      ) : (
        <GlobeView
          features={features}
          selectedIso={selected?.iso ?? null}
          hoverIso={hovered?.iso ?? null}
          focus={focus}
          offset={globeOffset}
          onHover={setHovered}
          onSelect={select}
        />
      )}

      {/* Header */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-4">
        <div className="pointer-events-auto">
          <h1 className="text-xl font-black tracking-tight drop-shadow sm:text-2xl">
            🌍 World Top Songs
          </h1>
          <p className="text-xs text-zinc-400 drop-shadow">
            {hovered ? (
              <>
                {flagEmoji(hovered.iso)} {hovered.name} — click to hear its Top 10
              </>
            ) : (
              "Spin the globe · click a country · hear its Top 10"
            )}
          </p>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <SearchBar countries={features} quickList={quickList} onPick={select} />
          <button
            onClick={surprise}
            className="shrink-0 rounded-full bg-blue-500 px-4 py-2 text-sm font-semibold shadow-lg hover:bg-blue-400"
          >
            🎲 Surprise me
          </button>
        </div>
      </header>

      {/* Chart panel: side panel on desktop, bottom sheet on mobile */}
      {selected && (
        <div className="absolute inset-x-2 bottom-2 z-10 max-h-[52%] sm:inset-x-auto sm:bottom-4 sm:right-4 sm:top-24 sm:max-h-none sm:w-[380px]">
          <Top10Panel
            iso={selected.iso}
            name={selected.name}
            data={data}
            loading={loading}
            error={error}
            kind={kind}
            activeIndex={activeIndex}
            onTab={changeTab}
            onPlay={setActiveIndex}
            onNext={playNext}
            onRetry={retryCharts}
            onClose={closePanel}
          />
        </div>
      )}
    </main>
  );
}
