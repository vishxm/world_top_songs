// Official YouTube Charts fetcher (keyless).
// Talks to charts.youtube.com's internal browse API with its public
// WEB_MUSIC_ANALYTICS web-client key (extracted from the site's own JS
// bundle — not a secret, no billing, no account).
// Yields per-country WEEKLY Top Songs (audio) + Top Videos + Trending,
// each with rank movement and the exact chart week.

export type Trend = "up" | "down" | "same" | "new";

export interface ChartTrack {
  rank: number;
  videoId: string;
  title: string;
  artists: string;
  weeklyViews: number;
  thumbnail: string;
  previousRank: number | null;
  weeksOnChart: number | null;
  trend: Trend;
}

export interface ChartWeek {
  id: string;
  start: string;
  end: string;
}

export interface CountryCharts {
  country: string;
  week: ChartWeek;
  songs: ChartTrack[];
  videos: ChartTrack[];
  trending: ChartTrack[];
}

// Public web-client key shipped in charts.youtube.com's own JS bundle.
const CHARTS_KEY = "AIzaSyAFk2JpgKwhyrQFnLjwMCN4OGR1S4g1eyM";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

interface RawEntry {
  chartEntryMetadata?: {
    currentPosition?: number;
    previousPosition?: number;
    periodsOnChart?: number;
  };
}

function toNum(v: unknown): number {
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

function trendOf(prev: number | null | undefined, cur: number): { trend: Trend; previousRank: number | null } {
  if (prev == null || prev <= 0) return { trend: "new", previousRank: null };
  if (prev === cur) return { trend: "same", previousRank: prev };
  return { trend: prev > cur ? "up" : "down", previousRank: prev };
}

function parseSong(item: Record<string, unknown>): ChartTrack | null {
  const meta = (item.chartEntryMetadata ?? {}) as RawEntry["chartEntryMetadata"];
  const rank = meta?.currentPosition ?? 0;
  const videoId = (item.encryptedVideoId as string) ?? "";
  const title = (item.name as string) ?? "";
  if (!rank || !videoId || !title) return null;
  const artists = ((item.artists ?? []) as Array<{ name?: string }>)
    .map((a) => a.name ?? "")
    .filter(Boolean)
    .join(", ");
  const thumbs = (
    ((item.thumbnail ?? {}) as { thumbnails?: Array<{ url?: string }> }).thumbnails ?? []
  ).filter((t) => t.url);
  const { trend, previousRank } = trendOf(meta?.previousPosition, rank);
  return {
    rank,
    videoId,
    title,
    artists,
    weeklyViews: toNum(item.viewCount),
    thumbnail:
      thumbs.length > 0
        ? (thumbs[thumbs.length - 1].url as string)
        : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    previousRank,
    weeksOnChart: meta?.periodsOnChart ?? null,
    trend,
  };
}

function parseVideo(item: Record<string, unknown>): ChartTrack | null {
  const meta = (item.chartEntryMetadata ?? {}) as RawEntry["chartEntryMetadata"];
  const rank = meta?.currentPosition ?? 0;
  const videoId = (item.id as string) ?? "";
  const title = (item.title as string) ?? "";
  if (!rank || !videoId || !title) return null;
  const artists = ((item.artists ?? []) as Array<{ name?: string }>)
    .map((a) => a.name ?? "")
    .filter(Boolean)
    .join(", ");
  const thumbs = (
    ((item.thumbnail ?? {}) as { thumbnails?: Array<{ url?: string }> }).thumbnails ?? []
  ).filter((t) => t.url);
  const { trend, previousRank } = trendOf(meta?.previousPosition, rank);
  return {
    rank,
    videoId,
    title,
    artists,
    weeklyViews: toNum(item.viewCount),
    thumbnail:
      thumbs.length > 0
        ? (thumbs[thumbs.length - 1].url as string)
        : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    previousRank,
    weeksOnChart: meta?.periodsOnChart ?? null,
    trend,
  };
}

export async function fetchCountryCharts(country: string): Promise<CountryCharts> {
  const res = await fetch(
    `https://charts.youtube.com/youtubei/v1/browse?alt=json&key=${CHARTS_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Origin: "https://charts.youtube.com",
      },
      body: JSON.stringify({
        browseId: "FEmusic_analytics_charts_home",
        context: {
          client: {
            clientName: "WEB_MUSIC_ANALYTICS",
            clientVersion: "2.0",
            gl: country,
            hl: "en",
          },
        },
      }),
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(`charts browse http=${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  const sections = (
    (doc.contents as Record<string, Record<string, Array<unknown>>>)?.sectionListRenderer
      ?.contents ?? []
  ) as Array<Record<string, Record<string, Record<string, unknown>>>>;
  const content = sections[0]?.musicAnalyticsSectionRenderer?.content as
    | Record<string, Array<Record<string, unknown>>>
    | undefined;
  if (!content) throw new Error("charts content missing");

  const songs = (
    (((content.trackTypes ?? [])[0] as Record<string, unknown> | undefined)?.trackViews ??
      []) as Array<Record<string, unknown>>
  )
    .map(parseSong)
    .filter((t): t is ChartTrack => t != null);
  const videoLists = (content.videos ?? []).map((v) => {
    const inner = Object.keys(v).find((k) => k !== "listType");
    return {
      type: v.listType as string,
      items: ((inner ? v[inner] : []) as Array<Record<string, unknown>>)
        .map(parseVideo)
        .filter((t): t is ChartTrack => t != null),
    };
  });
  const videos = videoLists.find((l) => l.type === "TOP_VIEWS_CHART")?.items ?? [];
  const trending = videoLists.find((l) => l.type === "TRENDING_CHART")?.items ?? [];
  if (songs.length === 0) throw new Error("no songs in charts response");

  const periods = (
    (content.perspectiveMetadata as unknown as {
      entityId?: string;
      chartRestrictions?: { chartPeriods?: Array<{ id?: string; startTime?: string; endTime?: string }> };
    }) ?? {}
  );
  const current = periods.chartRestrictions?.chartPeriods?.[0];
  const week: ChartWeek = current?.startTime
    ? {
        id: current.id ?? periods.entityId ?? "",
        start: current.startTime,
        end: current.endTime ?? current.startTime,
      }
    : { id: periods.entityId ?? "", start: "", end: "" };

  return { country, week, songs, videos, trending };
}
