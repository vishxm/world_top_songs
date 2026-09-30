import { COUNTRY_META, type Region } from "~/lib/countryMeta";

// The two layers the globe draws, built by scripts/build-map-layers.mjs and
// gated by scripts/map-layers-check.mjs:
//
//   caps     - one fill + hit target per country, pruned to the parts that carry
//              its visual mass (~266 objects total)
//   borders  - every 50m border ring merged into a single MultiLineString, drawn
//              as one LineSegments, so the outline stays full-fidelity while the
//              interaction layer stays cheap
export const CAPS_URL = "/country-caps.geojson";
export const BORDERS_URL = "/country-borders.geojson";

export interface CountryCap {
  iso: string;
  name: string;
  region: Region;
  lat: number;
  lng: number;
  /** Bounding-box diagonal in degrees — a cheap size proxy used to decide how
   *  far the camera should fly in. */
  span: number;
  /** Coerced to a GeoJSON geometry for three-globe. */
  geometry: unknown;
}

export type BorderGeometry = [number, number][][];

interface RawFeature {
  properties?: { ISO_A2?: string; NAME?: string; CONTINENT?: string };
  geometry?: { type?: string; coordinates?: unknown };
}

async function fetchGeoJson(url: string, signal?: AbortSignal): Promise<{ features?: RawFeature[] }> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} http=${res.status}`);
  return res.json() as Promise<{ features?: RawFeature[] }>;
}

/** Bounding-box centre + diagonal of a geometry. Good enough to fly the camera
 *  to, and far cheaper than a true centroid over ~200k-vertex shapes. */
function boxOf(geometry: unknown): { lat: number; lng: number; span: number } {
  let minLng = 180;
  let maxLng = -180;
  let minLat = 90;
  let maxLat = -90;
  const visit = (coords: unknown): void => {
    if (Array.isArray(coords) && typeof coords[0] === "number") {
      const [lng, lat] = coords as [number, number];
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    if (Array.isArray(coords)) for (const c of coords) visit(c);
  };
  visit((geometry as { coordinates?: unknown })?.coordinates ?? []);
  if (minLng > maxLng) return { lat: 20, lng: 0, span: 4 };
  return {
    lat: (minLat + maxLat) / 2,
    lng: (minLng + maxLng) / 2,
    span: Math.min(180, Math.hypot(maxLng - minLng, maxLat - minLat)),
  };
}

/**
 * Pick the point to fly the camera to.
 *
 * A bounding-box centre is wrong for anything that straddles the antimeridian or
 * has an overseas territory: the bbox of the United States spans the whole
 * Pacific, which centres the camera on empty ocean. So fall back to the centroid
 * of the *largest* ring, and shift it if it lands outside the country's own bbox.
 */
function anchorOf(geometry: unknown): { lat: number; lng: number; span: number } {
  const box = boxOf(geometry);
  const rings = largestRings(geometry);
  if (rings.length === 0) return box;

  let sumLat = 0;
  let sumLng = 0;
  let n = 0;
  for (const [lng, lat] of rings) {
    sumLat += lat;
    sumLng += lng;
    n++;
  }
  if (n === 0) return box;

  let lat = sumLat / n;
  let lng = sumLng / n;
  // Circular mean in longitude, so a ring straddling ±180 does not average to 0.
  const sin = rings.reduce((a, [l]) => a + Math.sin((l * Math.PI) / 180), 0) / n;
  const cos = rings.reduce((a, [l]) => a + Math.cos((l * Math.PI) / 180), 0) / n;
  if (Math.abs(sin) > 1e-9 || Math.abs(cos) > 1e-9) lng = (Math.atan2(sin, cos) * 180) / Math.PI;

  const bbox = boxOf(geometry);
  const inside =
    lat >= bbox.lat - bbox.span && lat <= bbox.lat + bbox.span && Math.abs(lng - bbox.lng) <= bbox.span;
  return { lat: inside ? lat : box.lat, lng: inside ? lng : box.lng, span: box.span };
}

/** Vertices of the largest outer ring only — holes and islets would drag the
 *  centroid off the mainland. */
function largestRings(geometry: unknown): [number, number][] {
  const parts =
    (geometry as { type?: string; coordinates?: unknown })?.type === "Polygon"
      ? [((geometry as { coordinates: unknown[] }).coordinates as unknown[])[0]]
      : ((geometry as { coordinates?: unknown[] }).coordinates ?? []).map((p) => (p as unknown[])[0]);
  let best: [number, number][] | null = null;
  let bestLen = -1;
  for (const ring of parts) {
    if (!Array.isArray(ring)) continue;
    if (ring.length > bestLen) {
      bestLen = ring.length;
      best = ring as [number, number][];
    }
  }
  return best ?? [];
}

export function capsFromGeoJson(geo: { features?: RawFeature[] }): CountryCap[] {
  const out: CountryCap[] = [];
  for (const f of geo.features ?? []) {
    const iso = f.properties?.ISO_A2;
    if (!iso || !/^[A-Z]{2}$/.test(iso) || !f.geometry) continue;
    if (out.some((c) => c.iso === iso)) continue; // one cap per ISO, first wins
    const meta = COUNTRY_META[iso];
    const { lat, lng, span } = anchorOf(f.geometry);
    out.push({
      iso,
      name: meta?.name ?? f.properties?.NAME ?? iso,
      region: meta?.region ?? "Polar & Remote",
      lat,
      lng,
      span,
      geometry: f.geometry,
    });
  }
  return out;
}



export async function loadCountryCaps(signal?: AbortSignal): Promise<CountryCap[]> {
  return capsFromGeoJson(await fetchGeoJson(CAPS_URL, signal));
}

/** [[lng, lat], ...][] — straight from the merged MultiLineString. */
export async function loadBorderGeometry(signal?: AbortSignal): Promise<BorderGeometry> {
  const geo = await fetchGeoJson(BORDERS_URL, signal);
  const f = geo.features?.[0];
  const coords = (f?.geometry as { type?: string; coordinates?: unknown } | undefined)?.coordinates;
  if (f?.geometry?.type !== "MultiLineString" || !Array.isArray(coords)) {
    throw new Error("border layer is not a MultiLineString");
  }
  return coords as BorderGeometry;
}
