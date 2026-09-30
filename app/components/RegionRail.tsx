import type { Region } from "~/lib/countryMeta";
import { REGIONS } from "~/lib/countryMeta";
import type { StageCountry } from "./GlobeView";

interface Props {
  countries: StageCountry[];
  region: Region | null;
  onRegion: (r: Region | null) => void;
}

/** Region chips that dim every other country on the globe. It turns a static
 *  sphere into an instrument, and it is the fastest way to find "the one with a
 *  chart in the Pacific". */
export default function RegionRail({ countries, region, onRegion }: Props) {
  const counts = new Map<Region, number>();
  for (const c of countries) counts.set(c.region, (counts.get(c.region) ?? 0) + 1);
  const present = REGIONS.filter((r) => (counts.get(r) ?? 0) > 0);

  return (
    <nav
      aria-label="Filter by region"
      className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto no-scrollbar"
    >
      <Chip active={region === null} onClick={() => onRegion(null)}>
        All
        <span className="tnum ml-1 text-faint">{countries.length}</span>
      </Chip>
      {present.map((r) => (
        <Chip key={r} active={region === r} onClick={() => onRegion(region === r ? null : r)}>
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
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
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
