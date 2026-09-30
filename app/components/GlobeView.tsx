import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";

// react-globe.gl touches `window` at import time, so it must never load
// during SSR: lazy() defers the import until first client render, and we
// only render after mount (see `mounted` below).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Globe = lazy(() => import("react-globe.gl")) as any;

export interface CountryFeature {
  iso: string;
  name: string;
  lat: number;
  lng: number;
  geometry: unknown;
}

interface Props {
  features: CountryFeature[];
  selectedIso: string | null;
  hoverIso: string | null;
  focus: { lat: number; lng: number } | null;
  offset: [number, number];
  onHover: (c: CountryFeature | null) => void;
  onSelect: (c: CountryFeature) => void;
}

// Natural Earth uses "-99" for France and Norway; map them back.
const GEO_ISO_FIX: Record<string, string> = {
  France: "FR",
  Norway: "NO",
};

export function featureToCountry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  f: any
): CountryFeature | null {
  const props = f.properties ?? {};
  let iso: string | undefined =
    typeof props.ISO_A2 === "string" && /^[A-Z]{2}$/.test(props.ISO_A2)
      ? props.ISO_A2
      : undefined;
  const name: string = props.NAME ?? props.name ?? "Unknown";
  if (!iso) {
    iso = GEO_ISO_FIX[name];
    if (!iso) return null; // e.g. Somaliland, N. Cyprus, Kosovo: not selectable
  }
  const { lat, lng } = centroid(f.geometry);
  return { iso, name, lat, lng, geometry: f.geometry };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function centroid(geometry: any): { lat: number; lng: number } {
  let minLng = 180,
    maxLng = -180,
    minLat = 90,
    maxLat = -90;
  const visit = (coords: unknown) => {
    if (typeof (coords as number[])[0] === "number") {
      const [lng, lat] = coords as [number, number];
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    (coords as unknown[]).forEach(visit);
  };
  visit(geometry?.coordinates ?? []);
  if (minLng > maxLng) return { lat: 20, lng: 0 };
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
}

// Built by scripts/simplify-map.mjs from public/world-50m.geojson (Natural
// Earth 50m + Survey-of-India Kashmir claim). Gated by scripts/map-check.mjs.
export const GEOJSON_URL = "/world-50m-simple.geojson";

// Lift (in globe-radius units) so the selected country floats above its
// neighbours: no z-fighting on shared borders, and the pick target is
// unambiguous even exactly on a seam.
const SELECT_ALTITUDE = 0.012;
const HOVER_ALTITUDE = 0.006;

export default function GlobeView({ features, selectedIso, hoverIso, focus, offset, onHover, onSelect }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globeRef = useRef<any>(null);
  const [dimensions, setDimensions] = useState({ w: 0, h: 0 });
  const [mounted, setMounted] = useState(false);
  // Last hovered iso, tracked in a ref so pointer storms never touch React
  // state: onHover fires at most once per iso change (plus once for null).
  const lastHoverIso = useRef<string | null>(null);
  const pendingHover = useRef<CountryFeature | null>(null);
  const hoverRaf = useRef(0);

  useEffect(() => {
    setMounted(true);
    const update = () => setDimensions({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      if (hoverRaf.current) cancelAnimationFrame(hoverRaf.current);
    };
  }, []);

  useEffect(() => {
    if (focus && globeRef.current) {
      globeRef.current.pointOfView({ lat: focus.lat, lng: focus.lng, altitude: 1.6 }, 1200);
    }
  }, [focus]);

  const rings = useMemo(() => {
    const sel = features.find((f) => f.iso === selectedIso);
    return sel ? [{ lat: sel.lat, lng: sel.lng, maxR: 6, propagationSpeed: 2, repeatPeriod: 1600 }] : [];
  }, [features, selectedIso]);

  // react-globe.gl v2 exposes rotation + zoom via OrbitControls, not props.
  const tuneControls = useCallback((spin: boolean) => {
    try {
      const controls = globeRef.current?.controls?.();
      if (controls) {
        controls.autoRotate = spin;
        controls.autoRotateSpeed = 0.5;
        controls.minDistance = 130; // don't dive inside the globe
        controls.maxDistance = 700; // don't get lost in space
        controls.enableDamping = true;
      }
    } catch {
      /* ignore */
    }
  }, []);

  const handleReady = useCallback(() => {
    tuneControls(!selectedIso);
    // Debug hook: lets console probes inspect the three scene (mesh count,
    // manual raycasts). Harmless in prod.
    (window as unknown as { __globe?: unknown }).__globe = globeRef.current;
  }, [selectedIso, tuneControls]);

  // Stop spinning while a country is selected; resume when closed.
  useEffect(() => {
    tuneControls(!selectedIso);
  }, [selectedIso, tuneControls]);

  // Stable accessors: without these, every parent re-render hands
  // three-globe brand-new function props and it re-processes all polygons.
  const getAltitude = useCallback(
    (d: unknown) => {
      const iso = (d as CountryFeature).iso;
      if (iso === selectedIso) return SELECT_ALTITUDE;
      if (iso === hoverIso) return HOVER_ALTITUDE;
      return 0;
    },
    [selectedIso, hoverIso]
  );
  const getCapColor = useCallback(
    (d: unknown) => {
      const iso = (d as CountryFeature).iso;
      if (iso === selectedIso) return "rgba(59,130,246,0.9)";
      if (iso === hoverIso) return "rgba(96,165,250,0.7)";
      return "rgba(30,58,138,0.35)";
    },
    [selectedIso, hoverIso]
  );
  const getStrokeColor = useCallback(
    (d: unknown) => ((d as CountryFeature).iso === selectedIso ? "#bfdbfe" : "rgba(147,197,253,0.55)"),
    [selectedIso]
  );
  const getLabel = useCallback((d: unknown) => `${(d as CountryFeature).name}`, []);
  const getSideColor = useCallback(() => "rgba(2,6,23,0.9)", []);

  const handleHover = useCallback(
    (d: unknown) => {
      // Coalesce to one React update per frame, always forwarding the LATEST
      // datum — sweeping within one country then costs nothing, and stopping
      // over a country can never leave a stale neighbour displayed.
      pendingHover.current = (d as CountryFeature | null) ?? null;
      if (hoverRaf.current) return;
      hoverRaf.current = requestAnimationFrame(() => {
        hoverRaf.current = 0;
        const c = pendingHover.current;
        const iso = c?.iso ?? null;
        if (iso === lastHoverIso.current) return;
        lastHoverIso.current = iso;
        document.body.style.cursor = c ? "pointer" : "";
        onHover(c);
      });
    },
    [onHover]
  );

  const handleClick = useCallback(
    (d: unknown) => {
      const c = d as CountryFeature;
      if (globeRef.current) {
        globeRef.current.pointOfView({ lat: c.lat, lng: c.lng, altitude: 1.6 }, 1200);
      }
      onSelect(c);
    },
    [onSelect]
  );

  if (!mounted) return <div className="absolute inset-0 bg-black" />;

  return (
    <Suspense fallback={<div className="absolute inset-0 bg-black" />}>
      <Globe
        ref={globeRef}
        width={dimensions.w}
        height={dimensions.h}
        globeOffset={offset}
        globeImageUrl="/textures/earth-night.jpg"
        backgroundImageUrl="/textures/night-sky.png"
        backgroundColor="rgba(0,0,0,0)"
        atmosphereColor="#60a5fa"
        atmosphereAltitude={0.22}
        onGlobeReady={handleReady}
        polygonsData={features}
        polygonGeoJsonGeometry="geometry"
        polygonLabel={getLabel}
        polygonAltitude={getAltitude}
        polygonCapColor={getCapColor}
        polygonSideColor={getSideColor}
        polygonStrokeColor={getStrokeColor}
        onPolygonHover={handleHover}
        onPolygonClick={handleClick}
        polygonsTransitionDuration={0}
        ringsData={rings}
        ringColor={() => "rgba(147,197,253,0.7)"}
        ringMaxRadius="maxR"
        ringPropagationSpeed="propagationSpeed"
        ringRepeatPeriod="repeatPeriod"
      />
    </Suspense>
  );
}
