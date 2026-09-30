import { memo } from "react";
import { AlertTriangle, Music, X } from "lucide-react";
import type { ChartTrack, ChartWeek } from "~/lib/analyticsCharts";
import type { Region } from "~/lib/countryMeta";
import { isChartCountry } from "~/lib/countries";
import { fmtWeek, plural } from "~/lib/format";
import ChartRow from "./ChartRow";
import { CountryMark, EmptyState, Pill, ChartRowSkeleton } from "./ui";

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

const KINDS: { id: ChartKind; label: string }[] = [
  { id: "songs", label: "Songs" },
  { id: "videos", label: "Videos" },
];

function provenance(data: ChartData | null): string {
  if (!data) return "";
  if (data.provider === "spotify") return "Spotify Weekly · played via YouTube";
  if (data.fallback) return "No local chart · showing the global list";
  if (data.week?.start) return `Week of ${fmtWeek(data.week)}`;
  return data.playlistTitle;
}

interface Props {
  iso: string;
  name: string;
  region: Region;
  data: ChartData | null;
  loading: boolean;
  error: string | null;
  kind: ChartKind;
  activeIndex: number | null;
  isPlaying: boolean;
  isPaused: boolean;
  onTab: (k: ChartKind) => void;
  onPlay: (index: number) => void;
  onRetry: () => void;
  onClose: () => void;
}

// Memoized: the route re-renders on every globe hover, but nothing here depends
// on hover, so the panel should not re-render either.
export default memo(function ChartPanel({
  iso,
  name,
  region,
  data,
  loading,
  error,
  kind,
  activeIndex,
  isPlaying,
  isPaused,
  onTab,
  onPlay,
  onRetry,
  onClose,
}: Props) {
  const chartCountry = isChartCountry(iso);

  return (
    <section
      aria-label={`${name} chart`}
      className="lit glass flex h-full min-h-0 flex-col overflow-hidden rounded-panel"
    >
      {/* ---------------------------------------------------------- header */}
      <header className="shrink-0 px-4 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <CountryMark iso={iso} region={region} size="lg" />
          <div className="min-w-0 flex-1">
            <h2 className="display truncate text-[22px] leading-tight text-ink">{name}</h2>
            <p className="mt-0.5 truncate text-[12px] text-muted">{provenance(data)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {data && data.source !== "live" ? (
              <Pill
                tone="accent"
                title={
                  data.source === "stale"
                    ? "Live charts are unreachable — showing the last successful response"
                    : "Live charts are unreachable — showing the built-in backup list"
                }
              >
                {data.source === "stale" ? "cached" : "offline"}
              </Pill>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close chart"
              className="grid h-7 w-7 place-items-center rounded-lg text-faint transition hover:bg-raised hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {!chartCountry ? (
          <p className="mt-3 rounded-lg border border-line bg-raised/60 px-2.5 py-1.5 text-[11px] leading-snug text-muted">
            No dedicated chart here — showing Spotify&apos;s weekly list, resolved to playable videos.
          </p>
        ) : null}

        <div
          role="tablist"
          aria-label="Chart type"
          className="mt-3 grid grid-cols-2 gap-1 rounded-xl border border-line bg-void/50 p-1"
        >
          {KINDS.map((k) => (
            <button
              key={k.id}
              role="tab"
              type="button"
              aria-selected={kind === k.id}
              onClick={() => onTab(k.id)}
              className={`rounded-lg py-1.5 text-[12px] font-semibold transition ${
                kind === k.id ? "bg-accent text-accent-ink" : "text-muted hover:text-ink"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </header>

      {/* ------------------------------------------------------------ list */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2">
        {loading ? (
          <div aria-busy="true" aria-label="Loading chart">
            {Array.from({ length: 8 }, (_, i) => (
              <ChartRowSkeleton key={i} index={i} />
            ))}
          </div>
        ) : null}

        {!loading && error ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="Couldn't load this chart"
            body={error}
            action={
              <button
                type="button"
                onClick={onRetry}
                className="rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-accent-ink transition hover:brightness-110"
              >
                Try again
              </button>
            }
          />
        ) : null}

        {!loading && !error && data && data.tracks.length === 0 ? (
          <EmptyState
            icon={<Music className="h-5 w-5" />}
            title="Nothing charting here yet"
            body="This country has no entries in the current chart week."
          />
        ) : null}

        {!loading && !error && data && data.tracks.length > 0 ? (
          <ol className="flex flex-col gap-0.5">
            {data.tracks.map((track, i) => (
              <ChartRow
                key={`${track.videoId}-${i}`}
                track={track}
                index={i}
                isActive={i === activeIndex}
                isPlaying={isPlaying}
                isPaused={isPaused}
                onPlay={onPlay}
              />
            ))}
          </ol>
        ) : null}
      </div>

      {/* ---------------------------------------------------------- footer */}
      {data && !loading && !error ? (
        <footer className="shrink-0 border-t border-line px-4 py-2.5">
          <p className="tnum text-[11px] text-faint">
            {plural(data.tracks.length, "track")}
            {data.week?.start ? ` · chart week ${fmtWeek(data.week)}` : ""}
          </p>
        </footer>
      ) : null}
    </section>
  );
});
