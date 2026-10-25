import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BufferGeometry,
  Float32BufferAttribute,
  type Group,
  LineBasicMaterial,
  LineSegments,
  MeshBasicMaterial,
  Object3D,
  type Ray,
  Raycaster,
  Vector2,
} from "three";
import {
  CAP_BASE,
  CAP_SELECTED,
  GLOBE_RADIUS,
  HIT_ALTITUDE,
  PICK_EPSILON,
  nearestUnoccluded,
  surfaceDistance,
} from "~/lib/pick";
import type { Region } from "~/lib/countryMeta";
import type { LandPart } from "~/lib/mapData";
import type { GlobePalette } from "~/hooks/useGlobePalette";

// react-globe.gl touches `window` at import time, so it must never load during
// SSR: lazy() defers the import until the first client render and we only render
// the globe after mount (see `mounted` below).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Globe = lazy(() => import("react-globe.gl")) as any;

export interface StageCountry {
  iso: string;
  name: string;
  region: Region;
  lat: number;
  lng: number;
  span: number;
  /**
   * GeoJSON Polygon/MultiPolygon as loaded from the caps layer. three-globe reads
   * it for the cap mesh (`polygonGeoJsonGeometry="geometry"`), and the selection
   * outline reads it to trace that country's edge. Typed loosely so the map loader
   * stays the single source of truth for the shape.
   */
  geometry?: unknown;
}

// ---------------------------------------------------------------------------
// Altitudes, in three-globe "globe radius" units.
//
// `CAP_BASE`, `CAP_SELECTED`, `HIT_ALTITUDE` and `PICK_EPSILON` live in
// `~/lib/pick`: the geometry gate asserts all of them are > 0, and the picking
// rule and the rendered caps have to agree about the surface they describe.
//
// THE INVARIANT, restated here because breaking it is silent: never 0. A cap at
// altitude 0 is exactly coplanar with the globe mesh, so it z-fights and the
// raycast becomes numerically unreliable, dropping a random-looking share of
// countries from hover. HOVER MUST NOT LIFT either: altitude is a scale, so a
// lift grows the cap over its neighbours and steals the cursor from them. Only
// the selection changes geometry; hover is signalled by colour alone.
// ---------------------------------------------------------------------------

/**
 * The selection outline sits just outside the lifted cap, so the crisp edge
 * always wins over the fill it traces.
 *
 * A fill on its own is a weak signal for a large country and almost none for a
 * small one: measured against unselected land, the old `0.6` amber came out at
 * rgb(156,129,82) — a muddy khaki at 3.5:1, which reads as a wash rather than a
 * selection. Raising the alpha fixes the fill (7.9:1), but only an outline makes
 * a six-pixel country findable at all.
 */
const OUTLINE_ALTITUDE = CAP_SELECTED + 0.0015;

/** How long the camera must be quiet before the globe counts as at rest. A drag
 *  ends with damping still gliding, and the pointer keeps a country under it the
 *  whole way; without this, a drag looked exactly like a deliberate hover about
 *  150ms after the release. */
const MOTION_SETTLE_MS = 180;

// The border layer sits just off the globe surface. Above the sphere itself
// (never 0 — that is the coplanarity trap) and below every cap, so it is always
// the farthest hit and can never steal a hover.
const BORDER_ALTITUDE = 0.002;

// The renderer is sized in device pixels, so the hairline borders stay crisp on
// a retina display. Clamped because a 3x canvas triples the fill cost for no
// visible gain, and three-render-objects makes the same clamp itself.
const MAX_DPR = 2;

/** How long the globe sits still before its idle rotation begins. */
const IDLE_SPIN_DELAY_MS = 5200;
const IDLE_SPIN_SPEED = 0.28;

/** Duration of the screen-space offset tween. Long enough to read as the globe
 *  being re-framed rather than teleported, short enough that the sheet is
 *  already settled when it lands. */
const OFFSET_TWEEN_MS = 420;

/** "rgba(r, g, b, a)" -> [0xrrggbb, alpha]. Null for anything unparseable. */
function parseRgba(colour: string): [number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/.exec(colour.trim());
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number);
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return [(r << 16) | (g << 8) | b, a];
}

/** three-globe's polar2Cartesian, so the border layer lands on the same sphere. */
function toCartesian(lng: number, lat: number, altitude: number, out: [number, number, number]) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  const r = GLOBE_RADIUS * (1 + altitude);
  const s = Math.sin(phi);
  out[0] = r * s * Math.cos(theta);
  out[1] = r * Math.cos(phi);
  out[2] = r * s * Math.sin(theta);
}

type Ring = [number, number][];

/**
 * Every linear ring of a GeoJSON Polygon or MultiPolygon, as [lng, lat] pairs.
 *
 * Holes are included deliberately: the outline traces the country's silhouette,
 * and a hole that was left out would show the fill through the middle of a
 * country with an enclave in it.
 */
function ringsOf(geometry: unknown): Ring[] {
  const g = geometry as { type?: string; coordinates?: unknown } | null | undefined;
  if (!g || typeof g !== "object" || !Array.isArray(g.coordinates)) return [];
  // Polygon: [ring, ring…]. MultiPolygon: [[ring, ring…], …].
  const polys: unknown[] = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
  const rings: Ring[] = [];
  for (const poly of polys) {
    if (!Array.isArray(poly)) continue;
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 2) continue;
      const out: Ring = [];
      for (const point of ring) {
        if (Array.isArray(point) && point.length >= 2 && typeof point[0] === "number") {
          out.push([point[0], point[1]]);
        }
      }
      if (out.length >= 2) rings.push(out);
    }
  }
  return rings;
}

/**
 * A press that travels less than this is a click, not a drag.
 *
 * 4px — the old threshold — is below the tremor of a real tap: a mouse held on a
 * six-pixel country drifts a pixel or two, and a finger on a phone drifts far
 * more, so those presses were classified as drags and selected nothing. Ten is
 * still small enough that a deliberate spin always crosses it within a frame or
 * two of movement.
 */
const CLICK_SLOP_PX = 10;

/**
 * A press held longer than this is not a click, even if it never moved.
 *
 * A country can be tapped and released in well under a third of a second; a
 * press that sits on the globe for the better part of a second is the user
 * holding the camera still, not choosing the country under the cursor.
 */
const CLICK_MAX_MS = 700;

/**
 * The occlusion rule itself lives in `~/lib/pick` — see there for why the planet
 * has to be the occluder, and for what it cost when three-render-objects owned
 * that decision instead.
 */

interface Props {
  countries: StageCountry[];
  /** Merged MultiLineString rings for the single-draw-call outline layer. */
  borders: [number, number][][];
  /**
   * Every land part, grouped by ISO — the source of the full-land hit layer.
   *
   * This is deliberately *not* derived from `countries[].geometry`: that geometry
   * is the pruned cap layer, and the parts it drops (Hawaii, the Canaries, Jeju,
   * the Galapagos) are exactly the ones this issue exists to make clickable.
   */
  landParts: readonly LandPart[];
  selectedIso: string | null;
  hoverIso: string | null;
  focus: { lat: number; lng: number; altitude: number; n: number } | null;
  /** Screen-space nudge so the globe centres in the area the panel leaves free. */
  offset: [number, number];
  reducedMotion: boolean;
  /** When set, caps outside this region fade right down. */
  regionFilter: Region | null;
  /**
   * Resolved canvas palette. Passed in rather than read from CSS here: these
   * callbacks run inside three-globe's digest, and a getComputedStyle() per
   * polygon would force a style recalc mid-hover.
   */
  palette: GlobePalette;
  onHover: (c: StageCountry | null) => void;
  onSelect: (c: StageCountry) => void;
  /** Called with `true` while the camera is moving and `false` once it has been
   *  still for a moment. Hover prefetch is suppressed in between: a drag glides
   *  under the pointer long after the button is released. */
  onMotionChange?: (moving: boolean) => void;
  /**
   * The scene is rendered, the caps have been built and picking is live. The
   * route uses this to hand its loading state over to the globe; it fires once.
   */
  onInteractive?: () => void;
  /**
   * A tap that landed on the globe but hit no country — ocean, sky, or the space
   * around the planet. On narrow layouts the route uses this to fold the chart
   * sheet away, so the globe can be seen without deselecting the country.
   *
   * Fires on `pointerup` only when the press was not a drag, so spinning the globe
   * never folds anything. Undefined on wide layouts, where there is no sheet.
   */
  onEmptyTap?: () => void;
}

export default function GlobeView({
  countries,
  borders,
  landParts,
  selectedIso,
  hoverIso,
  focus,
  offset,
  reducedMotion,
  regionFilter,
  palette,
  onHover,
  onSelect,
  onMotionChange,
  onEmptyTap,
  onInteractive,
}: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globeRef = useRef<any>(null);
  /** The stage box itself, measured — never the window, so an inset stage or a
   *  resize of the surrounding layout is reflected in the canvas. */
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [dimensions, setDimensions] = useState({ w: 0, h: 0, dpr: 1 });
  const [mounted, setMounted] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  /** three-globe has actually built the country caps, so hover repaints land. */
  const [capsPainted, setCapsPainted] = useState(false);
  /** The full-land hit layer exists, so a ray can resolve a country. */
  const [hitReady, setHitReady] = useState(false);
  /**
   * The scene exists, the caps are painted *and* the hit layer is built. That is
   * the honest readiness point: the renderer, the visuals and the picking
   * surface all agree. The route hands its loading state over here, and a tap
   * before this is queued rather than dropped on a half-built scene.
   */
  const interactive = capsPainted && hitReady;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

  // Hover bookkeeping lives in refs so a pointer storm never re-renders the route.
  const lastHoverIso = useRef<string | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Set by the first real interaction. Idle rotation is a one-time invitation:
   *  once the user has taken the globe, it never starts itself again. */
  const interacted = useRef(false);
  /** Mirrors `selectedIso` so the idle timer can re-check it without being
   *  re-created (and re-armed) on every selection. */
  const selectedIsoRef = useRef<string | null>(selectedIso);
  selectedIsoRef.current = selectedIso;
  /** Mirrors `hoverIso`, written synchronously by the pick loop. */
  const hoverIsoRef = useRef<string | null>(hoverIso);
  /** Mirrors `onEmptyTap` so the pointer listeners — registered once, when the
   *  scene becomes ready — never have to be torn down and rebuilt because the
   *  route handed down a new closure. */
  const onEmptyTapRef = useRef(onEmptyTap);
  onEmptyTapRef.current = onEmptyTap;
  /** Mirrors `onMotionChange` for the same reason: the controls listener is
   *  registered once per scene, not per render. */
  const onMotionChangeRef = useRef(onMotionChange);
  onMotionChangeRef.current = onMotionChange;
  /** Raycast plumbing, created once on mount — before the scene exists, because
   *  a tap during startup still has to be queued rather than ignored. */
  const picker = useRef<{
    /** The stage box, not the canvas: an early tap has no canvas to measure. */
    el: HTMLDivElement;
    rc: Raycaster;
    ndc: Vector2;
  } | null>(null);
  /** Last pointer position in client coords, or null when it left the stage. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pickRaf = useRef(0);
  /** The press currently in flight, if any. Lives outside the listener effect so
   *  a re-render cannot lose a gesture halfway through. */
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    at: number;
    moved: boolean;
    /** The world-space ray under the press, captured before the camera can move. */
    ray: Ray | null;
  } | null>(null);
  /**
   * The latest tap that arrived before the scene could answer it.
   *
   * Stored as a *world-space ray* when the camera existed at tap time, so it
   * describes the surface the user actually saw rather than whatever the camera
   * has flown to by the time the hit layer finishes. Before the camera exists
   * there is nothing to convert, so the NDC is kept and resolved against the
   * camera that eventually appears.
   */
  const queuedTap = useRef<{ ray: Ray | null; ndc: Vector2 | null } | null>(null);

  /** ISO → country, so a hit mesh resolves without walking the scene graph. */
  const countriesByIso = useMemo(() => {
    const map = new Map<string, StageCountry>();
    for (const c of countries) map.set(c.iso, c);
    return map;
  }, [countries]);
  const countriesByIsoRef = useRef(countriesByIso);
  countriesByIsoRef.current = countriesByIso;

  /** The merged full-land meshes. Never added to the scene — see hitLayer.ts. */
  const hitRef = useRef<Group | null>(null);
  const hitApi = useRef<typeof import("~/lib/hitLayer") | null>(null);

  /**
   * Measure the stage box and never the window.
   *
   * The stage is `inset-0` today, so the two agree — but the canvas must follow
   * the box it actually occupies, or a future inset/rail/resize changes the
   * layout while the renderer keeps its old size and the globe jumps. The
   * ResizeObserver catches layout changes as well as viewport ones; the window
   * `resize` listener is still needed because browser zoom changes
   * `devicePixelRatio` without necessarily changing the CSS box, and a window
   * moved between displays does the same.
   */
  useEffect(() => {
    setMounted(true);
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      setDimensions((d) => (d.w === w && d.h === h && d.dpr === dpr ? d : { w, h, dpr }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  // -------------------------------------------------------------- idle spin
  const setSpinning = useCallback((on: boolean) => {
    try {
      const controls = globeRef.current?.controls?.();
      if (!controls) return;
      controls.autoRotate = on;
      controls.autoRotateSpeed = IDLE_SPIN_SPEED;
    } catch {
      /* controls not ready */
    }
  }, []);

  const stopIdleSpin = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = undefined;
    setSpinning(false);
  }, [setSpinning]);

  /**
   * The first real interaction hands the globe to the user. Idle rotation is an
   * invitation, not a behaviour that resumes behind their back: once they have
   * dragged, zoomed or moved over the stage, it stays parked for the session.
   * Before this, hover re-armed the idle timer, so the globe could start turning
   * while the pointer rested on a country the user was reading.
   */
  const takeOver = useCallback(() => {
    if (interacted.current) return;
    interacted.current = true;
    stopIdleSpin();
  }, [stopIdleSpin]);

  // Idle spin only ever applies to an *unselected* globe. A selection parks it
  // permanently: the user is reading that country's chart, and a rotating globe
  // would yank the country out from under the header readout.
  const scheduleIdleSpin = useCallback(() => {
    if (reducedMotion || selectedIsoRef.current || interacted.current) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      // Re-check at fire time: a selection or interaction may have happened
      // while we waited.
      if (!globeRef.current || selectedIsoRef.current || interacted.current) return;
      setSpinning(true);
    }, IDLE_SPIN_DELAY_MS);
  }, [reducedMotion, setSpinning]);

  useEffect(() => {
    if (!sceneReady) return;
    if (selectedIso || reducedMotion || interacted.current) {
      stopIdleSpin();
      return;
    }
    scheduleIdleSpin();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [sceneReady, selectedIso, reducedMotion, scheduleIdleSpin, stopIdleSpin]);

  // Device-pixel-ratio changes (browser zoom, moving between displays) do not
  // resize the CSS box, so ResizeObserver never sees them. Re-assert the pixel
  // ratio here; three's `setPixelRatio` re-runs `setSize` with the current size.
  useEffect(() => {
    if (!sceneReady) return;
    try {
      globeRef.current?.renderer?.()?.setPixelRatio(dimensions.dpr);
    } catch {
      /* renderer not ready */
    }
  }, [sceneReady, dimensions.dpr]);

  // ------------------------------------------------------------------ camera
  const tuneControls = useCallback(() => {
    try {
      const controls = globeRef.current?.controls?.();
      if (!controls) return;
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.35;
      controls.zoomSpeed = 0.4;
      controls.zoomToCursor = false;
      controls.minDistance = 145; // never dive under the surface
      controls.maxDistance = 620; // never get lost in space
    } catch {
      /* controls not ready */
    }
  }, []);

  const handleReady = useCallback(() => {
    tuneControls();
    setSceneReady(true);
    // Debug hook: lets console probes inspect the three scene (draw calls, mesh
    // counts, manual raycasts). Harmless in prod.
    (window as unknown as { __globe?: unknown }).__globe = globeRef.current;
  }, [tuneControls]);

  /**
   * The sphere itself: a matte, unlit surface.
   *
   * `MeshBasicMaterial` is deliberately unaffected by the scene's ambient and
   * directional lights — no specular, no terminator, no atmosphere shell, no
   * night-lights texture and no starfield behind it. One flat tone is the whole
   * globe; the caps and the hairline border layer carry every signal.
   */
  const sphereMaterial = useMemo(
    () => new MeshBasicMaterial({ color: palette.sphere }),
    [palette.sphere]
  );
  useEffect(() => () => sphereMaterial.dispose(), [sphereMaterial]);

  /**
   * Fly the camera to the focused country.
   *
   * Gated on `sceneReady` as well as `focus`, because the two arrive in either
   * order: the Globe is lazy and its texture is async, so on a deep link
   * (`?c=IN`) the route commits the focus *before* three-globe exists. Firing
   * only on `focus` silently dropped the flight and left the camera at 0,0 —
   * the country you linked to was off-screen with the panel describing it.
   */
  const appliedFocusN = useRef(0);
  useEffect(() => {
    if (!sceneReady || !focus || !globeRef.current) return;
    if (appliedFocusN.current === focus.n) return;
    appliedFocusN.current = focus.n;
    globeRef.current.pointOfView(
      { lat: focus.lat, lng: focus.lng, altitude: focus.altitude },
      reducedMotion ? 0 : 1150
    );
  }, [focus, sceneReady, reducedMotion]);

  /**
   * Screen-space offset, EASED rather than applied.
   *
   * `globeOffset` is a prop, so three-globe re-applies it on the frame it changes
   * — a sheet that collapses is a ~200px jump in one frame, and the globe tears
   * across the screen instead of settling into the space it just gained. The
   * altitude half of the same move is already tweened by `pointOfView`; this
   * makes the offset half match it.
   *
   * Driven imperatively on `camera.setViewOffset` rather than through the prop,
   * because the prop carries a single frame's value and there is no way to hand it
   * a tween. `easeOutCubic` matches `pointOfView`'s feel.
   *
   * One other writer exists: three-render-objects applies the `globeOffset`
   * default (`[0, 0]`) once while the scene initialises, which calls
   * `clearViewOffset` on the camera. That lands around — sometimes just after —
   * `onGlobeReady`, so `sceneReady` alone loses the race and leaves the globe
   * centred under the panel. `interactive` is the last startup handshake, so the
   * offset is re-asserted there too.
   */
  const offsetShown = useRef<[number, number]>(offset);
  const offsetRaf = useRef(0);
  /** Whether the camera has been written to at all yet. */
  const offsetPrimed = useRef(false);
  useEffect(() => {
    const camera = globeRef.current?.camera?.();
    if (!camera) return;

    const w = Math.max(1, dimensions.w);
    const h = Math.max(1, dimensions.h);
    const write = ([x, y]: [number, number]) => {
      if (x === 0 && y === 0) camera.clearViewOffset();
      else camera.setViewOffset(w, h, -x, -y, w, h);
    };

    const from = offsetShown.current;
    const to = offset;
    const moved = from[0] !== to[0] || from[1] !== to[1];
    if (offsetRaf.current) cancelAnimationFrame(offsetRaf.current);

    // The first write is not a move — the camera simply has never been offset, so
    // there is nothing to travel from. Tweening out of an un-offset start slides
    // the globe across the screen on every load, and skipping the write entirely
    // leaves it centred under the panel. Reduced motion takes the same path, and
    // so does an unchanged offset on a resize, which still needs re-writing
    // against the new canvas size.
    if (reducedMotion || !offsetPrimed.current || !moved) {
      offsetPrimed.current = true;
      offsetShown.current = to;
      write(to);
      return;
    }

    const started = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - started) / OFFSET_TWEEN_MS);
      const e = 1 - Math.pow(1 - k, 3);
      const next: [number, number] = [
        from[0] + (to[0] - from[0]) * e,
        from[1] + (to[1] - from[1]) * e,
      ];
      offsetShown.current = next;
      write(next);
      if (k < 1) offsetRaf.current = requestAnimationFrame(step);
    };
    offsetRaf.current = requestAnimationFrame(step);

    return () => {
      if (offsetRaf.current) cancelAnimationFrame(offsetRaf.current);
    };
  }, [offset, sceneReady, interactive, reducedMotion, dimensions]);

  // ------------------------------------------------------------ border layer
  // One LineSegments for every border in the map: a single draw call, full
  // 50m fidelity, and always the *farthest* hit so it can never steal a hover
  // from a lifted cap.
  const borderData = useMemo(() => [{ lines: borders }], [borders]);
  const createBorderLayer = useCallback(
    (datum: { lines: [number, number][][] }) => {
      const positions: number[] = [];
      const v: [number, number, number] = [0, 0, 0];
      for (const line of datum.lines) {
        for (let i = 0; i + 1 < line.length; i++) {
          toCartesian(line[i][0], line[i][1], BORDER_ALTITUDE, v);
          positions.push(v[0], v[1], v[2]);
          toCartesian(line[i + 1][0], line[i + 1][1], BORDER_ALTITUDE, v);
          positions.push(v[0], v[1], v[2]);
        }
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
      return new LineSegments(
        geometry,
        new LineBasicMaterial({
          color: palette.border,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
        })
      );
    },
    [palette.border]
  );

  // ------------------------------------------------------- selection outline
  // A crisp traced edge around the selected country, rebuilt only when the
  // selection changes — so it costs one draw call and nothing per hover.
  //
  // It is imperative rather than a `polygonStrokeColor` accessor on purpose.
  // three-globe does build a LineSegments per polygon, but with the strokes
  // disabled it comes out `visible: false` with a zero-vertex geometry, and
  // turning strokes on would mean changing a polygon prop's identity — which
  // re-digests all 266 caps (see AGENTS.md) and adds a draw call per country.
  // One merged line for the one selected country is cheaper and sharper.
  //
  // It is never raycast: `pickAt` only ever tests `picker.caps`, which is
  // collected by looking for three-globe's `polygon` tag, and this object has
  // none. So the outline cannot steal a hover from the cap it traces.
  const outlineRef = useRef<LineSegments | null>(null);
  useEffect(() => {
    const g = globeRef.current;
    const scene = g?.scene?.() as Object3D | undefined;
    if (!scene) return;

    const dispose = () => {
      const previous = outlineRef.current;
      if (!previous) return;
      scene.remove(previous);
      previous.geometry.dispose();
      (previous.material as LineBasicMaterial).dispose();
      outlineRef.current = null;
    };

    const country = selectedIso ? countries.find((c) => c.iso === selectedIso) : null;
    const rings = country ? ringsOf(country.geometry) : [];
    if (rings.length === 0) {
      dispose();
      return;
    }

    const positions: number[] = [];
    const v: [number, number, number] = [0, 0, 0];
    for (const ring of rings) {
      // GeoJSON rings repeat their first point last; `i + 1 < length` already
      // closes them, so the duplicate is simply not emitted twice.
      for (let i = 0; i + 1 < ring.length; i++) {
        toCartesian(ring[i][0], ring[i][1], OUTLINE_ALTITUDE, v);
        positions.push(v[0], v[1], v[2]);
        toCartesian(ring[i + 1][0], ring[i + 1][1], OUTLINE_ALTITUDE, v);
        positions.push(v[0], v[1], v[2]);
      }
    }
    if (positions.length === 0) {
      dispose();
      return;
    }

    // Replace only once the replacement is built, so a country with unusable
    // geometry leaves the previous outline alone rather than blanking it.
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    const outline = new LineSegments(
      geometry,
      new LineBasicMaterial({
        color: palette.capOutline,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      })
    );
    dispose();
    scene.add(outline);
    outlineRef.current = outline;
  }, [sceneReady, selectedIso, countries, palette.capOutline]);

  useEffect(() => {
    return () => {
      const previous = outlineRef.current;
      if (!previous) return;
      previous.parent?.remove(previous);
      previous.geometry.dispose();
      (previous.material as LineBasicMaterial).dispose();
      outlineRef.current = null;
    };
  }, []);

  // ------------------------------------------------------------- cap styling
  // CRITICAL: these accessors must be referentially stable for the lifetime of
  // the scene. three-globe re-digests (and rebuilds the geometry of) every
  // polygon whenever a polygon prop's function identity changes. Keying them off
  // `hoverIso` therefore rebuilt all ~270 caps on every pointer move, and caps
  // were still mid-rescale when the next raycast fired — which shows up as
  // hovering picking the wrong country. Hover styling is applied imperatively
  // instead (see applyHoverVisuals); these only read the initial state.
  // Read the *current* values through refs, but keep the accessors' identity
  // stable forever. These run during three-globe's digest, so a fresh closure per
  // hover would rebuild every polygon's geometry on every pointer move.
  const selectedForDigest = useRef(selectedIso);
  selectedForDigest.current = selectedIso;
  const regionForDigest = useRef(regionFilter);
  regionForDigest.current = regionFilter;

  const getAltitude = useCallback(
    (d: unknown) => ((d as StageCountry).iso === selectedForDigest.current ? CAP_SELECTED : CAP_BASE),
    []
  );

  const getCapColor = useCallback(
    (d: unknown) => {
      const c = d as StageCountry;
      const region = regionForDigest.current;
      if (region && c.region !== region) return palette.capDim;
      return palette.cap;
    },
    [palette]
  );

  /**
   * Apply hover/selection visuals straight to the three objects three-globe
   * built — a few property writes instead of a 270-geometry rebuild.
   *
   * This is deliberately NOT a React effect. An effect runs a frame or two after
   * the hover state changes, so the cap under the pointer is briefly styled for
   * wherever the pointer *was*. Calling it synchronously with the hover update
   * keeps geometry and pick in step.
   *
   * Reaches the caps through the scene rather than a three-globe method:
   * `globeGroup()` is not part of the public API, so calling it silently no-ops
   * and no highlight ever appears.
   */
  const applyHoverVisuals = useCallback((): number => {
    const scene = globeRef.current?.scene?.();
    if (!scene) return 0;
    const selected = selectedIsoRef.current;
    const hovered = hoverIsoRef.current;
    let styled = 0;
    scene.traverse((obj: unknown) => {
      const g = obj as {
        __globeObjType?: string;
        __data?: { data?: { iso?: string; region?: Region } };
        children?: { scale?: { setScalar: (n: number) => void }; material?: unknown }[];
      };
      if (g.__globeObjType !== "polygon") return;
      const datum = g.__data?.data;
      const iso = datum?.iso;
      if (typeof iso !== "string") return;
      styled++;

      const isSelected = iso === selected;
      const isHovered = iso === hovered;
      // The lift marks the selection and is independent of the region filter, so
      // a selected country outside the current region stays findable.
      const lift = isSelected ? CAP_SELECTED : CAP_BASE;
      const scale = 1 + lift;

      // children[0] is the cap Mesh, children[1] the (hidden) stroke.
      const cap = g.children?.[0];
      cap?.scale?.setScalar(scale);
      const stroke = g.children?.[1];
      if (stroke?.scale) stroke.scale.setScalar(scale + 1e-4);

      // Cap material is index 1; index 0 is the side wall. three-globe makes a
      // fresh material per polygon, so writing it here is safe and avoids
      // re-digesting every polygon just to change one colour.
      //
      // The region filter is applied HERE as well as in `getCapColor`, and that
      // duplication is the point: `getCapColor` only runs inside a re-digest, and
      // changing the region alters no polygon prop's identity, so it never fires
      // — the rail dimmed nothing, and the caps quietly painted themselves back
      // to full strength on the next hover.
      //
      // Precedence is selection, then hover, then the filter. The selection
      // outranking hover keeps the one country you are reading visibly amber
      // instead of turning pale under your own cursor; the lift above covers the
      // "is this still selected?" question either way.
      const inRegion = !regionFilter || datum?.region === regionFilter;
      const mat = cap?.material;
      if (Array.isArray(mat)) {
        const m = mat[1] as
          | { color?: { setHex: (h: number) => void }; opacity: number; transparent: boolean }
          | undefined;
        if (m?.color) {
          const rgba = parseRgba(
            isSelected
              ? palette.capSelected
              : isHovered
                ? palette.capHover
                : inRegion
                  ? palette.cap
                  : palette.capDim
          );
          if (rgba) {
            m.color.setHex(rgba[0]);
            m.opacity = rgba[1];
            m.transparent = rgba[1] < 1;
          }
        }
      }
    });
    return styled;
  }, [palette, regionFilter]);

  /**
   * Repaint whenever the *selection* or the *region filter* changes.
   *
   * Hover is deliberately absent: it is applied synchronously inside the pointer
   * handler, so the cap under the cursor is already correct before the next pick
   * reads geometry. Listing it here too would only duplicate the work.
   *
   * `selectedIso` has to be a dependency. Hover only ever repaints when the
   * pointer happens to be over the globe, so selecting from the ⌘K palette, the
   * region rail, Surprise me or the back button left the *previous* country lit
   * up and the new one unlit — the highlight only corrected itself when the
   * pointer next moved.
   */
  useEffect(() => {
    applyHoverVisuals();
  }, [applyHoverVisuals, selectedIso]);

  /**
   * Keep repainting until the caps actually exist.
   *
   * three-globe builds 266 polygon objects ASYNCHRONOUSLY, well after
   * `onGlobeReady`. A repaint that runs before that finds no polygons and quietly
   * does nothing — and the old 400ms retry was a guess at how long that takes, so
   * on a deep link like `?c=BR` the selected country stayed at the base colour
   * indefinitely (measured: still unlit at 10s) and only lit up when the pointer
   * happened to cross a country. Waiting for the caps themselves removes the guess;
   * a scene traverse is ~0.05ms, and it stops as soon as there is work to do.
   */
  useEffect(() => {
    if (!sceneReady || countries.length === 0) {
      setCapsPainted(false);
      return;
    }
    let tries = 0;
    let id: ReturnType<typeof setInterval> | null = null;
    const paint = () => {
      tries += 1;
      if (applyHoverVisuals() > 0) {
        setCapsPainted(true);
        if (id) clearInterval(id);
      } else if (tries > 60) {
        if (id) clearInterval(id);
      }
    };
    id = setInterval(paint, 100);
    paint();
    return () => {
      if (id) clearInterval(id);
    };
  }, [sceneReady, countries, applyHoverVisuals]);

  /**
   * Hand the scene over exactly once.
   *
   * `interactive` is the honest point of readiness: the renderer exists, the
   * country caps have actually been built, *and* the full-land hit layer is
   * ready, so a raycast can resolve any drawn part of a country. The route keeps
   * its loading copy up until this fires. A tap before it is queued by the
   * stage's pointer handlers and replayed here, never silently dropped.
   */
  const reportedInteractive = useRef(false);
  useEffect(() => {
    if (!interactive || reportedInteractive.current) return;
    reportedInteractive.current = true;
    onInteractive?.();
  }, [interactive, onInteractive]);

  // -------------------------------------------------------------- hit layer
  /**
   * Build the full-land picking surface as soon as the land data arrives.
   *
   * The import is dynamic because three-conic-polygon-geometry reads
   * `window.THREE` at module scope: a static import would run during SSR and
   * crash the server render before the globe ever mounts.
   *
   * Building is synchronous once the module is in — ~1650 parts is a few hundred
   * milliseconds — which is exactly why it happens behind the loading state and
   * why `interactive` waits for it. It is the only thing that makes pruned
   * islands reachable, so it must not be skipped.
   */
  useEffect(() => {
    if (!sceneReady || landParts.length === 0) return;
    let cancelled = false;
    let layer: Group | null = null;
    setHitReady(false);

    const build = async () => {
      const api = await import("~/lib/hitLayer");
      if (cancelled) return;
      hitApi.current = api;
      layer = api.buildHitLayer(landParts, { radius: GLOBE_RADIUS, altitude: HIT_ALTITUDE });
      if (cancelled) return;
      if (layer.children.length === 0) {
        console.error("country hit layer is empty — nothing would be clickable");
      }
      // Mirror `sizeOfHit` onto the meshes so a debug/gate raycast can apply the
      // same enclave tie-break without reaching into React state.
      for (const mesh of layer.children) {
        const iso = mesh.userData.iso;
        mesh.userData.span = countriesByIsoRef.current.get(iso)?.span ?? Infinity;
      }
      hitRef.current = layer;
      // Debug hook, mirroring `__globe`. The browser gate raycasts these meshes
      // as its oracle: a hit on the full-land layer is the only way to tell
      // "ocean" from "a part the cap layer pruned", and it is what the gate must
      // agree with.
      (window as unknown as { __globeHit?: unknown }).__globeHit = layer;
      setHitReady(true);
    };

    void build().catch((error: unknown) => {
      if (cancelled) return;
      // A failed chunk (or a tessellator that rejects every part) must not leave
      // the loading state up forever. Log loudly and hand the scene over: the
      // globe still renders, it just cannot resolve a country.
      console.error("country hit layer failed to build", error);
      setHitReady(true);
    });

    return () => {
      cancelled = true;
      if (!layer) return;
      hitApi.current?.disposeHitLayer(layer);
      if (hitRef.current === layer) {
        hitRef.current = null;
        (window as unknown as { __globeHit?: unknown }).__globeHit = null;
      }
    };
  }, [sceneReady, landParts]);

  // Borders own the outline; three-globe's per-country strokes would cost a draw
  // call each and duplicate what the merged layer already draws crisply.
  const noStroke = useCallback(() => null, []);
  const noSide = useCallback(() => null, []);
  const getLabel = useCallback(() => "", []);

  // ------------------------------------------------------------------ events
  // WE OWN THE PICK. three-render-objects' `hoverFilter` is handed the hit
  // *object* but never the hit *distance*, and its `find()` then returns the
  // first hit that passes. Because the sphere is always nearer than the lifted
  // caps, the only way to reach a country is to reject the sphere — and once it
  // is rejected the scan keeps going and returns a cap on the FAR side of the
  // planet. That is not a theoretical concern: it reported Tanzania for pixels
  // over Brazil and Bolivia over Brazil, with no highlight drawn at all.
  //
  // We raycast the full-land hit layer, never the caps. The caps are pruned for
  // the draw-call budget, so Hawaii, the Canaries, the Azores, Jeju and the
  // Galapagos have no cap at all and were unreachable; the hit layer has one mesh
  // per country covering every polygon part (see app/lib/hitLayer.ts). That makes
  // "every drawn part is clickable" hold by construction.
  //
  // Owning the raycast lets the planet be the occluder it physically is: a hit
  // counts only if it is in front of the globe's surface (surfaceDistance), and
  // hits come back sorted near→far. That is what keeps a ray from resolving a
  // country on the hidden hemisphere.
  //
  // Only the hit meshes are raycast. The merged 120k-vertex border layer and the
  // globe's own sphere are transparent to the pointer by design — including them
  // cost 2ms per pick, versus 0.09ms here.
  const sizeOfHit = useCallback((hit: { object: Object3D }): number => {
    const iso = hit.object.userData.iso;
    if (typeof iso !== "string") return Infinity;
    return countriesByIsoRef.current.get(iso)?.span ?? Infinity;
  }, []);

  /** Resolve an already-built world-space ray against the hit layer. */
  const pickRay = useCallback(
    (ray: Ray): StageCountry | null => {
      const p = picker.current;
      const layer = hitRef.current;
      if (!p || !layer) return null;
      p.rc.ray.copy(ray);
      const hits = p.rc.intersectObjects(layer.children, false);
      // The rule itself is in ~/lib/pick; this is only the plumbing that feeds
      // it. `PICK_EPSILON` makes an enclave win over its host deterministically
      // when both are equally near, instead of leaving it to triangle order.
      const hit = nearestUnoccluded(hits, surfaceDistance(p.rc.ray), PICK_EPSILON, sizeOfHit);
      if (!hit) return null;
      const iso = hit.object.userData.iso;
      return typeof iso === "string" ? (countriesByIsoRef.current.get(iso) ?? null) : null;
    },
    [sizeOfHit]
  );

  /** Build the world-space ray under a client point, without picking.
   *
   * A press captures this ray so the fallback target cannot drift with the
   * camera: a 9px shaky click still nudges OrbitControls by ~half a degree, and
   * re-picking the down *pixel* after that nudge can miss the small country the
   * user actually pressed. */
  const rayAt = useCallback((clientX: number, clientY: number): Ray | null => {
    const p = picker.current;
    const camera = globeRef.current?.camera?.();
    if (!p || !camera) return null;
    const rect = p.el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    p.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    p.rc.setFromCamera(p.ndc, camera);
    return p.rc.ray.clone();
  }, []);

  const pickAt = useCallback(
    (clientX: number, clientY: number): StageCountry | null => {
      const ray = rayAt(clientX, clientY);
      return ray ? pickRay(ray) : null;
    },
    [pickRay, rayAt]
  );

  /** Push the picked country into React + the cap materials, coalesced to a
   *  frame. Returns true when the hover actually changed. */
  const commitHover = useCallback(
    (c: StageCountry | null) => {
      const iso = c?.iso ?? null;
      if (iso === lastHoverIso.current) return false;
      lastHoverIso.current = iso;
      // Styling happens in the SAME frame as the hover change, so the cap under
      // the pointer is already correct before the next raycast reads geometry.
      hoverIsoRef.current = iso;
      applyHoverVisuals();
      if (picker.current) picker.current.el.style.cursor = c ? "pointer" : "";
      onHover(c);
      return true;
    },
    [onHover, applyHoverVisuals]
  );

  // The listener effect registers once, so every handler reaches the current
  // closure through a ref. Without this a new `onSelect` (or a palette change)
  // would tear down and rebuild the listeners mid-gesture.
  const pickAtRef = useRef(pickAt);
  pickAtRef.current = pickAt;
  const rayAtRef = useRef(rayAt);
  rayAtRef.current = rayAt;
  const pickRayRef = useRef(pickRay);
  pickRayRef.current = pickRay;
  const commitHoverRef = useRef(commitHover);
  commitHoverRef.current = commitHover;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  /** Run the pick on the next frame. Idempotent — many callers, one raycast. */
  const schedulePick = useCallback(() => {
    if (pickRaf.current) return;
    pickRaf.current = requestAnimationFrame(() => {
      pickRaf.current = 0;
      const p = pointer.current;
      if (!p) return;
      commitHoverRef.current(pickAtRef.current(p.x, p.y));
    });
  }, []);

  /**
   * Keep a tap that arrived before the scene could answer it.
   *
   * The old handler attached to the canvas and the wrapper was
   * `pointer-events-none` until `interactive`, so an early tap was not merely
   * unanswered — it was never seen, and the click appeared to do nothing. The ray
   * is computed now when the camera exists, so it describes the globe the user
   * was actually looking at rather than wherever the camera has flown by replay.
   */
  const queueTap = useCallback((clientX: number, clientY: number) => {
    const p = picker.current;
    if (!p) return;
    const rect = p.el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const camera = globeRef.current?.camera?.();
    if (camera) {
      p.rc.setFromCamera(ndc, camera);
      queuedTap.current = { ray: p.rc.ray.clone(), ndc: null };
    } else {
      queuedTap.current = { ray: null, ndc };
    }
  }, []);

  // The stage owns the gesture from mount — before the canvas exists — so input
  // during startup reaches us instead of falling through a pointer-events hole.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    picker.current = { el: stage, rc: new Raycaster(), ndc: new Vector2() };

    const onPointerDown = (e: PointerEvent) => {
      // Right/middle mouse buttons are OrbitControls' pan/zoom, not a selection.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      takeOver();
      gesture.current = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        at: performance.now(),
        moved: false,
        ray: rayAtRef.current(e.clientX, e.clientY),
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      takeOver();
      const g = gesture.current;
      if (g && g.pointerId === e.pointerId && !g.moved) {
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > CLICK_SLOP_PX) g.moved = true;
      }
      pointer.current = { x: e.clientX, y: e.clientY };
      if (g?.moved) {
        // A drag moves the country out from under the cursor, so any highlight
        // left on screen is already a lie.
        commitHoverRef.current(null);
        return;
      }
      schedulePick();
    };

    const onPointerUp = (e: PointerEvent) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g || g.pointerId !== e.pointerId) {
        schedulePick();
        return;
      }
      const elapsed = performance.now() - g.at;
      if (g.moved || elapsed > CLICK_MAX_MS) {
        // A real drag (or a long press that was about the camera). The controls'
        // `change` handler re-picks through the damping glide.
        schedulePick();
        return;
      }

      if (!interactiveRef.current) {
        // No hit layer yet. Keep the tap until the scene can answer it.
        queueTap(e.clientX, e.clientY);
        return;
      }

      // A shaky click can lift off a pixel outside a small country. The ray
      // captured at the press is the one the user aimed at — re-picking the down
      // *pixel* would use the camera after a small orbit nudge and could miss.
      let picked = pickAtRef.current(e.clientX, e.clientY);
      if (!picked && (Math.abs(g.x - e.clientX) > 0.5 || Math.abs(g.y - e.clientY) > 0.5)) {
        picked = g.ray ? pickRayRef.current(g.ray) : pickAtRef.current(g.x, g.y);
      }
      if (picked) onSelectRef.current(picked);
      // A tap that hit water or sky. Nothing was selected, so the pointer handler
      // has nothing else to do with it — which makes it the natural place to let
      // the route fold the sheet away. Only reached on a genuine tap, since the
      // drag case returned above.
      else onEmptyTapRef.current?.();
    };

    const onPointerLeave = () => {
      pointer.current = null;
      gesture.current = null;
      commitHoverRef.current(null);
    };

    const onPointerCancel = () => {
      pointer.current = null;
      gesture.current = null;
      commitHoverRef.current(null);
    };

    // A press that ends outside the stage never reaches `pointerup` here. Release
    // the gesture so it cannot be mistaken for the next one, but do not select:
    // the release position is outside the globe's box.
    const onWindowUp = (e: PointerEvent) => {
      if (gesture.current?.pointerId === e.pointerId) gesture.current = null;
    };

    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointerleave", onPointerLeave);
    stage.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowUp);
    return () => {
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointerleave", onPointerLeave);
      stage.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowUp);
      picker.current = null;
      gesture.current = null;
      if (pickRaf.current) cancelAnimationFrame(pickRaf.current);
    };
  }, [queueTap, schedulePick, takeOver]);

  /**
   * Any camera movement re-resolves the hover.
   *
   * Inertia, zoom, auto-rotation and the flight to a newly selected country never
   * move the pointer, so a pointer-only listener would leave the header naming a
   * country that has since slid away.
   */
  useEffect(() => {
    if (!sceneReady) return;
    const controls = globeRef.current?.controls?.();
    if (!controls) return;
    // `start` covers a drag and a wheel zoom — both end the idle rotation. Idle
    // rotation keeps emitting `change` as well, but it stops the moment the
    // pointer takes over, so a resting hover never coexists with a spinning globe.
    let moving = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const reportMotion = () => {
      if (!moving) {
        moving = true;
        onMotionChangeRef.current?.(true);
      }
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = undefined;
        if (!moving) return;
        moving = false;
        onMotionChangeRef.current?.(false);
      }, MOTION_SETTLE_MS);
    };
    const onStart = () => {
      takeOver();
      reportMotion();
    };
    const onChange = () => {
      schedulePick();
      reportMotion();
    };
    controls.addEventListener("start", onStart);
    controls.addEventListener("change", onChange);
    return () => {
      controls.removeEventListener("start", onStart);
      controls.removeEventListener("change", onChange);
      if (settle) clearTimeout(settle);
      if (moving) onMotionChangeRef.current?.(false);
    };
  }, [sceneReady, schedulePick, takeOver]);

  /** three-render-objects sizes the canvas in CSS pixels; `display: block`
   *  removes the inline-baseline strip that would show the stage beneath it. */
  useEffect(() => {
    if (!sceneReady) return;
    const canvas = globeRef.current?.renderer?.()?.domElement as HTMLCanvasElement | undefined;
    if (canvas) canvas.style.display = "block";
  }, [sceneReady]);

  /**
   * Replay the latest startup tap exactly once, when the scene can answer it.
   *
   * A tap on a country selects it; a tap that genuinely missed folds the sheet,
   * same as it would have at the time. The queued gesture is the user's input,
   * not a discarded one.
   */
  useEffect(() => {
    if (!interactive) return;
    const queued = queuedTap.current;
    if (!queued) return;
    queuedTap.current = null;
    const p = picker.current;
    const camera = globeRef.current?.camera?.();
    if (!p) return;
    let picked: StageCountry | null = null;
    if (queued.ray) picked = pickRay(queued.ray);
    else if (queued.ndc && camera) {
      p.rc.setFromCamera(queued.ndc, camera);
      picked = pickRay(p.rc.ray);
    }
    if (picked) onSelectRef.current(picked);
    else onEmptyTapRef.current?.();
  }, [interactive, pickRay]);

  return (
    <div ref={stageRef} className="absolute inset-0 overflow-hidden">
      {/* The stage, not the canvas, owns pointer input — so a tap that lands
          before the canvas even exists is still seen and queued. The route's
          loading copy stays up until the matching `onInteractive`. */}
      {mounted && dimensions.w > 0 ? (
        <div className="absolute inset-0">
          <Suspense fallback={null}>
            <Globe
              ref={globeRef}
              width={dimensions.w}
              height={dimensions.h}
              // Matte and unlit: a flat sphere with no texture, no atmosphere
              // shell, no starfield behind it and no decorative rings.
              globeMaterial={sphereMaterial}
              showAtmosphere={false}
              backgroundColor="rgba(0,0,0,0)"
              onGlobeReady={handleReady}
              // Interaction layer: pruned caps, no side walls, no per-country strokes.
              polygonsData={countries}
              polygonGeoJsonGeometry="geometry"
              polygonAltitude={getAltitude}
              polygonCapColor={getCapColor}
              polygonSideColor={noSide}
              polygonStrokeColor={noStroke}
              polygonLabel={getLabel}
              polygonsTransitionDuration={reducedMotion ? 0 : 200}
              // We raycast the full-land hit layer ourselves (see pickRay) —
              // three-render-objects' filter cannot express "stop at the sphere",
              // which is what keeps it from picking countries on the far side.
              enablePointerInteraction={false}
              // Detail layer: every 50m border, one object, one draw call.
              customLayerData={borderData}
              customThreeObject={createBorderLayer}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
