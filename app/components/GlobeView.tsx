import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments } from "three";
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
}

// ---------------------------------------------------------------------------
// Altitudes, in three-globe "globe radius" units.
//
// THE INVARIANT: never return 0. three-globe does not bake altitude into the
// polygon geometry — it builds it at GLOBE_RADIUS and applies altitude as a
// uniform mesh scale of `1 + alt`. So `alt = 0` puts the cap exactly coplanar
// with the globe mesh, which (a) z-fights and (b) makes the raycast numerically
// unstable, so hovering/clicking silently drops a large, random-looking share of
// countries. three-globe's own default is 0.01 for this reason. The lowest value
// here (CAP_BASE) must stay above the border layer's radius too, so a cap is
// always the nearest hit and the borders can never steal a hover.
// ---------------------------------------------------------------------------
const CAP_BASE = 0.004;
const CAP_HOVER = 0.02;
const CAP_SELECTED = 0.034;

// The border layer sits just off the globe surface. Below every cap, above 0.
const BORDER_ALTITUDE = 0.0012;

const GLOBE_RADIUS = 100;
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

  // Hover bookkeeping lives in refs so a pointer storm never re-renders the route.
  const lastHoverIso = useRef<string | null>(null);
  const pendingHover = useRef<StageCountry | null>(null);
  const hoverRaf = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setMounted(true);
    const update = () => setDimensions({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      if (hoverRaf.current) cancelAnimationFrame(hoverRaf.current);
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

  const scheduleIdleSpin = useCallback(() => {
    if (reducedMotion) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      // Never resume under a selection — the user is reading a chart.
      if (!globeRef.current) return;
      setSpinning(true);
    }, IDLE_SPIN_DELAY_MS);
  }, [reducedMotion, setSpinning]);

  // A selection parks the globe; hovering any more keeps it parked.
  useEffect(() => {
    setSpinning(!selectedIso && !reducedMotion);
    if (!selectedIso) scheduleIdleSpin();
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
    // Debug hook: lets console probes inspect the three scene (draw calls, mesh
    // counts, manual raycasts). Harmless in prod.
    (window as unknown as { __globe?: unknown }).__globe = globeRef.current;
  }, [selectedIso, reducedMotion, setSpinning, tuneControls]);

  useEffect(() => {
    if (focus && globeRef.current) {
      globeRef.current.pointOfView(
        { lat: focus.lat, lng: focus.lng, altitude: focus.altitude },
        reducedMotion ? 0 : 1150
      );
    }
  }, [focus, reducedMotion]);

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
          opacity: 0.55,
          depthWrite: false,
        })
      );
    },
    [palette.border]
  );

  // ------------------------------------------------------------- cap styling
  // CRITICAL: these accessors must be referentially stable for the lifetime of
  // the scene. three-globe re-digests (and rebuilds the geometry of) every
  // polygon whenever a polygon prop's function identity changes. Keying them off
  // `hoverIso` therefore rebuilt all ~270 caps on every pointer move, and caps
  // were still mid-rescale when the next raycast fired — which shows up as
  // hovering picking the wrong country. Hover styling is applied imperatively
  // instead (see applyHoverVisuals); these only read the initial state.
  const initialSelected = useRef(selectedIso);
  const initialRegion = useRef(regionFilter);

  const getAltitude = useCallback(
    (d: unknown) => ((d as StageCountry).iso === initialSelected.current ? CAP_SELECTED : CAP_BASE),
    []
  );

  const getCapColor = useCallback(
    (d: unknown) => {
      const c = d as StageCountry;
      if (c.iso === initialSelected.current) return palette.capSelected;
      if (initialRegion.current && c.region !== initialRegion.current) return palette.capDim;
      return palette.cap;
    },
    [palette]
  );

  /**
   * Apply hover/selection visuals straight to the three objects three-globe
   * built. This is a few property writes instead of a 270-geometry rebuild, so
   * hover stays cheap and the raycast always sees final geometry.
   *
   * three-globe applies altitude as `scale = 1 + alt`, so the lift is just a
   * uniform scale on the cap mesh.
   */
  const applyHoverVisuals = useCallback(() => {
    const group = globeRef.current?.globeGroup?.();
    if (!group) return;
    for (const obj of group.children) {
      const iso = obj.__data?.data?.iso;
      if (typeof iso !== "string") continue;
      const lift = iso === selectedIso ? CAP_SELECTED : iso === hoverIso ? CAP_HOVER : CAP_BASE;
      const scale = 1 + lift;
      const cap = obj.children[0];
      if (cap) cap.scale.setScalar(scale);
      const stroke = obj.children[1];
      // three-globe keeps strokes a hair above the cap; we draw borders in the
      // merged layer, so the stroke mesh stays hidden but keeps its offset.
      if (stroke && stroke.visible) stroke.scale.setScalar(scale + 1e-4);
      const mat = cap?.material;
      if (Array.isArray(mat)) {
        const m = mat[1];
        if (m && m.__hoverTarget !== (iso === selectedIso || iso === hoverIso)) {
          m.__hoverTarget = iso === selectedIso || iso === hoverIso;
          const colour = iso === selectedIso ? palette.capSelected : iso === hoverIso ? palette.capHover : palette.cap;
          const rgba = parseRgba(colour);
          if (rgba) {
            m.color.setHex(rgba[0]);
            m.opacity = rgba[1];
            m.transparent = rgba[1] < 1;
          }
        }
      }
    }
  }, [selectedIso, hoverIso, palette]);

  useEffect(() => {
    applyHoverVisuals();
  }, [applyHoverVisuals]);

  // Borders own the outline; three-globe's per-country strokes would cost a draw
  // call each and duplicate what the merged layer already draws crisply.
  const noStroke = useCallback(() => null, []);
  const noSide = useCallback(() => null, []);
  const getLabel = useCallback(() => "", []);

  /**
   * Which objects may win a hover.
   *
   * three-globe's default picks the *nearest* raycast hit, but the globe sphere
   * sits at radius 100 while the caps are lifted to 100.x — so the sphere is
   * always nearer and `find()` never reaches the country sitting on it. Reject
   * `globe` here and the cap (or, over ocean, nothing) wins instead. The border
   * layer is rejected for the same reason: it is a single merged LineSegments
   * that must never steal a hover from a cap.
   */
  const pointerEventsFilter = useCallback(
    (o: unknown) => {
      const type = (o as { __globeObjType?: string } | null)?.__globeObjType;
      return type !== "globe" && type !== "custom";
    },
    []
  );

  // ------------------------------------------------------------------ events
  const handleHover = useCallback(
    (d: unknown) => {
      // Coalesce to one React update per frame, always forwarding the LATEST
      // datum, so sweeping within one country costs nothing and stopping over a
      // country can never leave a stale neighbour on screen.
      pendingHover.current = (d as StageCountry | null) ?? null;
      if (hoverRaf.current) return;
      hoverRaf.current = requestAnimationFrame(() => {
        hoverRaf.current = 0;
        const c = pendingHover.current;
        const iso = c?.iso ?? null;
        if (iso === lastHoverIso.current) return;
        lastHoverIso.current = iso;
        document.body.style.cursor = c ? "pointer" : "";
        onHover(c);
        if (c) scheduleIdleSpin();
      });
    },
    [onHover, scheduleIdleSpin]
  );

  const handleClick = useCallback(
    (d: unknown) => {
      const c = d as StageCountry;
      if (!c?.iso) return;
      onSelect(c);
    },
    [onSelect]
  );

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
        onPolygonHover={handleHover}
        onPolygonClick={handleClick}
        pointerEventsFilter={pointerEventsFilter}
        lineHoverPrecision={0.06}
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
