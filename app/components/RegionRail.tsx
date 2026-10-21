import type { Region } from "~/lib/countryMeta";
import { REGIONS } from "~/lib/countryMeta";
import type { StageCountry } from "./GlobeView";

interface Props {
  countries: StageCountry[];
  region: Region | null;
  onRegion: (r: Region | null) => void;
}

/** Region chips that fade every other country on the globe, so one continent at
 *  a time is legible. It turns a static sphere into an instrument, and it is the
 *  fastest way to find "the one with a chart in the Pacific".
 *
 *  The rail is labelled because an unlabelled row of country-ish chips reads as
 *  navigation and does nothing you can see. The label states the effect, the
 *  chips carry the counts, and the active chip is pressed so a screen reader
 *  announces the filter rather than just a highlighted pill.
 *
 *  WRAPS rather than scrolls sideways: an `overflow-x-auto` rail put chips past
 *  the right edge behind `no-scrollbar` — present, unreachable, indistinguishable
 *  from "the buttons don't work". Wrapping keeps every chip on screen and
 *  tappable; it grows upward, which is free because the rail is bottom-anchored. */
export default function RegionRail({ countries, region, onRegion }: Props) {
  const counts = new Map<Region, number>();
  for (const c of countries) counts.set(c.region, (counts.get(c.region) ?? 0) + 1);
  const present = REGIONS.filter((r) => (counts.get(r) ?? 0) > 0);

  return (
    <nav
      aria-label="Filter by region"
      className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 sm:justify-start"
    >
      <span className="eyebrow shrink-0 pr-1.5">Region</span>
      <Chip active={region === null} onClick={() => onRegion(null)} title="Show every country">
        All
        <span className="tnum text-faint">{countries.length}</span>
      </Chip>
      {present.map((r) => (
        <Chip
          key={r}
          active={region === r}
          onClick={() => onRegion(region === r ? null : r)}
          title={region === r ? "Show every country again" : `Fade everything outside ${r}`}
        >
          {r}
          <span className="tnum text-faint">{counts.get(r)}</span>
        </Chip>
      ))}
    </nav>
  );
}

function Chip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} title={title} className="chip">
      {children}
    </button>
  );
}
