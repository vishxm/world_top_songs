import { Shuffle } from "lucide-react";
import type { StageCountry } from "./GlobeView";
import CountryPicker, { type PickerRequest } from "./CountryPicker";
import { AtlasMark } from "./ui";

interface Props {
  countries: StageCountry[];
  hovered: StageCountry | null;
  selectedIso: string | null;
  onPick: (c: StageCountry) => void;
  onSurprise: () => void;
  /** Open the picker from elsewhere in the app (the no-chart notice). */
  pickerRequest?: PickerRequest | null;
}

export default function Header({
  countries,
  hovered,
  selectedIso,
  onPick,
  onSurprise,
  pickerRequest,
}: Props) {
  // On wide layouts the chart rail occupies the right edge, so the header keeps
  // its controls clear of it rather than sitting underneath the panel.
  return (
    <header
      className={`pointer-events-none absolute top-0 z-30 flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 lg:p-gutter ${
        selectedIso ? "right-3 left-3 lg:right-[calc(384px+2.5rem)] lg:left-gutter" : "inset-x-0"
      }`}
    >
      {/* Wordmark + live hover readout. `min-w-0` stops the title wrapping into a
          one-word-per-line column on narrow screens. */}
      <div className="pointer-events-auto min-w-0 flex-1">
        <h1 className="flex items-center gap-2.5">
          <AtlasMark className="h-6 w-6 shrink-0 text-accent" />
          <span className="display truncate text-display text-ink">World Top Songs</span>
        </h1>
        <p className="chrome-text mt-1.5 truncate pl-[2.125rem] text-small leading-tight text-muted">
          {hovered ? (
            // Visual chrome, hidden from assistive tech: the live region below
            // announces the country on its own, without the ISO or "select".
            <span aria-hidden="true">
              <span className="tnum text-accent">{hovered.iso}</span>
              <span className="mx-1.5 text-faint">·</span>
              <span className="text-ink">{hovered.name}</span>
              <span className="ml-1.5 text-faint">select</span>
            </span>
          ) : (
            <span className="text-ink/80">Drag to spin · select a country · ⌘K to search</span>
          )}
          {/*
            Hover is announced HERE, not by the paragraph. The paragraph falls
            back to the standing hint the moment the pointer leaves land, so
            making it the live region meant every crossing of water announced
            "Drag to spin · select a country · ⌘K to search" — ocean hover was
            not silent, and the country arrived wrapped in visual chrome
            ("MX · Mexico select"). This region holds the country name and
            nothing else, so it empties without speaking when the pointer is
            over water.
          */}
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {hovered ? hovered.name : ""}
          </span>
        </p>
      </div>

      <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
        <CountryPicker
          countries={countries}
          selectedIso={selectedIso}
          onPick={onPick}
          request={pickerRequest}
        />
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
