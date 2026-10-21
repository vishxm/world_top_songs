import { Shuffle } from "lucide-react";
import type { StageCountry } from "./GlobeView";
import CountryPicker from "./CountryPicker";
import { AtlasMark } from "./ui";

interface Props {
  countries: StageCountry[];
  hovered: StageCountry | null;
  selectedIso: string | null;
  onPick: (c: StageCountry) => void;
  onSurprise: () => void;
}

export default function Header({ countries, hovered, selectedIso, onPick, onSurprise }: Props) {
  // On wide layouts the chart rail occupies the right edge, so the header keeps
  // its controls clear of it rather than sitting underneath the panel.
  return (
    <header
      className={`pointer-events-none absolute top-0 z-30 flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:p-gutter ${
        selectedIso ? "right-3 left-3 sm:right-[calc(384px+2.5rem)] sm:left-gutter" : "inset-x-0"
      }`}
    >
      {/* Wordmark + live hover readout. `min-w-0` stops the title wrapping into a
          one-word-per-line column on narrow screens. */}
      <div className="pointer-events-auto min-w-0 flex-1">
        <h1 className="flex items-center gap-2.5">
          <AtlasMark className="h-6 w-6 shrink-0 text-accent" />
          <span className="display truncate text-display text-ink">World Top Songs</span>
        </h1>
        <p
          aria-live="polite"
          className="chrome-text mt-1.5 truncate pl-[2.125rem] text-small leading-tight text-muted"
        >
          {hovered ? (
            <>
              <span className="tnum text-accent">{hovered.iso}</span>
              <span className="mx-1.5 text-faint">·</span>
              <span className="text-ink">{hovered.name}</span>
              <span className="ml-1.5 text-faint">select</span>
            </>
          ) : (
            <span className="text-ink/80">Drag to spin · select a country · ⌘K to search</span>
          )}
        </p>
      </div>

      <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
        <CountryPicker countries={countries} selectedIso={selectedIso} onPick={onPick} />
        <button
          type="button"
          onClick={onSurprise}
          aria-label="Surprise me"
          title="Surprise me"
          className="btn btn-quiet px-2.5 sm:px-3"
        >
          <Shuffle className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">Surprise me</span>
        </button>
      </div>
    </header>
  );
}
