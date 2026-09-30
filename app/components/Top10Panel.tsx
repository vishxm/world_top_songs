import type { ChartTrack, ChartWeek } from "~/lib/analyticsCharts";
import { memo } from "react";
import { flagEmoji } from "~/lib/countries";
import Player from "./Player";

export type ChartKind = "songs" | "videos";

export interface ChartData {
  chartCountry: string;
  fallback: boolean;
  source: "live" | "stale" | "seed";
  provider: "youtube" | "spotify";
  chartKind: ChartKind;
  playlistTitle: string;
  week: ChartWeek | null;
  tracks: ChartTrack[];
}

interface Props {
  iso: string;
  name: string;
  data: ChartData | null;
  loading: boolean;
  error: string | null;
  kind: ChartKind;
  activeIndex: number | null;
  onTab: (k: ChartKind) => void;
  onPlay: (index: number) => void;
  onNext: () => void;
  onRetry: () => void;
  onClose: () => void;
}

export function fmtViews(n: number): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
}

function fmtWeek(week: ChartWeek | null): string {
  if (!week?.start) return "";
  const f = (iso: string) =>
    new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return week.end && week.end !== week.start ? `${f(week.start)} – ${f(week.end)}` : f(week.start);
}

function Movement({ t }: { t: ChartTrack }) {
  if (t.trend === "new" || t.previousRank == null) {
    return (
      <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300">
        NEW
      </span>
    );
  }
  if (t.trend === "same") return <span className="shrink-0 text-xs text-zinc-600">•</span>;
  const up = t.trend === "up";
  const diff = Math.abs(t.previousRank - t.rank);
  return (
    <span className={`shrink-0 text-xs font-semibold ${up ? "text-emerald-400" : "text-red-400"}`}>
      {up ? "▲" : "▼"}
      {diff}
    </span>
  );
}

// Memoized: parent re-renders on every globe hover, but panel props only
// change on selection/data changes — skip the rest.
export default memo(function Top10Panel({
  iso,
  name,
  data,
  loading,
  error,
  kind,
  activeIndex,
  onTab,
  onPlay,
  onNext,
  onRetry,
  onClose,
}: Props) {
  return (
    <div className="flex max-h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/85 shadow-2xl backdrop-blur-xl">
      <div className="border-b border-white/10 p-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-2xl leading-none">{flagEmoji(iso)}</p>
            <h2 className="mt-1 truncate text-lg font-bold text-white">{name}</h2>
            <p className="text-xs text-zinc-400">
              {data?.provider === "spotify" ? (
                <>Spotify Weekly · played via YouTube</>
              ) : data?.fallback ? (
                <>No local chart — showing Global</>
              ) : data?.week ? (
                <>Week of {fmtWeek(data.week)}</>
              ) : (
                <>Top 10 right now</>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {data && data.source !== "live" && (
              <span
                title={
                  data.source === "stale"
                    ? "Live charts unreachable, showing last cached"
                    : "Live charts unreachable, showing backup"
                }
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300"
              >
                {data.source === "stale" ? "cached" : "offline"}
              </span>
            )}
            <button
              onClick={onClose}
              className="rounded-full bg-white/10 px-2.5 py-1 text-sm text-zinc-300 hover:bg-white/20"
              aria-label="Close panel"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-full bg-white/5 p-1">
          {(["songs", "videos"] as ChartKind[]).map((k) => (
            <button
              key={k}
              onClick={() => onTab(k)}
              className={`rounded-full py-1 text-xs font-semibold transition-colors ${
                kind === k ? "bg-blue-500 text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              {k === "songs" ? "♪ Top Songs" : "▶ Top Videos"}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && (
          <ul className="space-y-1 p-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 rounded-lg p-2">
                <span className="w-6 shrink-0 text-center text-sm text-zinc-600">{i + 1}</span>
                <span className="h-11 w-20 shrink-0 animate-pulse rounded bg-white/10" />
                <span className="flex-1 space-y-1.5">
                  <span className="block h-3 w-3/4 animate-pulse rounded bg-white/10" />
                  <span className="block h-2.5 w-1/2 animate-pulse rounded bg-white/10" />
                </span>
              </li>
            ))}
          </ul>
        )}

        {error && !loading && (
          <div className="p-4 text-center">
            <p className="text-sm text-red-300">Couldn&apos;t load charts: {error}</p>
            <button
              onClick={onRetry}
              className="mt-3 rounded-full bg-blue-500 px-4 py-1.5 text-sm font-semibold hover:bg-blue-400"
            >
              Retry
            </button>
          </div>
        )}

        {data && !loading && (
          <ol className="space-y-0.5 p-1">
            {data.tracks.map((t, i) => {
              const isActive = i === activeIndex;
              return (
                <li key={t.videoId + i}>
                  <button
                    onClick={() => onPlay(i)}
                    className={`flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors ${
                      isActive ? "bg-blue-500/20 ring-1 ring-blue-400/50" : "hover:bg-white/5"
                    }`}
                  >
                    <span
                      className={`w-6 shrink-0 text-center text-sm font-bold ${
                        i < 3 ? "text-blue-300" : "text-zinc-500"
                      }`}
                    >
                      {t.rank}
                    </span>
                    <img
                      src={t.thumbnail}
                      alt=""
                      loading="lazy"
                      className="h-11 w-20 shrink-0 rounded object-cover"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-white">
                        {t.title}
                      </span>
                      <span className="block truncate text-xs text-zinc-400">
                        {t.artists}
                        {t.weeklyViews > 0 && (
                          <span className="text-zinc-500"> · {fmtViews(t.weeklyViews)} plays</span>
                        )}
                      </span>
                    </span>
                    {isActive ? (
                      <span className="flex shrink-0 items-end gap-0.5" aria-hidden>
                        {[0, 1, 2].map((b) => (
                          <span
                            key={b}
                            className="w-1 animate-pulse rounded bg-blue-400"
                            style={{ height: `${10 + b * 5}px`, animationDelay: `${b * 150}ms` }}
                          />
                        ))}
                      </span>
                    ) : (
                      <Movement t={t} />
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {data && !loading && (
        <div className="border-t border-white/10 p-3">
          <Player tracks={data.tracks} activeIndex={activeIndex} onSelect={onPlay} onEnded={onNext} />
          {activeIndex == null && (
            <p className="mt-2 text-center text-xs text-zinc-500">
              Pick a track to start the queue — it plays through the Top 10.
            </p>
          )}
        </div>
      )}
    </div>
  );
});
