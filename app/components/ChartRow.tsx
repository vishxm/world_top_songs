import { memo } from "react";
import type { ChartTrack } from "~/lib/analyticsCharts";
import { fmtViews } from "~/lib/format";
import { Pill } from "./ui";

/** Three-bar equalizer shown on the playing row. Pure CSS so it costs nothing
 *  on a list that re-renders while the globe spins. */
function Equalizer() {
  return (
    <span className="flex h-4 shrink-0 items-end gap-[2px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-full w-[2.5px] origin-bottom animate-bar rounded-full bg-accent motion-reduce:animate-none"
          style={{ animationDelay: `${i * 160}ms`, transform: "scaleY(0.3)" }}
        />
      ))}
    </span>
  );
}

function Movement({ track }: { track: ChartTrack }) {
  if (track.trend === "new" || track.previousRank == null) {
    return (
      <Pill tone="new" title="New to the chart this week">
        NEW
      </Pill>
    );
  }
  if (track.trend === "same") return <Pill title="Holding its position">—</Pill>;
  const up = track.trend === "up";
  const diff = Math.abs(track.previousRank - track.rank);
  return (
    <Pill
      tone={up ? "up" : "down"}
      title={`${up ? "Up" : "Down"} ${diff} from last week (#${track.previousRank})`}
    >
      {up ? "▲" : "▼"}
      {diff}
    </Pill>
  );
}

const MEDAL = ["text-[#f0c674]", "text-[#c9d1d9]", "text-[#d08c60]"];

interface Props {
  track: ChartTrack;
  index: number;
  isActive: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  onPlay: (index: number) => void;
}

export default memo(function ChartRow({ track, index, isActive, isPlaying, isPaused, onPlay }: Props) {
  const live = isActive && isPlaying;
  return (
    <li>
      <button
        type="button"
        onClick={() => onPlay(index)}
        aria-current={isActive ? "true" : undefined}
        className={`group relative flex w-full items-center gap-3 rounded-xl py-2 pr-2.5 pl-3 text-left transition-colors ${
          isActive ? "bg-accent/10" : "hover:bg-raised"
        }`}
      >
        {/* Active marker: a lit rail rather than a full-width wash. */}
        <span
          aria-hidden
          className={`absolute top-1/2 left-0 h-7 w-[2px] -translate-y-1/2 rounded-full bg-accent transition-opacity ${
            isActive ? "opacity-100" : "opacity-0"
          }`}
        />

        <span
          className={`tnum w-5 shrink-0 text-center text-[13px] font-semibold tabular-nums ${
            index < 3 ? MEDAL[index] : "text-faint"
          }`}
        >
          {track.rank}
        </span>

        <span className="relative aspect-video w-[52px] shrink-0 overflow-hidden rounded-md bg-raised ring-1 ring-line ring-inset">
          <img
            src={track.thumbnail}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.06]"
          />
          {isActive ? (
            <span className="absolute inset-0 grid place-items-center bg-void/55 backdrop-blur-[1px]">
              {live ? <Equalizer /> : <PlayGlyph />}
            </span>
          ) : null}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight font-medium text-ink">{track.title}</span>
          <span className="mt-0.5 flex items-baseline gap-1.5 text-[11.5px] leading-tight text-muted">
            <span className="truncate">{track.artists}</span>
            {track.weeklyViews > 0 ? (
              <>
                <span className="text-faint/70">·</span>
                <span className="tnum shrink-0 text-faint">{fmtViews(track.weeklyViews)}</span>
              </>
            ) : null}
          </span>
        </span>

        <span className="flex shrink-0 items-center">
          {live ? (
            <span className="sr-only">Playing</span>
          ) : (
            <Movement track={track} />
          )}
        </span>
      </button>
      {isActive && isPaused ? <span className="sr-only">Paused</span> : null}
    </li>
  );
});

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 translate-x-px fill-ink" aria-hidden>
      <path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11.14-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z" />
    </svg>
  );
}
