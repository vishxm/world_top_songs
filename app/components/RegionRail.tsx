import { Filter } from "lucide-react";
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
 *  announces the filter rather than just a highlighted pill. */
export default function RegionRail({ countries, region, onRegion }: Props) {
  const counts = new Map<Region, number>();
  for (const c of countries) counts.set(c.region, (counts.get(c.region) ?? 0) + 1);
  const present = REGIONS.filter((r) => (counts.get(r) ?? 0) > 0);

  return (
    <nav
      aria-label="Filter by region"
      className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto no-scrollbar"
    >
      <span className="flex shrink-0 items-center gap-1.5 pr-1.5 text-[11.5px] font-medium tracking-[0.08em] text-faint uppercase">
        <Filter className="h-3.5 w-3.5" aria-hidden />
        Region
      </span>
      <Chip
        active={region === null}
        onClick={() => onRegion(null)}
        title="Show every country"
      >
        All
        <span className="tnum ml-1 text-faint">{countries.length}</span>
      </Chip>
      {present.map((r) => (
        <Chip
          key={r}
          active={region === r}
          onClick={() => onRegion(region === r ? null : r)}
          title={region === r ? `Show every country again` : `Fade everything outside ${r}`}
        >
          {r}
          <span className="tnum ml-1 text-faint">{counts.get(r)}</span>
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
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={`shrink-0 rounded-full border px-3 py-1 text-[11.5px] whitespace-nowrap transition ${
        active
          ? "border-transparent bg-accent text-accent-ink"
          : "border-line bg-panel/60 text-muted backdrop-blur hover:border-line-bright hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
