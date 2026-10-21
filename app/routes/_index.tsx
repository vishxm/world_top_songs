import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import GlobeView, { type StageCountry } from "~/components/GlobeView";
import ChartPanel, { type ChartKind } from "~/components/ChartPanel";
import ChartPeek from "~/components/ChartPeek";
import type { ChartTrack } from "~/lib/analyticsCharts";
import Header from "~/components/Header";
import RegionRail from "~/components/RegionRail";
import NowPlaying from "~/components/NowPlaying";
import { AtlasMark, EmptyState } from "~/components/ui";
import { AlertTriangle } from "lucide-react";
import { CHART_ISOS } from "~/lib/countries";
import { loadBorderGeometry, loadCountryCaps } from "~/lib/mapData";
import { useChart } from "~/hooks/useChart";
import { useReducedMotion, useStoredState } from "~/hooks/usePrefs";
import { useGlobePalette } from "~/hooks/useGlobePalette";
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

type RecoveryNotice = { message: string; iso: string };

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
  const palette = useGlobePalette();
  const [storedIso, setStoredIso] = useStoredState("wts.country", "US");

  // Measure once per layout change rather than tracking every scroll/resize:
  // the only numbers we need are the breakpoint, a coarse viewport width, and
  // the height (the narrow-screen globe offset depends on it).
  const viewportRef = useRef({ w: 1440, h: 900, isWide: true });

  const [countries, setCountries] = useState<StageCountry[]>([]);
  const [borders, setBorders] = useState<[number, number][][]>([]);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapLoading, setMapLoading] = useState(true);
  /** Set by GlobeView once the caps exist and picking is live. Until then the
   *  stage shows its loading copy and the canvas ignores pointer input. */
  const [globeReady, setGlobeReady] = useState(false);
  const handleGlobeInteractive = useCallback(() => setGlobeReady(true), []);

  const [hovered, setHovered] = useState<StageCountry | null>(null);
  const [regionFilter, setRegionFilter] = useState<Region | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; altitude: number; n: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [viewportW, setViewportW] = useState(1440);
  /** Set when a bad `?c=` was recovered to a real country, so the chart can
   *  explain why the address changed. Tied to the fallback ISO so it cannot
   *  outlive a later back/forward to another country. */
  const [recoveryNotice, setRecoveryNotice] = useState<RecoveryNotice | null>(null);

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
  // the back button steps through history. Codes are case-insensitive on the way
  // in; the URL is canonicalised to the map's ISO once the map has loaded.
  const rawIso = params.get("c");
  const requestedIso = rawIso?.trim() ? rawIso.trim().toUpperCase() : null;
  const kind: ChartKind = params.get("kind") === "videos" ? "videos" : "songs";

  const byIso = useMemo(() => {
    const m = new Map<string, StageCountry>();
    for (const c of countries) if (!m.has(c.iso)) m.set(c.iso, c);
    return m;
  }, [countries]);

  const selected = requestedIso ? byIso.get(requestedIso) ?? null : null;
  const selectedIso = selected?.iso ?? null;
  const recoveryMessage = recoveryNotice?.iso === selectedIso ? recoveryNotice.message : null;

  const patchParams = useCallback(
    (next: { c?: string | null; kind?: ChartKind }, opts?: { replace?: boolean }) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next.c === null) p.delete("c");
          else if (next.c !== undefined) p.set("c", next.c);
          if (next.kind) p.set("kind", next.kind);
          return p;
        },
        { replace: opts?.replace ?? false }
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
      setRecoveryNotice(null);
      patchParams({ c: c.iso });
      // Picking a country — by globe tap, the picker or Surprise me — is an
      // explicit request to read its chart, so a folded sheet comes back. Left
      // folded, the tap would light the country up on the globe and appear to do
      // nothing at all, because the list it was asking for is hidden.
      setSheetFolded(false);
    },
    [patchParams, setStoredIso]
  );

  const changeTab = useCallback((k: ChartKind) => patchParams({ kind: k }), [patchParams]);

  const closePanel = useCallback(() => {
    setRecoveryNotice(null);
    patchParams({ c: null });
  }, [patchParams]);

  // First visit with no `?c`: land somewhere with a live chart rather than an
  // empty stage. `replace` keeps this out of the history stack. A supplied
  // `?c=` — even a blank one — goes through the recovery effects below instead,
  // so a malformed link is explained rather than silently bootstrapped.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current || countries.length === 0) return;
    bootstrapped.current = true;
    if (rawIso !== null) return;
    const iso = byIso.has(storedIso) ? storedIso : (CHART_ISOS.find((i) => byIso.has(i)) ?? "US");
    setParams(new URLSearchParams({ c: iso, kind }), { replace: true });
  }, [countries.length, byIso, storedIso, rawIso, setParams, kind]);

  // A known country written in lower case (or with stray spaces) is still the
  // same selection. Rewrite the address bar to the canonical ISO with replace,
  // so the sloppy spelling does not become a history entry.
  useEffect(() => {
    if (!selected) return;
    if (rawIso === selected.iso) return;
    patchParams({ c: selected.iso }, { replace: true });
  }, [selected, rawIso, patchParams]);

  // A bad `?c=` must not leave a bare globe. Once the map is available, fall
  // back to the last valid country (or the first charted one), stay on the same
  // history entry, and tell the chart why the address changed. A blank `?c=`
  // is a bad link too; no `c` at all is an intentional empty stage.
  useEffect(() => {
    if (mapLoading || countries.length === 0 || selected) return;
    if (rawIso === null) return;
    const iso = byIso.has(storedIso) ? storedIso : (CHART_ISOS.find((i) => byIso.has(i)) ?? null);
    const fallback = iso ? (byIso.get(iso) ?? null) : null;
    if (!fallback) return;
    // The notice lives in the chart panel, so a folded sheet would hide the
    // explanation. Recovery is a selection: bring the chart back.
    setSheetFolded(false);
    setRecoveryNotice({
      iso: fallback.iso,
      message: requestedIso
        ? `We couldn’t find a country for “${requestedIso}”. Showing ${fallback.name} instead.`
        : `That link didn’t name a country. Showing ${fallback.name} instead.`,
    });
    patchParams({ c: fallback.iso }, { replace: true });
  }, [
    mapLoading,
    countries.length,
    rawIso,
    requestedIso,
    selected,
    byIso,
    storedIso,
    patchParams,
  ]);

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
        // the globe is framed against that reservation, and collapsing it to a
        // peek bar's worth would silently move it on a first visit before the
        // bootstrap picks a country.
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
  // picker, URL deep link, or the back button.
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
              className="btn btn-primary"
            >
              Reload
            </button>
          }
        />
      </main>
    );
  }

  return (
    // `--sheet-h` is how the chrome above the sheet (the region rail) learns how
    // tall the sheet currently is. It has to be a variable rather than the `48vh`
    // literal that used to be repeated in those offsets: once the sheet can fold
    // to a 56px peek bar, a hardcoded fraction is simply the wrong number, and
    // Tailwind cannot compute one class from another class.
    <main
      id="main"
      className="fixed inset-0 overflow-hidden bg-void text-ink"
      style={{ "--sheet-h": `${sheetReserve}px` } as CSSProperties}
    >
      {/* Globe stage. A named landmark so the canvas is not an anonymous
          full-bleed div in the accessibility tree. */}
      <section aria-label="World globe" className="absolute inset-0 z-0">
        <GlobeView
          countries={countries}
          borders={borders}
          selectedIso={selectedIso}
          hoverIso={hovered?.iso ?? null}
          focus={focus}
          offset={offset}
          reducedMotion={reducedMotion}
          regionFilter={regionFilter}
          palette={palette}
          onHover={setHovered}
          onSelect={select}
          onEmptyTap={foldSheet}
          onInteractive={handleGlobeInteractive}
        />
      </section>

      {/* Vignette + scrim: settle the sphere into the page and keep header and
          rail text legible over bright land. The globe is the subject; these
          only remove the edge. */}
      <div aria-hidden className="stage-vignette pointer-events-none absolute inset-0 z-10" />
      <div aria-hidden className="stage-scrim pointer-events-none absolute inset-0 z-10" />

      <Header
        countries={countries}
        hovered={hovered}
        selectedIso={selectedIso}
        onPick={select}
        onSurprise={surprise}
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

          `z-30` keeps it above the vignette, and the right bound keeps it clear of
          the chart surface. The rail wraps to as many rows as it needs; it grows
          upward from its bottom anchor, which is free. */}
      <div
        className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center px-3 sm:left-gutter sm:px-0 ${
          selected || playerActive ? "sm:right-[26.5rem]" : "sm:right-gutter"
        } ${selected ? "bottom-[calc(var(--sheet-h)+1.25rem)] sm:bottom-gutter" : "bottom-3 sm:bottom-gutter"}`}
      >
        {countries.length > 0 ? (
          <RegionRail countries={countries} region={regionFilter} onRegion={setRegionFilter} />
        ) : null}
      </div>

      {/* Chart + player share one column so they can never overlap: the chart
          takes the flexible space and the player keeps its natural height at the
          bottom. The player is NOT gated on `data` — that tore the audio down on
          every country switch — only on the queue, which outlives the chart. The
          rail also stays mounted with no country selected so closing the panel
          does not take the transport controls with it. */}
      {selected || playerActive ? (
        <aside
          className={`fixed right-3 bottom-3 left-3 z-30 flex flex-col gap-2.5 sm:right-gutter sm:bottom-gutter sm:left-auto sm:w-[384px] ${
            selected
              ? sheetOpen
                ? // Height is the variable, not `48vh`, so it matches `sheetReserve`
                  // exactly — the rail and the globe read the same number that
                  // positions this box, and folding moves them together.
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
                  notice={recoveryMessage}
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

      {/* The stage's own loading state, mounted from the first server render so
          there is never a blank frame waiting for the canvas. It stays in place
          (transparent and pointer-transparent) once the globe is interactive,
          which gives the handover a crossfade instead of a pop. A static mark
          rather than a pulse: the wait is short, and an animated ring competes
          with the globe it is announcing. */}
      <div
        id="stage-loading"
        role="status"
        aria-live="polite"
        aria-hidden={globeReady}
        className={`pointer-events-none absolute inset-0 z-20 grid place-items-center transition-opacity duration-[var(--duration-slow)] ease-[var(--ease-out)] ${
          globeReady ? "opacity-0" : "opacity-100"
        }`}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <AtlasMark className="h-8 w-8 text-accent" />
          <p className="eyebrow">
            {mapLoading || countries.length === 0 ? "Loading the atlas" : "Drawing the globe"}
          </p>
        </div>
      </div>

      {/* Empty stage: a sentence in the middle of the sphere, not a floating
          card. The globe remains the thing to touch — and only appears once it
          is actually interactive, so it never collides with the loading copy. */}
      {!selected && globeReady ? (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 -translate-y-1/2 px-6 text-center">
          <p className="eyebrow chrome-text text-ink/75">Nothing selected</p>
          <p className="display chrome-text mt-1.5 text-title text-ink">
            Choose a country to see its chart
          </p>
          <p className="chrome-text mt-1 text-small text-ink/85">
            Click the globe, or press ⌘K to search.
          </p>
        </div>
      ) : null}
    </main>
  );
}
