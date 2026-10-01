import { ChevronUp, Music } from "lucide-react";
import type { Region } from "~/lib/countryMeta";
import { fmtWeek, plural } from "~/lib/format";
import { CountryMark } from "./ui";
import type { ChartData } from "./ChartPanel";

interface Props {
  iso: string;
  name: string;
  region: Region;
  data: ChartData | null;
  loading: boolean;
  onExpand: () => void;
}

/**
 * The folded state of the chart sheet on narrow layouts.
 *
 * Reached two ways, and it has to answer to both:
 *   - the chevron in the panel header, or
 *   - tapping the globe somewhere that is not a country (handled in the route).
 *
 * The second is the one that needed building — on a phone the sheet covers half
 * the screen, so wanting to see the globe meant closing the chart entirely and
 * losing the selection. Folding keeps `?c=` in the URL, keeps the ring on the
 * globe and keeps the audio playing; only the list goes away.
 *
 * It is a real control, not a decoration: the whole bar reopens the sheet, and it
 * announces itself as a button so a screen reader reaches the same affordance.
 * The summary line keeps the useful half of what the panel said — how many tracks
 * there are and which week they are from — because that is what makes a collapsed
 * bar worth leaving on screen rather than a bare handle.
 */
export default function ChartPeek({ iso, name, region, data, loading, onExpand }: Props) {
  const summary = loading
    ? "Loading…"
    : data && data.tracks.length > 0
      ? `${plural(data.tracks.length, "track")}${data.week?.start ? ` · ${fmtWeek(data.week)}` : ""}`
      : data
        ? "No entries yet"
        : "";

  return (
    <section aria-label={`${name} chart`} className="lit glass overflow-hidden rounded-panel">
      <button
        type="button"
        onClick={onExpand}
        aria-label={`Show the ${name} chart`}
        aria-expanded="false"
        className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-raised/50"
      >
        <CountryMark iso={iso} region={region} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight font-medium text-ink">{name}</span>
          <span className="tnum mt-0.5 flex items-center gap-1 truncate text-[11px] leading-tight text-muted">
            {data && data.tracks.length === 0 ? (
              <Music className="h-3 w-3 shrink-0" aria-hidden />
            ) : null}
            {summary}
          </span>
        </span>
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-faint transition group-hover:bg-raised group-hover:text-ink"
        >
          <ChevronUp className="h-4 w-4" />
        </span>
      </button>
    </section>
  );
}