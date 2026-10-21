import { memo } from "react";
import { AlertTriangle, ChevronDown, Music, X } from "lucide-react";
import type { ChartTrack, ChartWeek } from "~/lib/analyticsCharts";
import type { Region } from "~/lib/countryMeta";
import { isChartCountry } from "~/lib/countries";
import { fmtWeek, plural } from "~/lib/format";
import ChartRow from "./ChartRow";
import { CountryMark, EmptyState, ChartRowSkeleton } from "./ui";

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
  /** videoId of the playing track, or null. Not an index: the player's queue is
   *  independent of this list, so positions do not correspond. */
  activeVideoId: string | null;
  isPlaying: boolean;
  isPaused: boolean;
  onTab: (k: ChartKind) => void;
  onPlay: (index: number) => void;
  onRetry: () => void;
  onClose: () => void;
  /**
   * Narrow layouts only. Collapses the sheet to its peek bar — the country stays
   * selected, the audio keeps playing, the globe just gets the screen back. Wide
   * layouts have a rail instead of a sheet, so this is not passed there.
   */
  onFold?: () => void;
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
  activeVideoId,
  isPlaying,
  isPaused,
  onTab,
  onPlay,
  onRetry,
  onClose,
  onFold,
}: Props) {
  const chartCountry = isChartCountry(iso);

  return (
    <section
      aria-label={`${name} chart`}
      className="surface flex h-full min-h-0 flex-col overflow-hidden"
    >
      {/* ---------------------------------------------------------- header */}
      <header className="shrink-0 px-4 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <CountryMark iso={iso} region={region} size="lg" />
          <div className="min-w-0 flex-1">
            <h2 className="display truncate text-display text-ink">{name}</h2>
            <p className="mt-0.5 truncate text-small text-muted">{provenance(data)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onFold ? (
              <button
                type="button"
                onClick={onFold}
                aria-label="Collapse chart"
                title="Collapse the chart and see the globe"
                className="grid h-7 w-7 place-items-center rounded-control text-faint transition hover:bg-raised hover:text-ink"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close chart"
              className="grid h-7 w-7 place-items-center rounded-control text-faint transition hover:bg-raised hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {!chartCountry ? (
          <p className="mt-3 rounded-control border border-line bg-raised/60 px-2.5 py-1.5 text-micro leading-snug text-muted">
            No dedicated chart here — showing Spotify&apos;s weekly list, resolved to playable videos.
          </p>
        ) : null}

        <div role="tablist" aria-label="Chart type" className="mt-3 flex gap-1 border-b border-line">
          {KINDS.map((k) => (
            <button
              key={k.id}
              role="tab"
              type="button"
              aria-selected={kind === k.id}
              onClick={() => onTab(k.id)}
              className={`-mb-px flex-1 border-b-2 py-2 text-small font-medium transition ${
                kind === k.id
                  ? "border-accent text-ink"
                  : "border-transparent text-muted hover:text-ink"
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
              <button type="button" onClick={onRetry} className="btn btn-primary">
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
                isActive={track.videoId === activeVideoId}
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
          <p className="tnum text-micro text-faint">
            {plural(data.tracks.length, "track")}
            {data.week?.start ? ` · chart week ${fmtWeek(data.week)}` : ""}
          </p>
        </footer>
      ) : null}
    </section>
  );
});
