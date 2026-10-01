import { Dices } from "lucide-react";
import type { ThemeId } from "~/hooks/useTheme";
import type { StageCountry } from "./GlobeView";
import CountryPicker from "./CountryPicker";
import PaletteSwitcher from "./PaletteSwitcher";
import { IconButton } from "./ui";

interface Props {
  countries: StageCountry[];
  hovered: StageCountry | null;
  selectedIso: string | null;
  theme: ThemeId;
  onPick: (c: StageCountry) => void;
  onSurprise: () => void;
  onTheme: (t: ThemeId) => void;
}

export default function Header({
  countries,
  hovered,
  selectedIso,
  theme,
  onPick,
  onSurprise,
  onTheme,
}: Props) {
  // On wide layouts the chart rail occupies the right edge, so the header keeps
  // its controls clear of it rather than sitting underneath the panel.
  return (
    <header
      className={`pointer-events-none absolute top-0 z-30 flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:p-5 ${
        selectedIso ? "right-3 left-3 sm:right-[calc(384px+2.5rem)] sm:left-5" : "inset-x-0"
      }`}
    >
      {/* Wordmark + live hover readout. min-w-0 stops the title wrapping into a
          one-word-per-line column on narrow screens (the old bug). */}
      <div className="pointer-events-auto min-w-0 flex-1">
        <h1 className="flex items-center gap-2">
          <span
            aria-hidden
            className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-linear-to-br from-accent to-live"
          >
            <span className="h-2 w-2 rounded-full bg-void" />
          </span>
          <span className="display truncate text-[19px] leading-none font-semibold tracking-tight text-ink sm:text-[22px]">
            World Top Songs
          </span>
        </h1>
        <p
          aria-live="polite"
          className="mt-1.5 truncate pl-9 text-[12px] leading-tight text-muted"
        >
          {hovered ? (
            <>
              <span className="tnum text-accent">{hovered.iso}</span>
              <span className="mx-1.5 text-faint">·</span>
              <span className="text-ink">{hovered.name}</span>
              <span className="ml-1.5 text-faint">click to load its chart</span>
            </>
          ) : (
            <span className="text-faint">Drag to spin · click a country · or press ⌘K</span>
          )}
        </p>
      </div>

      <div className="pointer-events-auto flex shrink-0 items-center gap-2">
        <CountryPicker countries={countries} selectedIso={selectedIso} onPick={onPick} />
        <IconButton label="Surprise me" onClick={onSurprise}>
          <Dices className="h-4 w-4" />
        </IconButton>
        <PaletteSwitcher theme={theme} onTheme={onTheme} />
      </div>
    </header>
  );
}
