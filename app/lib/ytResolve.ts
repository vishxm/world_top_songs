// Resolve "Artist – Title" to a playable YouTube videoId via keyless
// YouTube Music search. Never returns a guess below threshold —
// callers must skip unresolved tracks rather than play wrong songs.

export interface ResolvedTrack {
  videoId: string;
  title: string;
  artists: string;
  thumbnail: string;
  confidence: number;
}

const SEARCH_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Minimum score to accept a match. Tuned high: wrong songs are worse than gaps. */
const THRESHOLD = 0.55;

// Long-lived cache: track->video mappings are stable for months.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const cache = new Map<string, { track: ResolvedTrack; at: number }>();

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return norm(s).split(" ").filter((t) => t.length > 1);
}

function f1(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const hit = a.filter((t) => setB.has(t)).length;
  if (!hit) return 0;
  const p = hit / b.length;
  const r = hit / a.length;
  return (2 * p * r) / (p + r);
}

interface Candidate {
  videoId: string;
  title: string;
  byline: string;
  kind: string;
  thumbnail: string;
}

function getPath(root: unknown, ...keys: string[]): unknown {
  let node: unknown = root;
  for (const k of keys) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[k];
  }
  return node;
}

function runsText(runs: unknown): string {
  if (!Array.isArray(runs)) return "";
  return runs.map((r) => (r as { text?: string }).text ?? "").join("");
}

async function searchCandidates(artist: string, title: string): Promise<Candidate[]> {
  const res = await fetch(
    `https://music.youtube.com/youtubei/v1/search?key=${SEARCH_KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, Origin: "https://music.youtube.com" },
      body: JSON.stringify({
        query: `${title} ${artist}`,
        context: {
          client: { clientName: "WEB_REMIX", clientVersion: "1.20240901.00", gl: "US", hl: "en" },
        },
      }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(`ytm search http=${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  const sections = (getPath(
    doc, "contents", "tabbedSearchResultsRenderer", "tabs", "0",
    "tabRenderer", "content", "sectionListRenderer", "contents"
  ) ?? []) as Array<Record<string, Record<string, Array<Record<string, unknown>>>>>;
  const out: Candidate[] = [];
  for (const s of sections) {
    const key = Object.keys(s)[0];
    const items = s[key]?.contents ?? [];
    for (const it of items.slice(0, 10)) {
      const r = getPath(it, "musicResponsiveListItemRenderer") as Record<string, unknown> | undefined;
      if (!r) continue;
      const videoId = getPath(
        r, "overlay", "musicItemThumbnailOverlayRenderer", "content",
        "musicPlayButtonRenderer", "playNavigationEndpoint", "watchEndpoint", "videoId"
      ) as string | undefined;
      if (!videoId) continue;
      const flex = (getPath(r, "flexColumns") ?? []) as Array<Record<string, unknown>>;
      const t = runsText(getPath(flex[0], "musicResponsiveListItemFlexColumnRenderer", "text", "runs"));
      const byline = runsText(getPath(flex[1], "musicResponsiveListItemFlexColumnRenderer", "text", "runs"));
      const thumbs = (getPath(r, "thumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails") ?? []) as Array<{
        url?: string;
      }>;
      out.push({
        videoId,
        title: t,
        byline,
        kind: byline.split("•")[0]?.trim().toLowerCase() ?? "",
        thumbnail:
          thumbs.length > 0 && thumbs[thumbs.length - 1].url
            ? (thumbs[thumbs.length - 1].url as string)
            : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function score(
  wantTitle: string[],
  wantArtist: string[],
  c: Candidate
): number {
  // Only playable track-like results: songs, videos, singles. Skip albums/artists/playlists.
  if (!/^(song|video|single)/.test(c.kind)) return 0;
  const titleScore = f1(wantTitle, tokens(c.title));
  if (titleScore < 0.4) return 0;
  const bylineTokens = tokens(c.byline);
  const artistScore = f1(wantArtist, bylineTokens);
  let s = titleScore * 0.6 + artistScore * 0.4;
  // Official videos from the artist's channel usually carry "VEVO" or an
  // exact artist-name lead in the byline.
  if (/vevo|official/i.test(c.byline)) s += 0.05;
  return Math.min(s, 1);
}

export async function resolveToYouTube(artist: string, title: string): Promise<ResolvedTrack | null> {
  const key = `${norm(artist)} - ${norm(title)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.track;

  const wantTitle = tokens(title);
  const wantArtist = tokens(artist);
  const cands = await searchCandidates(artist, title);
  let best: Candidate | null = null;
  let bestScore = 0;
  for (const c of cands) {
    const s = score(wantTitle, wantArtist, c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (!best || bestScore < THRESHOLD) return null;
  const track: ResolvedTrack = {
    videoId: best.videoId,
    title: best.title,
    artists: best.byline.split("•").slice(1).join("•").trim() || artist,
    thumbnail: best.thumbnail,
    confidence: bestScore,
  };
  cache.set(key, { track, at: Date.now() });
  return track;
}

/** Resolve several entries with bounded concurrency. Returns nulls for misses. */
export async function resolveMany(
  entries: Array<{ artist: string; title: string }>,
  concurrency = 3
): Promise<Array<ResolvedTrack | null>> {
  const out: Array<ResolvedTrack | null> = new Array(entries.length).fill(null);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (i < entries.length) {
      const idx = i++;
      try {
        out[idx] = await resolveToYouTube(entries[idx].artist, entries[idx].title);
      } catch {
        out[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
