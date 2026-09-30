import { GEOJSON_URL, featureToCountry, type CountryFeature } from "~/components/GlobeView";

/** Shared country-polygon loader for globe views (local corrected boundaries). */
export async function loadCountryFeatures(): Promise<CountryFeature[]> {
  const res = await fetch(GEOJSON_URL);
  if (!res.ok) throw new Error(`geo http=${res.status}`);
  const geo = (await res.json()) as { features?: unknown[] };
  const list = (geo.features ?? [])
    .map((f) => featureToCountry(f))
    .filter((c): c is CountryFeature => c != null);
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.iso) ? false : (seen.add(c.iso), true)));
}
