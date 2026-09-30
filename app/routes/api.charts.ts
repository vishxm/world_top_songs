import { fetchCountryCharts, type ChartTrack, type ChartWeek } from "~/lib/analyticsCharts";
// Legacy pipeline: only used for the Global fallback (videos).
import { fetchCountryTop10 } from "~/lib/innertube";
import { fetchSpotifyWeekly } from "~/lib/spotifyKworb";
import { resolveMany } from "~/lib/ytResolve";
import { getFresh, getLastGood, setCached } from "~/lib/cache";
import { SEEDS } from "~/lib/seed";
import { SEED_SONGS } from "~/lib/seedSongs";
import { CHART_COUNTRIES } from "~/lib/countries";

type ChartKind = "songs" | "videos";

function toChartTracks(
  tracks: Array<{ rank: number; videoId: string; title: string; artists: string; thumbnail: string }>
): ChartTrack[] {
  return tracks.map((t) => ({
    rank: t.rank,
    videoId: t.videoId,
    title: t.title,
    artists: t.artists,
    weeklyViews: 0,
    thumbnail: t.thumbnail,
    previousRank: null,
    weeksOnChart: null,
    trend: "same" as const,
  }));
}

function seedFor(kind: ChartKind, country: string): ChartTrack[] {
  if (kind === "songs") return SEED_SONGS[country] ?? SEED_SONGS.US;
  return toChartTracks(SEEDS[country] ?? SEEDS.ZZ);
}

function respond(
  base: { country: string; chartCountry: string; fallback: boolean },
  entry: {
    tracks: ChartTrack[];
    playlistTitle: string;
    week: ChartWeek | null;
    chartKind: string;
    provider: "youtube" | "spotify";
  },
  source: "live" | "stale" | "seed",
  note?: string
) {
  return Response.json({ ...base, ...entry, source, ...(note ? { note } : {}) });
}

/** Spotify fallback for countries YouTube doesn't chart: weekly Spotify
 *  ranks resolved to playable YouTube videos. Needs >=5 confident matches
 *  or it throws and the caller falls through to the Global chart. */
async function spotifyTop10(raw: string): Promise<{ tracks: ChartTrack[]; playlistTitle: string }> {
  const entries = await fetchSpotifyWeekly(raw.toLowerCase());
  const resolved = await resolveMany(
    entries.slice(0, 12).map((e) => ({ artist: e.artist, title: e.title })),
    3
  );
  const tracks: ChartTrack[] = [];
  entries.slice(0, 12).forEach((e, i) => {
    const r = resolved[i];
    if (!r || tracks.length >= 10) return;
    tracks.push({
      rank: tracks.length + 1,
      videoId: r.videoId,
      title: r.title,
      artists: r.artists,
      weeklyViews: 0,
      thumbnail: r.thumbnail,
      previousRank: e.movement == null || e.movement === 0 ? null : e.rank + e.movement,
      weeksOnChart: null,
      trend: e.movement == null ? "same" : e.movement === 0 ? "same" : e.movement > 0 ? "up" : "down",
    });
  });
  if (tracks.length < 5) throw new Error(`only ${tracks.length} tracks resolved`);
  return { tracks, playlistTitle: "Spotify Weekly" };
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const raw = (url.searchParams.get("country") ?? "").toUpperCase();
  const kind = url.searchParams.get("type") === "videos" ? "videos" : "songs";
  if (!/^[A-Z]{2}$/.test(raw)) {
    return Response.json({ error: "country must be an ISO 3166-1 alpha-2 code" }, { status: 400 });
  }

  const supported = raw in CHART_COUNTRIES;
  const base = { country: raw, chartCountry: supported ? raw : "ZZ", fallback: !supported };

  // Unsupported country -> Spotify weekly (resolved to YouTube), else Global videos.
  if (!supported) {
    const spotKey = `${raw}:spotify`;
    const spotFresh = getFresh(spotKey);
    if (spotFresh) return respond(base, spotFresh, "live");
    try {
      const { tracks, playlistTitle } = await spotifyTop10(raw);
      const entry = setCached(spotKey, {
        tracks,
        playlistTitle,
        week: null,
        chartKind: "songs",
        provider: "spotify",
      });
      return respond(base, entry, "live");
    } catch {
      // No Spotify chart either -> Global videos fallback.
    }
    const key = `ZZ:videos`;
    const fresh = getFresh(key);
    if (fresh) return respond(base, fresh, "live");
    try {
      const { tracks, playlistTitle } = await fetchCountryTop10("ZZ");
      const entry = setCached(key, {
        tracks: toChartTracks(tracks),
        playlistTitle,
        week: null,
        chartKind: "videos",
        provider: "youtube",
      });
      return respond(base, entry, "live");
    } catch (e) {
      const stale = getLastGood(key);
      if (stale) return respond(base, stale, "stale");
      return respond(
        base,
        { tracks: seedFor("videos", "ZZ"), playlistTitle: "Top Music Videos", week: null, chartKind: "videos", provider: "youtube" },
        "seed",
        `live charts unreachable (${e instanceof Error ? e.message : "unknown error"})`
      );
    }
  }

  const key = `${raw}:${kind}`;
  const fresh = getFresh(key);
  if (fresh) return respond(base, fresh, "live");

  try {
    const charts = await fetchCountryCharts(raw);
    const list = kind === "songs" ? charts.songs : charts.videos;
    const entry = setCached(key, {
      tracks: list.slice(0, 10),
      playlistTitle: kind === "songs" ? "Weekly Top Songs" : "Weekly Top Music Videos",
      week: charts.week,
      chartKind: kind,
      provider: "youtube",
    });
    return respond(base, entry, "live");
  } catch (e) {
    const stale = getLastGood(key);
    if (stale) return respond(base, stale, "stale");
    return respond(
      base,
      {
        tracks: seedFor(kind, raw),
        playlistTitle: kind === "songs" ? "Weekly Top Songs" : "Weekly Top Music Videos",
        week: null,
        chartKind: kind,
        provider: "youtube",
      },
      "seed",
      `live charts unreachable (${e instanceof Error ? e.message : "unknown error"})`
    );
  }
}
