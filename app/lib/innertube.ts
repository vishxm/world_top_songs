// Server-side YouTube Music charts fetcher (keyless Innertube).
// Uses the same technique as ytmusicapi: POST to music.youtube.com/youtubei/v1/browse
// with the public WEB_REMIX client key. No Google Cloud project, no billing, no user key.

export interface Track {
  rank: number;
  videoId: string;
  title: string;
  artists: string;
  thumbnail: string;
}

const INNERTUBE_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const CLIENT_VERSION = "1.20240901.00";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function innertubeBrowse(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(
    `https://music.youtube.com/youtubei/v1/browse?key=${INNERTUBE_KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: "https://music.youtube.com",
      },
      body: JSON.stringify(body),
      // Charts change slowly; allow a generous upstream timeout.
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(`innertube browse http=${res.status}`);
  return res.json();
}

function sectionList(doc: unknown): unknown[] {
  const d = doc as Record<string, unknown>;
  const contents = d?.contents as Record<string, unknown>;
  const scr = contents?.singleColumnBrowseResultsRenderer as Record<string, unknown>;
  const tabs = (scr?.tabs ?? []) as Array<Record<string, unknown>>;
  const tab = tabs[0]?.tabRenderer as Record<string, unknown>;
  const content = tab?.content as Record<string, unknown>;
  const sectionList = content?.sectionListRenderer as Record<string, unknown>;
  return (sectionList?.contents ?? []) as unknown[];
}

function shelfTitle(section: unknown): string {
  try {
    const s = section as Record<string, Record<string, Record<string, unknown>>>;
    const key = Object.keys(s)[0];
    const header = s[key]?.header as Record<string, Record<string, Record<string, Array<Record<string, string>>>>>;
    return (
      header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text ?? ""
    );
  } catch {
    return "";
  }
}

/** Resolve a country code to its "Top 100 Music Videos" (preferred) or "Daily Top" playlist. */
export async function resolveChartPlaylist(
  country: string
): Promise<{ playlistId: string; playlistTitle: string; resolvedCountry: string }> {
  const doc = await innertubeBrowse({
    browseId: "FEmusic_charts",
    context: { client: { clientName: "WEB_REMIX", clientVersion: CLIENT_VERSION, gl: "US", hl: "en" } },
    formData: { selectedValues: [country] },
  });
  const sections = sectionList(doc);
  const videoShelf = sections.find((s) => shelfTitle(s) === "Video charts") as
    | Record<string, Record<string, Array<Record<string, Record<string, Record<string, unknown>>>>>>
    | undefined;
  if (!videoShelf) throw new Error("video charts shelf missing");
  const key = Object.keys(videoShelf)[0];
  const items = (videoShelf[key]?.contents ?? []) as Array<{
    musicTwoRowItemRenderer?: {
      title?: { runs?: Array<{ text?: string }> };
      navigationEndpoint?: { browseEndpoint?: { browseId?: string } };
    };
  }>;
  const playlists = items.flatMap((it) => {
    const r = it.musicTwoRowItemRenderer;
    const title = r?.title?.runs?.[0]?.text ?? "";
    const browseId = r?.navigationEndpoint?.browseEndpoint?.browseId ?? "";
    return title && browseId ? [{ title, browseId }] : [];
  });
  // Prefer the weekly Top 100; fall back to the Daily chart.
  const pick =
    playlists.find((p) => /^Top 100 Music Videos/i.test(p.title)) ??
    playlists.find((p) => /^Daily Top Music Videos/i.test(p.title));
  if (!pick) throw new Error("no chart playlist found");
  return {
    playlistId: pick.browseId.replace(/^VL/, ""),
    playlistTitle: pick.title,
    resolvedCountry: country,
  };
}

function findPlaylistShelf(doc: unknown): Array<unknown> | null {
  const stack: unknown[] = [doc];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (node && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (Array.isArray(rec.musicPlaylistShelfRenderer)) return null;
      if (rec.musicPlaylistShelfRenderer && typeof rec.musicPlaylistShelfRenderer === "object") {
        const shelf = rec.musicPlaylistShelfRenderer as Record<string, unknown>;
        if (Array.isArray(shelf.contents)) return shelf.contents as Array<unknown>;
      }
      stack.push(...Object.values(rec));
    }
  }
  return null;
}

type Rec = Record<string, unknown>;

function getPath(root: unknown, ...keys: string[]): unknown {
  let node: unknown = root;
  for (const k of keys) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Rec)[k];
  }
  return node;
}

function runsText(runs: unknown): string {
  if (!Array.isArray(runs)) return "";
  return runs.map((r) => (r as { text?: string }).text ?? "").join("");
}

/** Fetch top tracks of a chart playlist. Retries with fallback `gl` locales (Global playlists are locale-sensitive). */
export async function fetchPlaylistTracks(
  playlistBrowseId: string,
  country: string,
  limit = 10
): Promise<Track[]> {
  const gls = [country, "GB", "US", "DE"].filter((v, i, a) => a.indexOf(v) === i);
  let lastErr: unknown = null;
  for (const gl of gls) {
    try {
      const doc = await innertubeBrowse({
        browseId: playlistBrowseId.startsWith("VL") ? playlistBrowseId : `VL${playlistBrowseId}`,
        context: { client: { clientName: "WEB_REMIX", clientVersion: CLIENT_VERSION, gl, hl: "en" } },
      });
      const contents = findPlaylistShelf(doc);
      if (!contents || contents.length === 0) throw new Error(`empty playlist (gl=${gl})`);
      const tracks: Track[] = [];
      for (const item of contents.slice(0, limit)) {
        const r = getPath(item, "musicResponsiveListItemRenderer");
        if (!r) continue;
        const watchEndpoint = getPath(
          r,
          "overlay",
          "musicItemThumbnailOverlayRenderer",
          "content",
          "musicPlayButtonRenderer",
          "playNavigationEndpoint",
          "watchEndpoint"
        ) as { videoId?: string } | undefined;
        const flex = (getPath(r, "flexColumns") ?? []) as Array<Rec>;
        const title = runsText(
          getPath(flex[0], "musicResponsiveListItemFlexColumnRenderer", "text", "runs")
        );
        const artists = runsText(
          getPath(flex[1], "musicResponsiveListItemFlexColumnRenderer", "text", "runs")
        );
        const thumbs = (
          (getPath(r, "thumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails") ??
            []) as Array<{ url?: string }>
        ).filter((t) => t.url);
        if (!watchEndpoint?.videoId || !title) continue;
        const videoId: string = watchEndpoint.videoId;
        tracks.push({
          rank: tracks.length + 1,
          videoId,
          title,
          artists,
          thumbnail:
            thumbs.length > 0
              ? (thumbs[thumbs.length - 1].url as string)
              : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        });
      }
      if (tracks.length === 0) throw new Error(`no parseable tracks (gl=${gl})`);
      return tracks;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("playlist fetch failed");
}

/** Full pipeline: country -> chart playlist -> top tracks. */
export async function fetchCountryTop10(country: string): Promise<{
  tracks: Track[];
  playlistTitle: string;
}> {
  const { playlistId, playlistTitle } = await resolveChartPlaylist(country);
  const tracks = await fetchPlaylistTracks(`VL${playlistId}`, country, 10);
  return { tracks, playlistTitle };
}
