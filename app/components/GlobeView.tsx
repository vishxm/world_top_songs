import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Object3D,
  Raycaster,
  Vector2,
} from "three";
import { firstUnoccluded, GLOBE_RADIUS, surfaceDistance } from "~/lib/pick";
import type { Region } from "~/lib/countryMeta";
import type { ThemeTokens } from "~/hooks/useTheme";

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
// THE INVARIANT: never return 0. three-globe does not bake altitude into the
// polygon geometry — it builds it at GLOBE_RADIUS and applies altitude as a
// uniform mesh scale of `1 + alt`. So `alt = 0` puts the cap exactly coplanar
// with the globe mesh, which (a) z-fights and (b) makes the raycast numerically
// unstable, so hovering/clicking silently drops a large, random-looking share of
// countries. three-globe's own default is 0.01 for this reason. The value here
// must also stay above the border layer's radius so a cap is always the nearest
// hit and the borders can never steal a hover.
//
// HOVER MUST NOT LIFT. Because altitude is a scale, raising it grows the cap
// outward: a 2% lift adds several pixels of apparent size, so the hovered
// country bleeds over its neighbours and captures the cursor from them. Hover is
// signalled by colour alone; only the selection changes geometry.
// ---------------------------------------------------------------------------
const CAP_BASE = 0.004;
const CAP_SELECTED = 0.03;

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

// The border layer sits just off the globe surface. Above the sphere itself
// (never 0 — that is the coplanarity trap) and below every cap, so it is always
// the farthest hit and can never steal a hover.
const BORDER_ALTITUDE = 0.002;

const IDLE_SPIN_DELAY_MS = 5200;
const IDLE_SPIN_SPEED = 0.28;

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

/** three-globe tags every object it generates; walk up to the nearest tag. */
function globeTypeOf(obj: Object3D | null): string | null {
  let o: (Object3D & { __globeObjType?: string }) | null = obj;
  while (o) {
    if (o.__globeObjType) return o.__globeObjType;
    o = o.parent as (Object3D & { __globeObjType?: string }) | null;
  }
  return null;
}

/** The `StageCountry` three-globe stored on a hit cap, if any. */
function datumOf(obj: Object3D | null): StageCountry | null {
  type Tagged = Object3D & { __data?: { data?: StageCountry } };
  let o = obj as Tagged | null;
  while (o) {
    const datum = o.__data?.data;
    if (datum?.iso) return datum;
    o = o.parent as Tagged | null;
  }
  return null;
}

/**
 * The occlusion rule itself lives in `~/lib/pick` — see there for why the planet
 * has to be the occluder, and for what it cost when three-render-objects owned
 * that decision instead.
 */

interface Props {
  countries: StageCountry[];
  /** Merged MultiLineString rings for the single-draw-call outline layer. */
  borders: [number, number][][];
  selectedIso: string | null;
  hoverIso: string | null;
  focus: { lat: number; lng: number; altitude: number; n: number } | null;
  /** Screen-space nudge so the globe centres in the area the panel leaves free. */
  offset: [number, number];
  reducedMotion: boolean;
  /** When set, caps outside this region fade right down. */
  regionFilter: Region | null;
  /**
   * Resolved canvas palette from the active theme. Passed in rather than read
   * from CSS here: these callbacks run inside three-globe's digest, and a
   * getComputedStyle() per polygon would force a style recalc mid-hover.
   */
  palette: ThemeTokens["globe"];
  onHover: (c: StageCountry | null) => void;
  onSelect: (c: StageCountry) => void;
}

export default function GlobeView({
  countries,
  borders,
  selectedIso,
  hoverIso,
  focus,
  offset,
  reducedMotion,
  regionFilter,
  palette,
  onHover,
  onSelect,
}: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globeRef = useRef<any>(null);
  const [dimensions, setDimensions] = useState({ w: 0, h: 0 });
  const [mounted, setMounted] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);

  // Hover bookkeeping lives in refs so a pointer storm never re-renders the route.
  const lastHoverIso = useRef<string | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Mirrors `selectedIso` so the idle timer can re-check it without being
   *  re-created (and re-armed) on every selection. */
  const selectedIsoRef = useRef<string | null>(selectedIso);
  selectedIsoRef.current = selectedIso;
  /** Mirrors `hoverIso`, written synchronously by the pick loop. */
  const hoverIsoRef = useRef<string | null>(hoverIso);
  /** Raycast plumbing, built once the canvas exists. */
  const picker = useRef<{
    el: HTMLCanvasElement;
    scene: Object3D;
    caps: Object3D[];
    capsScannedAt: number;
    rc: Raycaster;
    ndc: Vector2;
  } | null>(null);
  /** Last pointer position in client coords, or null when it left the canvas. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pickRaf = useRef(0);

  useEffect(() => {
    setMounted(true);
    const update = () => setDimensions({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => {
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

  // Idle spin only ever applies to an *unselected* globe. A selection parks it
  // permanently: the user is reading that country's chart and a rotating globe
  // yanks the country out from under the header readout.
  const scheduleIdleSpin = useCallback(() => {
    if (reducedMotion || selectedIso) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      // Re-check at fire time: a selection may have happened while we waited.
      if (!globeRef.current || selectedIsoRef.current) return;
      setSpinning(true);
    }, IDLE_SPIN_DELAY_MS);
  }, [reducedMotion, selectedIso, setSpinning]);

  // A selection parks the globe, permanently. Dragging still works — only the
  // idle rotation is disabled, since that is the part that fights the panel.
  useEffect(() => {
    if (selectedIso) {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setSpinning(false);
      return;
    }
    if (reducedMotion) return;
    scheduleIdleSpin();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [selectedIso, reducedMotion, setSpinning, scheduleIdleSpin]);

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
    setSpinning(!selectedIso && !reducedMotion);
    setSceneReady(true);
    // Debug hook: lets console probes inspect the three scene (draw calls, mesh
    // counts, manual raycasts). Harmless in prod.
    (window as unknown as { __globe?: unknown }).__globe = globeRef.current;
  }, [selectedIso, reducedMotion, setSpinning, tuneControls]);

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
    if (!sceneReady) return;
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      if (applyHoverVisuals() > 0 || tries > 60) clearInterval(id);
    }, 100);
    return () => clearInterval(id);
  }, [sceneReady, applyHoverVisuals]);

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
  // Owning the raycast lets the planet be the occluder it physically is: a cap
  // counts only if it is in front of the globe's surface (surfaceDistance), and
  // hits come back sorted near→far so the first surviving cap is the answer.
  //
  // Only the caps are raycast. The atmosphere shell, the merged 120k-vertex
  // border layer, the graticules and the star field are all transparent to the
  // pointer by design — including them cost 2ms per pick, versus 0.09ms here.
  const pickAt = useCallback((clientX: number, clientY: number): StageCountry | null => {
    const p = picker.current;
    const g = globeRef.current;
    if (!p || !g) return null;
    const rect = p.el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    // three-globe builds the caps asynchronously and re-digests them whenever
    // the data changes, so the list is refreshed about once a second rather than
    // assumed. A scene traverse is ~0.05ms; a stale list is a dead continent.
    const now = Date.now();
    if (now - p.capsScannedAt > 1000) {
      p.capsScannedAt = now;
      p.caps.length = 0;
      p.scene.traverse((o) => {
        if (globeTypeOf(o) === "polygon") p.caps.push(o);
      });
    }
    if (p.caps.length === 0) return null;

    p.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    p.rc.setFromCamera(p.ndc, g.camera());
    // The rule itself is in ~/lib/pick; this is just the plumbing that feeds it.
    const hit = firstUnoccluded(p.rc.intersectObjects(p.caps, true), surfaceDistance(p.rc.ray));
    if (!hit) return null;
    return datumOf(hit.object);
  }, []);

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
      if (c) scheduleIdleSpin();
      return true;
    },
    [onHover, applyHoverVisuals, scheduleIdleSpin]
  );

  useEffect(() => {
    if (!sceneReady) return;
    const g = globeRef.current;
    const el = g?.renderer?.()?.domElement as HTMLCanvasElement | undefined;
    if (!el) return;
    picker.current = { el, scene: g.scene(), caps: [], capsScannedAt: 0, rc: new Raycaster(), ndc: new Vector2() };

    let downAt: { x: number; y: number } | null = null;
    let dragged = false;

    const onMove = (e: PointerEvent) => {
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) dragged = true;
      pointer.current = { x: e.clientX, y: e.clientY };
      if (dragged) {
        // A drag moves the country out from under the cursor, so any highlight
        // left on screen is already a lie.
        commitHover(null);
        return;
      }
      schedulePick();
    };
    const onDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
      dragged = false;
    };
    const onUp = (e: PointerEvent) => {
      downAt = null;
      if (dragged) {
        dragged = false;
        // The `change` handler below re-picks through the damping glide.
        schedulePick();
        return;
      }
      const c = pickAt(e.clientX, e.clientY);
      if (c) onSelect(c);
    };
    const onLeave = () => {
      pointer.current = null;
      commitHover(null);
    };
    // Any camera movement re-resolves the hover. This is what keeps the readout
    // honest through inertia, zoom, auto-rotation and the flight to a newly
    // selected country — none of which move the pointer, so a pointer-only
    // listener would leave it naming a country that has since slid away.
    const onCameraChange = () => schedulePick();

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onLeave);
    el.addEventListener("pointerleave", onLeave);
    g.controls()?.addEventListener("change", onCameraChange);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onLeave);
      el.removeEventListener("pointerleave", onLeave);
      g.controls()?.removeEventListener("change", onCameraChange);
      picker.current = null;
      if (pickRaf.current) cancelAnimationFrame(pickRaf.current);
    };
  }, [sceneReady, commitHover, pickAt, onSelect]);

  /** Run the pick on the next frame. Idempotent — many callers, one raycast. */
  function schedulePick() {
    if (pickRaf.current) return;
    pickRaf.current = requestAnimationFrame(() => {
      pickRaf.current = 0;
      const p = pointer.current;
      if (!p) return;
      commitHover(pickAt(p.x, p.y));
    });
  }

  const rings = useMemo(() => {
    const sel = countries.find((c) => c.iso === selectedIso);
    return sel ? [{ lat: sel.lat, lng: sel.lng, maxR: 7, speed: 2.4, period: 1700 }] : [];
  }, [countries, selectedIso]);

  if (!mounted) return <Stage />;

  return (
    <Suspense fallback={<Stage />}>
      <Globe
        ref={globeRef}
        width={dimensions.w}
        height={dimensions.h}
        globeOffset={offset}
        globeImageUrl="/textures/earth-night.jpg"
        backgroundImageUrl="/textures/night-sky.png"
        backgroundColor="rgba(0,0,0,0)"
        atmosphereColor={palette.atmosphere}
        atmosphereAltitude={0.16}
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
        // We raycast the scene ourselves (see pickAt) — three-render-objects'
        // filter cannot express "stop at the sphere", which is what keeps it
        // from picking countries on the far side of the planet.
        enablePointerInteraction={false}
        // Detail layer: every 50m border, one object, one draw call.
        customLayerData={borderData}
        customThreeObject={createBorderLayer}
        // Selection pulse.
        ringsData={rings}
        ringColor={() => palette.capHover}
        ringMaxRadius="maxR"
        ringPropagationSpeed="speed"
        ringRepeatPeriod="period"
      />
    </Suspense>
  );
}

/** Pre-hydration / pre-import placeholder that still reads as the stage. */
function Stage() {
  return (
    <div className="absolute inset-0 bg-[var(--color-void)]">
      <div className="absolute inset-0 opacity-70 [background:radial-gradient(60%_50%_at_50%_45%,color-mix(in_oklab,var(--color-accent)_7%,transparent),transparent_70%)]" />
    </div>
  );
}
