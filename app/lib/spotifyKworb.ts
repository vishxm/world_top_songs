// Spotify weekly per-country charts via kworb.net aggregation (keyless HTML).
// Used as the fallback provider for countries YouTube doesn't chart.
// kworb publishes weekly Top ~200 per country: rank, movement, artist, title, streams.

export interface SpotifyEntry {
  rank: number;
  artist: string;
  title: string;
  /** Chart movement vs last week: number, 0 for '=', null when unknown. */
  movement: number | null;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function fetchSpotifyWeekly(countryLower: string): Promise<SpotifyEntry[]> {
  const res = await fetch(`https://kworb.net/spotify/country/${countryLower}_weekly.html`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`kworb http=${res.status}`);
  const html = await res.text();
  const rows = html.match(/<tr>([\s\S]*?)<\/tr>/g) ?? [];
  const entries: SpotifyEntry[] = [];
  for (const row of rows) {
    const rankM = row.match(/<td class="np">(\d+)<\/td>/);
    if (!rankM) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 3) continue;
    const moveRaw = decodeEntities(cells[1].replace(/<[^>]+>/g, "").trim());
    const artistM = cells[2].match(/artist\/[^"]+">([^<]+)</);
    const titleM = cells[2].match(/track\/[^"]+">([^<]+)</);
    if (!artistM || !titleM) continue;
    let movement: number | null = null;
    if (moveRaw === "=") movement = 0;
    else if (/^[+-]\d+$/.test(moveRaw)) movement = parseInt(moveRaw, 10);
    entries.push({
      rank: parseInt(rankM[1], 10),
      artist: decodeEntities(artistM[1]),
      title: decodeEntities(titleM[1]),
      movement,
    });
    if (entries.length >= 15) break;
  }
  if (entries.length === 0) throw new Error("no entries parsed");
  return entries;
}
