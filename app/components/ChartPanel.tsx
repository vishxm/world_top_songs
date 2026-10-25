import { memo, type Ref } from "react";
import { AlertTriangle, ChevronDown, Compass, Music, X } from "lucide-react";
import { isChartCountry } from "~/lib/countries";
import { fmtFetched, fmtWeek, plural } from "~/lib/format";
import { isCharted, NO_CHART_REASON, type ChartKind, type ChartPayload } from "~/lib/chartTypes";
import type { Region } from "~/lib/countryMeta";
import ChartRow from "./ChartRow";
import { CountryMark, EmptyState, ChartRowSkeleton } from "./ui";

const KINDS: { id: ChartKind; label: string }[] = [
  { id: "songs", label: "Songs" },
  { id: "videos", label: "Videos" },
];

/**
 * Provenance reads as one quiet sentence: whether the data is live or the last
 * good copy, which week it covers, and when it was fetched. It is not a pill and
 * not a badge — the chart itself is the subject.
 */
function Provenance({ data, loading }: { data: ChartPayload | null; loading: boolean }) {
  if (loading) return <>Loading chart…</>;
  if (!isCharted(data)) return null;

  const week = data.week?.start ? `Week of ${fmtWeek(data.week)}` : null;
  const fetched = fmtFetched(data.fetchedAt);

  return (
    <>
      <span
        className={data.source === "stale" ? "text-accent" : undefined}
        title={
          data.source === "stale"
            ? "The chart source is unavailable; this is the last good copy."
            : "Fetched from the official chart source."
        }
      >
        {data.source === "live" ? "Live" : "Stale"}
      </span>
      {week ? <> · {week}</> : null}
      {fetched ? <> · {fetched}</> : null}
    </>
  );
}

interface Props {
  iso: string;
  name: string;
  region: Region;
  data: ChartPayload | null;
  loading: boolean;
  error: string | null;
  kind: ChartKind;
  /** A one-off explanation from the route, e.g. an invalid country code was
   *  recovered to a real one. Cleared when the user makes a new selection. */
  notice?: string | null;
  /** videoId of the playing track, or null. Not an index: the player's queue is
   *  independent of this list, so positions do not correspond. */
  activeVideoId: string | null;
  isPlaying: boolean;
  isPaused: boolean;
  onTab: (k: ChartKind) => void;
  onPlay: (index: number) => void;
  onRetry: () => void;
  /** Opens the country picker restricted to countries with an official chart.
   *  The no-chart notice's only way forward: an uncharted country has no list
   *  to show, so the useful next act is choosing somewhere that has one. */
  onFindCharted: () => void;
  onClose: () => void;
  /**
   * Narrow layouts only. Collapses the sheet to its peek bar — the country stays
   * selected, the audio keeps playing, the globe just gets the screen back. Wide
   * layouts have a rail instead of a sheet, so this is not passed there.
   */
  onFold?: () => void;
  /** Focus lands here after the peek bar reopens the sheet: the peek unmounts,
   *  so the keyboard user would otherwise be dropped on <body>. */
  foldRef?: Ref<HTMLButtonElement>;
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
  notice,
  activeVideoId,
  isPlaying,
  isPaused,
  onTab,
  onPlay,
  onRetry,
  onFindCharted,
  onClose,
  onFold,
  foldRef,
}: Props) {
  const chartCountry = isChartCountry(iso);
  // The payload is only used for the country it names. Without this guard a
  // response that arrived for the previous selection could be rendered under
  // the new country's heading for a frame — exactly the "borrowed chart" the
  // no-chart contract forbids.
  const chart = isCharted(data) && data.country === iso ? data : null;
  const tracks = chart ? chart[kind] : [];

  /**
   * The explicit no-chart payload is the authority, but the local coverage list
   * already knows the answer, so the notice can appear immediately instead of
   * sitting behind a skeleton that will resolve to nothing. A charted country
   * with no data yet has no reason at all — that is still a loading state.
   */
  const noChartReason = chart
    ? null
    : data?.country === iso && data.charted === false
      ? data.reason
      : chartCountry
        ? null
        : NO_CHART_REASON;

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
            <p
              data-chart-provenance="true"
              className="mt-0.5 truncate text-small text-muted"
            >
              <Provenance data={chart} loading={loading && !noChartReason} />
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onFold ? (
              <button
                ref={foldRef}
                type="button"
                onClick={onFold}
                aria-label="Collapse chart"
                title="Collapse the chart and see the globe"
                className="grid h-7 w-7 place-items-center rounded-control text-faint transition hover:bg-raised hover:text-ink lg:hidden"
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

        {notice ? (
          <p
            role="status"
            className="mt-3 flex items-start gap-2 rounded-control border border-accent/25 bg-accent/10 px-2.5 py-1.5 text-micro leading-snug text-muted"
          >
            <Compass className="mt-0.5 h-3 w-3 shrink-0 text-accent" aria-hidden />
            <span>{notice}</span>
          </p>
        ) : null}

        {!noChartReason ? (
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
        ) : null}
      </header>

      {/* ------------------------------------------------------------ list */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2">
        {loading && !noChartReason ? (
          <div aria-busy="true" aria-label="Loading chart">
            {Array.from({ length: 8 }, (_, i) => (
              <ChartRowSkeleton key={i} index={i} />
            ))}
          </div>
        ) : null}

        {!loading && error && !noChartReason ? (
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

        {noChartReason ? (
          <div data-no-chart="true">
            <EmptyState
              icon={<Compass className="h-5 w-5" />}
              title={`No official chart for ${name}`}
              body={noChartReason}
              action={
                <button type="button" onClick={onFindCharted} className="btn btn-primary">
                  Browse charted countries
                </button>
              }
            />
          </div>
        ) : null}

        {!loading && !error && chart && tracks.length === 0 ? (
          <EmptyState
            icon={<Music className="h-5 w-5" />}
            title="Nothing charting here yet"
            body={`This country has no ${kind === "videos" ? "video" : "song"} entries in the current chart week.`}
          />
        ) : null}

        {!loading && !error && chart && tracks.length > 0 ? (
          <ol className="flex flex-col gap-0.5">
            {tracks.map((track, i) => (
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
      {chart && !loading && !error ? (
        <footer className="shrink-0 border-t border-line px-4 py-2.5">
          <p className="tnum text-micro text-faint">
            {plural(tracks.length, kind === "videos" ? "video" : "song")}
          </p>
        </footer>
      ) : null}
    </section>
  );
});
