import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import GlobeView, { type StageCountry } from "~/components/GlobeView";
import ChartPanel from "~/components/ChartPanel";
import ChartPeek from "~/components/ChartPeek";
import type { PickerRequest } from "~/components/CountryPicker";
import type { ChartKind, ChartTrack } from "~/lib/chartTypes";
import Header from "~/components/Header";
import RegionRail from "~/components/RegionRail";
import NowPlaying, { type PlayerHandle } from "~/components/NowPlaying";
import { AtlasMark, EmptyState } from "~/components/ui";
import { AlertTriangle } from "lucide-react";
import { CHART_ISOS } from "~/lib/countries";
import { loadCountryCaps, loadLandLayer, type LandLayer, type LandPart } from "~/lib/mapData";
import { useChart, useChartPrefetch } from "~/hooks/useChart";
import { useReducedMotion, useStoredState } from "~/hooks/usePrefs";
import { useGlobePalette } from "~/hooks/useGlobePalette";
import type { Region } from "~/lib/countryMeta";
import { countryName, countryRegion, isKnownCountry } from "~/lib/countryMeta";

const PANEL_WIDTH = 384;
const GUTTER = 48;
/** The one layout breakpoint: the chart is a bottom sheet below it and a right
 *  rail at or above it. It matches Tailwind's `lg` and the CSS that owns
 *  `--sheet-h` — a second threshold here is how the tablet layout ended up with
 *  a full-height rail positioned by a phone's sheet reserve. */
const WIDE_MIN_PX = 1024;
/** Vertical space the header occupies on narrow screens; the globe centres in
 *  what is left. Matches Header.tsx's two-row mobile layout. */
const HEADER_CLEARANCE = 118;
const FOV_TAN = Math.tan((50 / 2) * (Math.PI / 180)); // three-globe's fixed 50° fov

/**
 * Stable empty layers for the window between mount and the map arriving.
 *
 * Module-level rather than inline `[]` defaults: GlobeView keys its full-land hit
 * layer off the parts array's identity, and a fresh array on every route render
 * (the route re-renders on every globe hover) would dispose and rebuild ~1650
 * conic polygons on every pointer move.
 */
const EMPTY_BORDERS: [number, number][][] = [];
const EMPTY_PARTS: LandPart[] = [];

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
 * sheet is collapsed, and the globe has to grow into whatever is left. It is
 * read from `--sheet-h`, the same variable that sizes the sheet and lifts the
 * rail, so the camera cannot disagree with the layout about how much room it has.
 */
function altitudeForViewport(
  span: number,
  isWide: boolean,
  width: number,
  viewportH: number,
  sheetPx: number
): number {
  if (width <= 0 || viewportH <= 0) return 2.5;
  if (!isWide) {
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
  const [storedIso, setStoredIso, storedHydrated] = useStoredState("wts.country", "US");

  // The layout is measured before the first client paint (a layout effect), and
  // starts mobile-first so the hydrated markup matches the server's. Nothing in
  // the *visual* layout depends on this state — CSS owns the responsive layout
  // and `--sheet-h` — so a wide layout is already correct in the server HTML and
  // does not wait for this. The state exists for behaviour (fold availability)
  // and for the camera, which has not painted a frame yet.
  const [viewport, setViewport] = useState({ w: 0, h: 0, isWide: false });
  /** Resolved height of `--sheet-h`, read from the DOM rather than recomputed.
   *  See the hook below: one number, one owner. */
  const [sheetReserve, setSheetReserve] = useState(0);
  const mainRef = useRef<HTMLElement | null>(null);

  const [countries, setCountries] = useState<StageCountry[]>([]);
  const [land, setLand] = useState<LandLayer | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapLoading, setMapLoading] = useState(true);
  /** Set by GlobeView once the caps exist and picking is live. Until then the
   *  stage shows its loading copy and the canvas ignores pointer input. */
  const [globeReady, setGlobeReady] = useState(false);
  const handleGlobeInteractive = useCallback(() => setGlobeReady(true), []);
  /** True while the camera is moving (drag, zoom, a flight to a selection) and
   *  for a moment after it stops. Hover prefetch is suppressed in between: a
   *  drag keeps gliding under the pointer, which otherwise looked like a hover. */
  const [globeMoving, setGlobeMoving] = useState(false);
  const handleGlobeMotion = useCallback((moving: boolean) => setGlobeMoving(moving), []);

  const [hovered, setHovered] = useState<StageCountry | null>(null);
  const [regionFilter, setRegionFilter] = useState<Region | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; altitude: number; n: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  /** The player's transport, so pressing the row that is already playing is a
   *  pause/resume instead of a dead click (or a restart from zero). */
  const playerHandle = useRef<PlayerHandle | null>(null);
  const playerBoxRef = useRef<HTMLDivElement | null>(null);
  /** The player's natural height, measured. `--player-h` is a fallback, not a
   *  second source of truth: opening the video or showing the autoplay notice
   *  makes the card taller, and the folded sheet and the rail have to clear it. */
  const [playerHeight, setPlayerHeight] = useState(0);
  /** Set when a bad `?c=` was recovered to a real country, so the chart can
   *  explain why the address changed. Tied to the fallback ISO so it cannot
   *  outlive a later back/forward to another country. */
  const [recoveryNotice, setRecoveryNotice] = useState<RecoveryNotice | null>(null);
  /** A one-shot request for the country picker, used by the no-chart notice.
   *  `id` increments per request so pressing the action again after closing the
   *  dialog reopens it; a stable object would be treated as already handled. */
  const [pickerRequest, setPickerRequest] = useState<PickerRequest | null>(null);

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
    Promise.all([loadCountryCaps(ctrl.signal), loadLandLayer(ctrl.signal)])
      .then(([caps, layer]) => {
        setCountries(caps);
        setLand(layer);
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

  // Measure the viewport before paint. `sheetReserve` is read from the resolved
  // `--sheet-h` custom property (registered as `<length>`, so the computed value
  // is px, not the `48vh` token) after every input that can change it: the
  // breakpoint, the fold state and the player. It is the one number the camera
  // offset and altitude are derived from, and it is the same variable that sizes
  // the sheet and lifts the rail.
  //
  // Reading instead of recomputing is the point: `48vh` is resolved by CSS against
  // the viewport the browser actually laid out, while `window.innerHeight` can be
  // a different viewport on a phone with its URL bar showing. Two numbers for the
  // same sheet is what made the rail and the globe disagree.
  useLayoutEffect(() => {
    const read = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const isWide = w >= WIDE_MIN_PX;
      setViewport((prev) =>
        prev.w === w && prev.h === h && prev.isWide === isWide ? prev : { w, h, isWide }
      );
    };
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  // ---------------------------------------------------------------- routing
  // The URL is the source of truth for selection, so a country is shareable and
  // the back button steps through history. Codes are case-insensitive on the way
  // in; the URL is canonicalised to the ISO as soon as it is known, without
  // waiting for the map.
  const rawIso = params.get("c");
  const requestedIso = rawIso?.trim() ? rawIso.trim().toUpperCase() : null;
  const kind: ChartKind = params.get("kind") === "videos" ? "videos" : "songs";

  const byIso = useMemo(() => {
    const m = new Map<string, StageCountry>();
    for (const c of countries) if (!m.has(c.iso)) m.set(c.iso, c);
    return m;
  }, [countries]);

  // Selection is validated against the generated country metadata, which is the
  // same set the caps layer is built from. That makes the selection — and with
  // it the chart request — available on the first render, in parallel with the
  // map assets, instead of waiting behind their fetch and parse.
  //
  // `selected` is the map-backed record and stays null until the caps arrive; it
  // carries the anchor and span the camera needs. Everything the panel shows
  // (name, region) is static metadata.
  const selectedIso = isKnownCountry(requestedIso) ? requestedIso : null;
  const selected = selectedIso ? byIso.get(selectedIso) ?? null : null;
  const selectedMeta = selectedIso
    ? {
        iso: selectedIso,
        name: countryName(selectedIso) ?? selectedIso,
        region: countryRegion(selectedIso) ?? ("Polar & Remote" as Region),
      }
    : null;
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

  /** An uncharted country's only way forward: open the picker already filtered
   *  to countries that have a chart to show. */
  const findCharted = useCallback(() => {
    setPickerRequest((prev) => ({ id: (prev?.id ?? 0) + 1, chartedOnly: true }));
  }, []);

  const closePanel = useCallback(() => {
    setRecoveryNotice(null);
    patchParams({ c: null });
  }, [patchParams]);

  // First visit with no `?c`: land somewhere with a live chart rather than an
  // empty stage. `replace` keeps this out of the history stack. A supplied
  // `?c=` — even a blank one — goes through the recovery effects below instead,
  // so a malformed link is explained rather than silently bootstrapped.
  //
  // The choice is made from static metadata as soon as the stored preference has
  // hydrated, not from the map. Waiting for the caps layer was what serialised
  // the first chart request behind two GeoJSON downloads.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current || !storedHydrated) return;
    bootstrapped.current = true;
    if (rawIso !== null) return;
    const iso = isKnownCountry(storedIso) ? storedIso : (CHART_ISOS.find(isKnownCountry) ?? "US");
    setParams(new URLSearchParams({ c: iso, kind }), { replace: true });
  }, [storedHydrated, storedIso, rawIso, setParams, kind]);

  // A known country written in lower case (or with stray spaces) is still the
  // same selection. Rewrite the address bar to the canonical ISO with replace,
  // so the sloppy spelling does not become a history entry.
  useEffect(() => {
    if (!selectedIso) return;
    if (rawIso === selectedIso) return;
    patchParams({ c: selectedIso }, { replace: true });
  }, [selectedIso, rawIso, patchParams]);

  // A bad `?c=` must not leave a bare globe. Once the map is available, fall
  // back to the last valid country (or the first charted one), stay on the same
  // history entry, and tell the chart why the address changed. A blank `?c=`
  // is a bad link too; no `c` at all is an intentional empty stage.
  useEffect(() => {
    if (mapLoading || countries.length === 0 || selectedIso) return;
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
    selectedIso,
    byIso,
    storedIso,
    patchParams,
  ]);

  const [isPlaying, setIsPlaying] = useState(false);

  // The queue is a snapshot of whatever list the user pressed play in. It
  // survives country and tab changes so audio is never interrupted by navigation.
  const [queue, setQueue] = useState<ChartTrack[]>([]);
  /** Video ids that the player has already refused in this queue. Reset when a
   *  new queue is taken, so a broken track is tried again on a deliberate play. */
  const failedTracksRef = useRef<Set<string>>(new Set());
  /** Set only when every entry in the snapshot has failed. The player then stops
   *  on the current track and explains why instead of walking the queue forever. */
  const [queueError, setQueueError] = useState<string | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  const { data, loading, error, retry } = useChart(selectedIso);
  // A deliberate hover is the cheapest signal that a click is coming. The
  // prefetch lands in the same cache `useChart` reads, so the click is a render
  // rather than a request — and it only ever fires for charted countries, after
  // the pointer has rested on one.
  useChartPrefetch(hovered?.iso ?? null, !globeMoving);

  const playFromChart = useCallback((tracks: ChartTrack[], index: number) => {
    failedTracksRef.current = new Set();
    setQueueError(null);
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

  /**
   * A track the player could not start.
   *
   * Skipping forward is what makes one broken video harmless, but skipping is
   * only safe while there is something untried left: wrapping around a queue
   * whose every entry fails is the infinite `load → error → load` loop this
   * replaces. The failed ids are remembered per queue, so a later error does not
   * restart at the track we already know is broken.
   */
  const handleTrackError = useCallback((videoId: string) => {
    failedTracksRef.current.add(videoId);
    const list = queueRef.current;
    const current = activeIndexRef.current ?? 0;
    for (let offset = 1; offset <= list.length; offset += 1) {
      const next = (current + offset) % list.length;
      if (!failedTracksRef.current.has(list[next].videoId)) {
        setQueueError(null);
        setActiveIndex(next);
        return;
      }
    }
    setQueueError(
      "Every track in this queue was unavailable. Try again, or play a different chart."
    );
  }, []);

  const retryQueue = useCallback(() => {
    failedTracksRef.current = new Set();
    setQueueError(null);
    // The current id did not change, so rebuilding has to be explicit.
    playerHandle.current?.retry();
  }, []);

  /** A track that actually plays clears the queue failure: the banner describes
   *  a queue where nothing worked, and it must not outlive that condition. */
  const handlePlayingChange = useCallback((playing: boolean) => {
    setIsPlaying(playing);
    if (playing) setQueueError(null);
  }, []);

  /** Stable for the panel's memo: the route re-renders on every globe hover, and
   *  an inline handler here would re-render all 20 rows on each pointer move.
   *  The queue snapshots the active tab's list at the moment play was pressed. */
  const playFromChartAt = useCallback(
    (index: number) => {
      const list = data && data.charted ? data[kind] : null;
      const track = list?.[index];
      if (!list || !track) return;
      // The row that is already loaded is a transport toggle, not a new queue.
      // Restarting the video from zero because the user asked to resume would
      // be wrong. Compare video ids, not indexes: the queue is a snapshot from
      // whichever list play was pressed in, so positions do not correspond.
      if (track.videoId === activeVideoId) {
        // While the queue has failed there is nothing to toggle: the player is
        // dead until it is rebuilt, so the active row retries instead of being
        // a "Resume" that silently does nothing.
        if (queueError) retryQueue();
        else playerHandle.current?.toggle();
        return;
      }
      playFromChart(list, index);
    },
    [activeVideoId, data, kind, playFromChart, queueError, retryQueue]
  );

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
  // `sheetReserve` is the resolved height of `--sheet-h` (see app.css and the
  // measurement above). The sheet's CSS size, the rail's lift, this offset and
  // the camera altitude all read that one number; nothing here recomputes it.
  const isWide = viewport.isWide;
  // On a wide layout the panel is a rail and a stale fold state must not turn it
  // into a peek bar after a resize.
  const sheetOpen = !!selectedMeta && (isWide || !sheetFolded);
  const docked = !!selectedMeta || playerActive;
  const railBottom = selectedMeta
    ? // Above the sheet (open) or the peek/player stack (folded). `--sheet-h`
      // already includes the player in both cases.
      "bottom-[calc(var(--sheet-h)+1.25rem)] lg:bottom-gutter"
    : playerActive
      ? // No sheet, but the player is still docked: clear its measured height,
        // the aside's `bottom-3` inset and a little air.
        "bottom-[calc(var(--player-h)+0.75rem+1rem)] lg:bottom-gutter"
      : "bottom-3 lg:bottom-gutter";

  useLayoutEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const read = () => {
      const px = Number.parseFloat(getComputedStyle(el).getPropertyValue("--sheet-h")) || 0;
      setSheetReserve((prev) => (Math.abs(prev - px) < 0.5 ? prev : px));
    };
    read();
    // A viewport change resizes the fixed stage even when no React state changes,
    // and the breakpoint changes the variable without one. The dependencies cover
    // the changes that do not resize the stage (selection, fold, player) — and
    // `playerHeight`, because a measured player changes the folded reserve
    // without changing the stage box the observer watches.
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewport.isWide, selectedIso, sheetFolded, playerActive, playerHeight]);

  /**
   * Measure the player, rather than trusting the `84px` fallback in app.css.
   * Opening the video or showing the autoplay notice makes the card taller, and
   * both `--sheet-h` (folded) and the rail's clearance are derived from it. The
   * observer is what keeps those in step when the card grows after a click.
   */
  useLayoutEffect(() => {
    const el = playerBoxRef.current;
    if (!el) return;
    const read = () => {
      const px = Math.ceil(el.getBoundingClientRect().height);
      setPlayerHeight((prev) => (prev === px ? prev : px));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [playerActive]);

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
    const key = `${selected.iso}@${Math.round(sheetReserve)}@${isWide ? "w" : "n"}`;
    if (focusedKey.current === key) return;
    focusedKey.current = key;
    setFocus({
      lat: selected.lat,
      lng: selected.lng,
      altitude: altitudeForViewport(selected.span, isWide, viewport.w, viewport.h, sheetReserve),
      n: Date.now(),
    });
  }, [selected, viewport.w, viewport.h, isWide, sheetReserve]);

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
   *  with no fold, so `isWide` short-circuits and the state just sits unused.
   *  Returns whether the state actually changed, so a caller only claims focus
   *  when a control is genuinely about to unmount. */
  const setFolded = useCallback(
    (folded: boolean) => {
      if (isWide) return false;
      setSheetFolded(folded);
      return true;
    },
    [isWide]
  );

  /**
   * The chevron and the peek bar each unmount on the state change they ask for,
   * so focus would otherwise fall to `<body>` and a keyboard user would have to
   * tab back to the panel they were just using. This records where focus should
   * go, and the effect below hands it over after the commit that mounts it.
   *
   * Only those two controls set it: a tap on the globe that folds, or a
   * selection that unfolds, leaves focus where the user put it — moving it off
   * the canvas would be a surprise, and neither path needs the affordance.
   */
  const focusAfterFold = useRef<"peek" | "panel" | null>(null);
  const peekRef = useRef<HTMLButtonElement>(null);
  const foldRef = useRef<HTMLButtonElement>(null);

  const foldSheet = useCallback(() => {
    if (setFolded(true)) focusAfterFold.current = "peek";
  }, [setFolded]);

  const unfoldSheet = useCallback(() => {
    if (setFolded(false)) focusAfterFold.current = "panel";
  }, [setFolded]);

  /** A tap that missed on the stage folds the sheet, but is not a keyboard
   *  interaction — no focus handover. */
  const foldFromStage = useCallback(() => {
    setFolded(true);
  }, [setFolded]);

  useEffect(() => {
    const target = focusAfterFold.current;
    if (!target) return;
    focusAfterFold.current = null;
    if (target === "peek") peekRef.current?.focus();
    else foldRef.current?.focus();
  }, [sheetFolded]);

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
    // `--sheet-h` is defined in app.css, so the server-rendered first paint
    // already knows how tall the sheet is. `data-sheet` and `data-player` are the
    // only inputs JS contributes; everything that draws reads the one variable.
    <main
      id="main"
      ref={mainRef}
      className="fixed inset-0 overflow-hidden bg-void text-ink"
      // The measured player height wins over the stylesheet fallback. It is
      // only written once a player exists, so the first paint is unchanged.
      style={
        playerHeight > 0
          ? ({ "--player-h": `${playerHeight}px` } as CSSProperties)
          : undefined
      }
      data-sheet={selectedMeta ? (isWide || !sheetFolded ? "open" : "folded") : undefined}
      data-player={playerActive ? "true" : undefined}
    >
      {/* Globe stage. A named landmark so the canvas is not an anonymous
          full-bleed div in the accessibility tree. */}
      <section aria-label="World globe" className="absolute inset-0 z-0">
        <GlobeView
          countries={countries}
          borders={land?.rings ?? EMPTY_BORDERS}
          landParts={land?.parts ?? EMPTY_PARTS}
          selectedIso={selectedIso}
          hoverIso={hovered?.iso ?? null}
          focus={focus}
          offset={offset}
          reducedMotion={reducedMotion}
          regionFilter={regionFilter}
          palette={palette}
          onHover={setHovered}
          onSelect={select}
          onMotionChange={handleGlobeMotion}
          onEmptyTap={isWide ? undefined : foldFromStage}
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
        pickerRequest={pickerRequest}
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
        className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center px-3 lg:left-gutter lg:px-0 ${
          docked ? "lg:right-[26.5rem]" : "lg:right-gutter"
        } ${railBottom}`}
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
      {selectedMeta || playerActive ? (
        <aside
          className={`fixed right-3 bottom-3 left-3 z-30 flex flex-col gap-2.5 lg:right-gutter lg:bottom-gutter lg:left-auto lg:w-[384px] ${
            selectedMeta
              ? sheetOpen
                ? // Height is the resolved variable, not a copy of `48vh`, so it
                  // matches the reserve exactly — the rail and the globe read the
                  // same number that positions this box, and folding moves them
                  // together. The player is inside this height, not added to it,
                  // so it can never overlap the list.
                  "h-[var(--sheet-h)] lg:h-[calc(100vh-2.5rem)]"
                : "h-auto"
              : ""
          }`}
          aria-label="Chart and player"
        >
          {selectedMeta ? (
            sheetOpen ? (
              <div className="min-h-0 flex-1">
                <ChartPanel
                  iso={selectedMeta.iso}
                  name={selectedMeta.name}
                  region={selectedMeta.region}
                  data={data}
                  loading={loading}
                  error={error}
                  kind={kind}
                  notice={recoveryMessage}
                  activeVideoId={activeVideoId}
                  isPlaying={isPlaying}
                  isPaused={activeVideoId != null && !isPlaying}
                  onTab={changeTab}
                  onPlay={playFromChartAt}
                  onRetry={retry}
                  onFindCharted={findCharted}
                  onClose={closePanel}
                  // Narrow layouts only: wide has a rail, and a collapse chevron
                  // there would promise a fold that does not exist.
                  onFold={isWide ? undefined : foldSheet}
                  foldRef={foldRef}
                />
              </div>
            ) : (
              <div className="shrink-0">
                <ChartPeek
                  iso={selectedMeta.iso}
                  name={selectedMeta.name}
                  region={selectedMeta.region}
                  data={data}
                  loading={loading}
                  kind={kind}
                  onExpand={unfoldSheet}
                  buttonRef={peekRef}
                />
              </div>
            )
          ) : null}
          {playerActive ? (
            <div ref={playerBoxRef} className="shrink-0">
              <NowPlaying
                tracks={queue}
                activeIndex={activeIndex}
                onSelect={setActiveIndex}
                onEnded={playNext}
                onTrackError={handleTrackError}
                queueError={queueError}
                onRetryQueue={retryQueue}
                onPlayingChange={handlePlayingChange}
                handleRef={playerHandle}
              />
            </div>
          ) : null}
        </aside>
      ) : null}

      {/* Screen-reader only: the globe is not navigable, so announce what a
          keyboard user just selected. */}
      <p className="sr-only" aria-live="polite">
        {selectedMeta
          ? `${selectedMeta.name} chart, ${kind === "songs" ? "top songs" : "top videos"}. ${
              loading
                ? "Loading."
                : error
                  ? `Error: ${error}`
                  : data
                    ? data.country === selectedIso
                      ? data.charted
                        ? `${data[kind].length} ${kind}.`
                        : "No official chart."
                      : ""
                    : ""
            }`
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
      {!selectedMeta && globeReady ? (
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
