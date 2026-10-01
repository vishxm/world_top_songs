import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import GlobeView, { type StageCountry } from "~/components/GlobeView";
import ChartPanel, { type ChartKind } from "~/components/ChartPanel";
import ChartPeek from "~/components/ChartPeek";
import type { ChartTrack } from "~/lib/analyticsCharts";
import Header from "~/components/Header";
import RegionRail from "~/components/RegionRail";
import NowPlaying from "~/components/NowPlaying";
import { CountryMark, EmptyState } from "~/components/ui";
import { AlertTriangle, Compass } from "lucide-react";
import { CHART_ISOS } from "~/lib/countries";
import { loadBorderGeometry, loadCountryCaps } from "~/lib/mapData";
import { useChart } from "~/hooks/useChart";
import { useReducedMotion, useStoredState } from "~/hooks/usePrefs";
import { useTheme, useThemeTokens } from "~/hooks/useTheme";
import type { Region } from "~/lib/countryMeta";

const PANEL_WIDTH = 384;
const GUTTER = 48;
/** Viewport fraction the bottom sheet occupies on narrow screens when it is
 *  open. This is the source of the sheet's own height (`--sheet-h`), and the globe
 *  offset, camera altitude and chrome offsets are all derived from the same
 *  number — see `sheetReserve`. */
const SHEET_FRACTION = 0.48;
/** Collapsed sheet: one peek bar (measured at 54px) plus a couple of px of slack,
 *  so a slightly taller bar on another device cannot slide under the globe. */
const SHEET_PEEK_PX = 56;
/**
 * Height the docked player adds under a folded sheet: its collapsed controls
 * (measured at 84px) plus the `gap-2.5` above them.
 *
 * A constant rather than a measurement, because the obvious way to measure it —
 * a ResizeObserver feeding layout that feeds the globe — is a loop waiting to
 * happen for a few pixels. It also only needs to be right for the collapsed
 * player: opening the video makes it ~200px taller, and at that size it covers
 * the globe anyway.
 */
const PLAYER_ALLOWANCE_PX = 94;
/** Vertical space the header occupies on narrow screens; the globe centres in
 *  what is left. Matches Header.tsx's two-row mobile layout. */
const HEADER_CLEARANCE = 118;
const FOV_TAN = Math.tan((50 / 2) * (Math.PI / 180)); // three-globe's fixed 50° fov

/**
 * Camera altitude (1 + distance/radius) that makes the globe fill `targetRadius`
 * pixels. Solved from the projection rather than hand-tuned, so it stays correct
 * at any viewport size.
 */
function altitudeForRadius(viewportH: number, targetRadius: number): number {
  return viewportH / 2 / (targetRadius * FOV_TAN) - 1;
}

/**
 * Wide layouts frame an individual country, so the altitude follows the country's
 * angular size — but the globe's *near* edge must stay clear of the right rail,
 * since that is where the selected country ends up. Fitting the near limb inside
 * the stage is what stops the focus from hiding under the panel.
 *
 * Narrow layouts cannot zoom in at all: the globe shares the screen with the
 * sheet and header, so it gets one fixed radius that fills the clear band, and
 * the selected country is found by spinning rather than by framing.
 *
 * `sheetPx` is the sheet's height in px, not a fraction: it changes when the
 * sheet is collapsed, and the globe has to grow into whatever is left. Deriving
 * it from a constant is what pinned the phone globe to a 48vh sliver even after
 * the sheet dropped away.
 */
function altitudeForViewport(span: number, width: number, viewportH: number, sheetPx: number): number {
  if (width < 1024) {
    // Fit the clear band above the sheet, not the whole screen: the globe should
    // read as a full disc in the space the user can actually see.
    const clearBand = viewportH - sheetPx - HEADER_CLEARANCE;
    const target = Math.min(width * 0.47, clearBand * 0.5);
    return Math.max(2.4, altitudeForRadius(viewportH, target));
  }
  const stageWidth = width - (PANEL_WIDTH + GUTTER);
  // Zoom out far enough that the whole sphere stays inside the stage, then zoom
  // back in as far as the country's own size allows — so a city-state fills the
  // stage while Russia still fits, instead of one fixed compromise for both.
  const fitRadius = Math.min(stageWidth * 0.6, viewportH * 0.46);
  const minRadius = Math.min(stageWidth * 0.2, viewportH * 0.14);
  const maxRadius = Math.min(stageWidth * 0.62, viewportH * 0.46);
  // Radius that would frame the country, then clamp it into the stage.
  const wanted = ((span / 2.2) * FOV_TAN * viewportH) / 2;
  return altitudeForRadius(viewportH, Math.min(fitRadius, Math.max(minRadius, Math.min(maxRadius, wanted))));
}

export default function Home() {
  const [params, setParams] = useSearchParams();
  const reducedMotion = useReducedMotion();
  const { theme, setTheme } = useTheme();
  const tokens = useThemeTokens(theme);
  const [storedIso, setStoredIso] = useStoredState("wts.country", "US");

  // Measure once per layout change rather than tracking every scroll/resize:
  // the only numbers we need are the breakpoint, a coarse viewport width, and
  // the height (the narrow-screen globe offset depends on it).
  const viewportRef = useRef({ w: 1440, h: 900, isWide: true });

  const [countries, setCountries] = useState<StageCountry[]>([]);
  const [borders, setBorders] = useState<[number, number][][]>([]);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapLoading, setMapLoading] = useState(true);

  const [hovered, setHovered] = useState<StageCountry | null>(null);
  const [regionFilter, setRegionFilter] = useState<Region | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; altitude: number; n: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [viewportW, setViewportW] = useState(1440);
  const [hintDone, setHintDone] = useStoredState("wts.hint", "");

  /**
   * Narrow layouts only: has the user folded the chart sheet away to the peek bar?
   *
   * Distinct from having *closed* the chart (`closePanel`), which drops the
   * selection and the URL's `?c=` — folding keeps the country selected, so the
   * ring stays on the globe and the audio keeps playing; it only hands the screen
   * back. Wide layouts have a right rail rather than a sheet and ignore it
   * entirely, so this never has to be reset on a breakpoint change.
   */
  const [sheetFolded, setSheetFolded] = useState(false);

  // ------------------------------------------------------------ map loading
  useEffect(() => {
    const ctrl = new AbortController();
    setMapLoading(true);
    Promise.all([loadCountryCaps(ctrl.signal), loadBorderGeometry(ctrl.signal)])
      .then(([caps, rings]) => {
        setCountries(caps);
        setBorders(rings);
        setMapError(null);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setMapError(e instanceof Error ? e.message : "Could not load the world map");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setMapLoading(false);
      });
    return () => ctrl.abort();
  }, []);

  // Only the breakpoint and the width matter, so snap the width to 100px steps
// and ignore height-only changes (mobile browser chrome) entirely.
useEffect(() => {
    let lastW = -1;
    let lastH = -1;
    const update = () => {
      const w = Math.round(window.innerWidth / 100) * 100;
      const h = window.innerHeight;
      const isWide = window.innerWidth >= 1024;
      // Height only matters on narrow layouts (mobile browser chrome changes it).
      const hBucket = isWide ? 0 : Math.round(h / 40) * 40;
      if (w === lastW && hBucket === lastH) return;
      lastW = w;
      lastH = hBucket;
      setViewportW(w);
      viewportRef.current = { w, h: hBucket || h, isWide };
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // ---------------------------------------------------------------- routing
  // The URL is the source of truth for selection, so a country is shareable and
  // the back button steps through history.
  const selectedIso = params.get("c");
  const kind: ChartKind = params.get("kind") === "videos" ? "videos" : "songs";

  const byIso = useMemo(() => {
    const m = new Map<string, StageCountry>();
    for (const c of countries) if (!m.has(c.iso)) m.set(c.iso, c);
    return m;
  }, [countries]);

  const selected = selectedIso ? byIso.get(selectedIso) ?? null : null;

  const patchParams = useCallback(
    (next: { c?: string | null; kind?: ChartKind }) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next.c === null) p.delete("c");
          else if (next.c !== undefined) p.set("c", next.c);
          if (next.kind) p.set("kind", next.kind);
          return p;
        },
        { replace: false }
      );
    },
    [setParams]
  );

  // Switching country must NOT stop the music. The queue is deliberately held
  // outside the chart panel: playback state belongs to the session, not to
  // whichever country's list happens to be on screen.
  const select = useCallback(
    (c: StageCountry) => {
      setStoredIso(c.iso);
      patchParams({ c: c.iso });
      // Picking a country — by globe tap, the palette or Surprise me — is an
      // explicit request to read its chart, so a folded sheet comes back. Left
      // folded, the tap would light the country up on the globe and appear to do
      // nothing at all, because the list it was asking for is hidden.
      setSheetFolded(false);
    },
    [patchParams, setStoredIso]
  );

  const changeTab = useCallback((k: ChartKind) => patchParams({ kind: k }), [patchParams]);

  const closePanel = useCallback(() => {
    patchParams({ c: null });
  }, [patchParams]);

  // First visit with no `?c`: land somewhere with a live chart rather than an
  // empty stage. `replace` keeps this out of the history stack.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current || countries.length === 0) return;
    bootstrapped.current = true;
    if (params.has("c")) return;
    const iso = byIso.has(storedIso) ? storedIso : (CHART_ISOS.find((i) => byIso.has(i)) ?? "US");
    setParams(new URLSearchParams({ c: iso, kind }), { replace: true });
  }, [countries.length, byIso, storedIso, params, setParams, kind]);

  const [isPlaying, setIsPlaying] = useState(false);

  // The queue is a snapshot of whatever list the user pressed play in. It
  // survives country and tab changes so audio is never interrupted by navigation.
  const [queue, setQueue] = useState<ChartTrack[]>([]);

  const { data, loading, error, retry } = useChart(selectedIso, kind);

  const playFromChart = useCallback((tracks: ChartTrack[], index: number) => {
    setQueue(tracks);
    setActiveIndex(index);
  }, []);

  /** The video currently playing, identified by id rather than index — the
   *  queue outlives the chart panel, so an index would point at a different
   *  track the moment you switch country. */
  const activeVideoId = activeIndex != null ? (queue[activeIndex]?.videoId ?? null) : null;
  const playerActive = queue.length > 0 && activeIndex != null;

  const playNext = useCallback(() => {
    setActiveIndex((i) => (i == null || queue.length === 0 ? i : (i + 1) % queue.length));
  }, [queue.length]);

  // Guard against a queue that shrank under us (e.g. a stale track list).
  useEffect(() => {
    if (activeIndex != null && queue.length > 0 && activeIndex >= queue.length) {
      setActiveIndex(0);
    }
  }, [activeIndex, queue.length]);

  // Stage geometry: push the globe into the space the panel leaves free so it
  // always sits in the optical centre of what the user can actually see.
  // Wide: the panel is a right rail, so shift left by half its footprint.
  // Narrow: the panel is a bottom sheet, so shift up by half its height — the
  // globe then reads in the clear band above it.
  //
  // `sheetReserve` is that height in px and it is the single number the offset,
  // the camera altitude and the sheet's own CSS height are all derived from. It
  // has to be px rather than a constant fraction because the sheet folds: a
  // fraction cannot express "56px peek bar, or 48vh of list".
  const isWide = viewportRef.current.isWide;
  const sheetOpen = !!selected && !sheetFolded;
  const sheetReserve = isWide
    ? 0
    : selected && !sheetOpen
      ? // Folded: the peek bar, plus whatever the player adds beneath it.
        SHEET_PEEK_PX + (playerActive ? PLAYER_ALLOWANCE_PX : 0)
      : // Open, or nothing selected at all. The no-selection case deliberately
        // keeps reserving the full sheet: there is no sheet on screen then, but
        // the globe and the hint are framed against that reservation, and
        // collapsing it to a peek bar's worth would silently move both on a
        // first visit before the bootstrap picks a country.
        viewportRef.current.h * SHEET_FRACTION;

  // Memoised so its identity survives a re-render. The route re-renders on every
  // globe hover, and GlobeView keys its offset effect off this prop: a fresh array
  // each time would re-write the camera's view offset on every pointer move.
  const offset = useMemo<[number, number]>(
    () =>
      isWide ? [-(PANEL_WIDTH + GUTTER) / 2, 0] : [0, -sheetReserve / 2 + HEADER_CLEARANCE / 2],
    [isWide, sheetReserve]
  );

  // The camera follows the selection, whichever way it changed — globe click,
  // palette, URL deep link, or the back button.
  //
  // Keyed on the reserved sheet height as well as the country, because folding the
  // sheet changes the clear band and the globe has to re-frame into it. Re-firing
  // `pointOfView` with the SAME lat/lng and a new altitude is what makes the fold
  // read as the globe growing into the space it just got, rather than the camera
  // sitting in a sliver it no longer has.
  const focusedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    const key = `${selected.iso}@${Math.round(sheetReserve)}`;
    if (focusedKey.current === key) return;
    focusedKey.current = key;
    setFocus({
      lat: selected.lat,
      lng: selected.lng,
      altitude: altitudeForViewport(
        selected.span,
        viewportRef.current.w,
        viewportRef.current.h,
        sheetReserve
      ),
      n: Date.now(),
    });
  }, [selected, viewportW, sheetReserve]);

  useEffect(() => {
    if (!selectedIso) focusedKey.current = null;
  }, [selectedIso]);

  const surprise = useCallback(() => {
    const pool = CHART_ISOS.filter((iso) => byIso.has(iso));
    if (pool.length === 0) return;
    const iso = pool[Math.floor(Math.random() * pool.length)];
    const c = byIso.get(iso);
    if (c) select(c);
  }, [byIso, select]);

  /** Fold/unfold the sheet. Narrow layouts only — on wide the panel is a rail
   *  with no fold, so `isWide` short-circuits and the state just sits unused. */
  const setFolded = useCallback(
    (folded: boolean) => {
      if (viewportRef.current.isWide) return;
      setSheetFolded(folded);
    },
    []
  );

  const foldSheet = useCallback(() => setFolded(true), [setFolded]);
  const unfoldSheet = useCallback(() => setFolded(false), [setFolded]);

  const showHint = !hintDone && countries.length > 0 && !mapLoading;
  const dismissHint = useCallback(() => setHintDone("1"), [setHintDone]);

  if (mapError) {
    return (
      <main className="fixed inset-0 grid place-items-center bg-void px-6 text-ink">
        <EmptyState
          icon={<AlertTriangle className="h-5 w-5" />}
          title="The map didn't load"
          body={mapError}
          action={
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-accent-ink"
            >
              Reload
            </button>
          }
        />
      </main>
    );
  }

  return (
    // `--sheet-h` is how the chrome above the sheet (the region rail, the hint)
    // learns how tall the sheet currently is. It has to be a variable rather than
    // the `48vh` literal that used to be repeated in those offsets: once the sheet
    // can fold to a 56px peek bar, a hardcoded fraction is simply the wrong
    // number, and Tailwind cannot compute one class from another class.
    <main
      className="fixed inset-0 overflow-hidden bg-void text-ink"
      style={{ "--sheet-h": `${sheetReserve}px` } as CSSProperties}
    >
      <GlobeView
        countries={countries}
        borders={borders}
        selectedIso={selectedIso}
        hoverIso={hovered?.iso ?? null}
        focus={focus}
        offset={offset}
        reducedMotion={reducedMotion}
        regionFilter={regionFilter}
        palette={tokens.globe}
        onHover={setHovered}
        onSelect={select}
        onEmptyTap={foldSheet}
      />

      {/* Vignette: pulls the eye to the globe and stops the star field from
          fighting the panel text. Kept light — the globe is the subject. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(115%_85%_at_38%_48%,transparent_45%,color-mix(in_oklab,var(--color-void)_82%,transparent)_100%)]"
      />

      <Header
        countries={countries}
        hovered={hovered}
        selectedIso={selectedIso}
        theme={theme}
        onPick={select}
        onSurprise={surprise}
        onTheme={setTheme}
      />

      {/* Region rail.
          Narrow: it sits in the gap between the globe stage and the sheet, so it
          cannot collide with either.
          Wide: the panel is full-height on the right, so the rail is capped at the
          panel's left edge. It used to be pinned to `sm:left-5` with no right
          bound, which put the last four chips underneath the panel — and the panel
          is a later sibling with a higher z-index, so those chips were not merely
          covered, they were unclickable: `elementFromPoint` over Europe, Oceania
          and Polar returned the chart's metadata line, not the button. Any viewport
          narrower than roughly 1128px with a country selected hit this, which is
          most laptops and every tablet.

          `z-30` for the same reason against the hint below. The rail wraps to as
          many rows as it needs, and a three-row rail on a phone grows straight up
          into the hint's band; both are `pointer-events-auto`, so at equal z-index
          the later sibling in the DOM wins and eats the chips' clicks. */}
      <div
        className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center px-3 sm:left-5 sm:px-0 ${
          selected || playerActive ? "sm:right-[26.5rem]" : "sm:right-5"
        } ${selected ? "bottom-[calc(var(--sheet-h)+1.25rem)] sm:bottom-5" : "bottom-3 sm:bottom-5"}`}
      >
        <RegionRail countries={countries} region={regionFilter} onRegion={setRegionFilter} />
      </div>

      {/* Hint. Sits clear above the rail, which is bottom-anchored and grows upward
          as it wraps — an offset that cleared one row does not clear three. */}
      {showHint ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--sheet-h)+8.5rem)] z-20 flex justify-center px-3 sm:inset-x-auto sm:bottom-20 sm:left-5 sm:justify-start sm:px-0">
          <p
            className="glass pointer-events-auto w-fit max-w-[min(34rem,100%)] rounded-xl px-3.5 py-2 text-[12px] text-muted motion-safe:animate-rise"
            onClick={dismissHint}
          >
            Drag the globe to spin it. Click any country to load its weekly Top 10 — or press{" "}
            <kbd className="rounded border border-line px-1">⌘K</kbd> to pick from all {countries.length}.
          </p>
        </div>
      ) : null}

      {/* Chart + player share one column so they can never overlap: the chart
          takes the flexible space and the player keeps its natural height at the
          bottom. The player is NOT gated on `data` — that tore the audio down on
          every country switch — only on the queue, which outlives the chart. The
          rail also stays mounted with no country selected so closing the panel
          does not take the transport controls with it. */}
      {selected || playerActive ? (
        <aside
          className={`fixed right-3 bottom-3 left-3 z-30 flex flex-col gap-2.5 sm:right-5 sm:bottom-5 sm:left-auto sm:w-[384px] ${
            selected
              ? sheetOpen
                ? // Height is the variable, not `48vh`, so it matches `sheetReserve`
                  // exactly — the rail, the hint and the globe all read the same
                  // number that positions this box, and folding moves all four
                  // together instead of three of them.
                  "h-[var(--sheet-h)] sm:h-[calc(100vh-2.5rem)]"
                : "h-auto"
              : ""
          }`}
          aria-label="Chart and player"
        >
          {selected ? (
            sheetOpen ? (
              <div className="min-h-0 flex-1">
                <ChartPanel
                  iso={selected.iso}
                  name={selected.name}
                  region={selected.region}
                  data={data}
                  loading={loading}
                  error={error}
                  kind={kind}
                  activeVideoId={activeVideoId}
                  isPlaying={isPlaying}
                  isPaused={activeVideoId != null && !isPlaying}
                  onTab={changeTab}
                  onPlay={(i) => playFromChart(data?.tracks ?? [], i)}
                  onRetry={retry}
                  onClose={closePanel}
                  // Narrow layouts only: wide has a rail, and a collapse chevron
                  // there would promise a fold that does not exist.
                  onFold={isWide ? undefined : foldSheet}
                />
              </div>
            ) : (
              <div className="shrink-0">
                <ChartPeek
                  iso={selected.iso}
                  name={selected.name}
                  region={selected.region}
                  data={data}
                  loading={loading}
                  onExpand={unfoldSheet}
                />
              </div>
            )
          ) : null}
          {playerActive ? (
            <div className="shrink-0">
              <NowPlaying
                tracks={queue}
                activeIndex={activeIndex}
                onSelect={setActiveIndex}
                onEnded={playNext}
                onPlayingChange={setIsPlaying}
              />
            </div>
          ) : null}
        </aside>
      ) : null}

      {/* Screen-reader only: the globe is not navigable, so announce what a
          keyboard user just selected. */}
      <p className="sr-only" aria-live="polite">
        {selected
          ? `${selected.name} chart, ${kind === "songs" ? "top songs" : "top videos"}. ${loading ? "Loading." : data ? `${data.tracks.length} tracks.` : error ? `Error: ${error}` : ""}`
          : ""}
      </p>

      {/* Idle / empty stage affordance, also the loading state. */}
      {!selected && (mapLoading || countries.length === 0) ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="relative grid h-12 w-12 place-items-center">
              <span className="absolute inset-0 animate-halo rounded-full border border-accent" />
              <Compass className="h-5 w-5 text-accent" />
            </span>
            <p className="text-[12px] text-faint">Drawing the world…</p>
          </div>
        </div>
      ) : null}

      {!selected && countries.length > 0 && !mapLoading ? (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 left-1/2 z-20 hidden -translate-x-1/2 -translate-y-1/2 md:block">
          <div className="glass flex items-center gap-3 rounded-panel px-4 py-3">
            <Compass className="h-4 w-4 text-accent" />
            <p className="text-[12.5px] text-muted">
              Pick a country to hear its weekly Top 10
            </p>
          </div>
        </div>
      ) : null}
    </main>
  );
}
