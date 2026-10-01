import { useRef } from "react";
import { THEMES, type ThemeId } from "~/hooks/useTheme";

interface Props {
  theme: ThemeId;
  onTheme: (t: ThemeId) => void;
}

/**
 * All four palettes, each one visible and one click away.
 *
 * This replaced a single button that cycled through the four on repeat clicks. The
 * palettes were a real feature but they read as one anonymous icon, so there was no
 * way to know four existed, no way to tell which was active, and no way to jump
 * straight to one — you had to know how many clicks away it was. Four swatches
 * previewing their own colours makes the choice legible at a glance and costs the
 * same space.
 *
 * Semantics are a real `radiogroup`, not four loose buttons: one Tab stop for the
 * whole group, arrow keys to move within it, `aria-checked` for state. A row of four
 * `aria-pressed` toggles would put four tab stops in the header, which is the part
 * of the UI people tab through most.
 *
 * Swatch colours are scoped by `data-swatch` in app.css rather than read from the
 * active theme — a swatch has to show the palette it represents, not the one
 * currently applied, so it cannot inherit those tokens.
 */
export default function PaletteSwitcher({ theme, onTheme }: Props) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const active = THEMES.findIndex((t) => t.id === theme);

  /** Arrow keys move focus AND selection, which is what a radiogroup does. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = THEMES.length - 1;
    else if (step) next = (active + step + THEMES.length) % THEMES.length;
    else return;
    event.preventDefault();
    onTheme(THEMES[next].id);
    buttons.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Colour palette"
      onKeyDown={onKeyDown}
      className="flex items-center gap-1.5 rounded-full border border-line bg-panel/60 p-1 backdrop-blur"
    >
      {THEMES.map((t, i) => {
        const selected = t.id === theme;
        return (
          <button
            key={t.id}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t.label}
            title={t.label}
            tabIndex={selected ? 0 : -1}
            data-swatch={t.id}
            data-active={selected || undefined}
            onClick={() => onTheme(t.id)}
            className="h-4 w-4 rounded-full transition-transform duration-150 ease-out hover:scale-110 focus-visible:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent data-active:scale-110"
          />
        );
      })}
    </div>
  );
}