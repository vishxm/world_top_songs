import type { Ref } from "react";
import { ChevronUp, Music } from "lucide-react";
import type { Region } from "~/lib/countryMeta";
import { fmtWeek, plural } from "~/lib/format";
import type { ChartKind, ChartPayload } from "~/lib/chartTypes";
import { CountryMark } from "./ui";

interface Props {
  iso: string;
  name: string;
  region: Region;
  data: ChartPayload | null;
  loading: boolean;
  /** The active tab. The payload carries both lists, so the peek counts the one
   *  the expanded sheet would show rather than assuming songs. */
  kind: ChartKind;
  onExpand: () => void;
  /** Focus lands here after the chevron folds the sheet: the chevron unmounts,
   *  so without it the keyboard user is dropped on <body>. */
  buttonRef?: Ref<HTMLButtonElement>;
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
export default function ChartPeek({
  iso,
  name,
  region,
  data,
  loading,
  kind,
  onExpand,
  buttonRef,
}: Props) {
  // Only the payload for this country may describe this country. A response for
  // the previous selection lives in the hook for one render before the effect
  // clears it, and a borrowed count under a new name is exactly what the
  // no-chart contract forbids.
  const payload = data?.country === iso ? data : null;
  const tracks = payload?.charted ? payload[kind] : [];
  const summary = loading
    ? "Loading…"
    : !payload
      ? ""
      : !payload.charted
        ? "No official chart"
        : tracks.length > 0
          ? `${plural(tracks.length, kind === "videos" ? "video" : "song")}${payload.week?.start ? ` · ${fmtWeek(payload.week)}` : ""}`
          : "No entries yet";

  return (
    <section aria-label={`${name} chart`} className="surface overflow-hidden">
      <button
        ref={buttonRef}
        type="button"
        onClick={onExpand}
        aria-label={`Show the ${name} chart`}
        aria-expanded="false"
        className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-raised/60"
      >
        <CountryMark iso={iso} region={region} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-ink">{name}</span>
          <span className="tnum mt-0.5 flex items-center gap-1 truncate text-micro text-muted">
            {payload?.charted && tracks.length === 0 ? (
              <Music className="h-3 w-3 shrink-0" aria-hidden />
            ) : null}
            {summary}
          </span>
        </span>
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-control text-faint transition group-hover:bg-raised group-hover:text-ink"
        >
          <ChevronUp className="h-4 w-4" />
        </span>
      </button>
    </section>
  );
}