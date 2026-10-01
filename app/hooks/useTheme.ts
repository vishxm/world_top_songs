import { useCallback, useEffect, useState } from "react";

export const THEMES = [
  { id: "mission", label: "Mission control" },
  { id: "analog", label: "Warm analog" },
  { id: "daylight", label: "Bright cartographic" },
  { id: "observatory", label: "Deep space" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const STORAGE_KEY = "wts.theme";
const DEFAULT_THEME: ThemeId = "mission";

function readStored(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return (THEMES.some((t) => t.id === v) ? v : DEFAULT_THEME) as ThemeId;
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);

  // Hydrate after mount so SSR and the first client render agree.
  useEffect(() => {
    const stored = readStored();
    setThemeState(stored);
    document.documentElement.dataset.theme = stored;
  }, []);

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode */
    }
  }, []);

  return { theme, setTheme };
}

export interface ThemeTokens {
  accent: string;
  accentSoft: string;
  accentInk: string;
  /** Canvas-only colours: three-globe needs concrete strings, so these are
   *  declared as their own set in app.css and re-skinned per theme. */
  globe: {
    cap: string;
    capDim: string;
    capHover: string;
    capSelected: string;
    /** Crisp traced edge around the selected country. See OUTLINE_ALTITUDE. */
    capOutline: string;
    border: string;
    atmosphere: string;
  };
}

const FALLBACK: ThemeTokens = {
  accent: "#f5a524",
  accentSoft: "#ffd08a",
  accentInk: "#1a1204",
  globe: {
    cap: "rgba(150, 180, 222, 0.16)",
    capDim: "rgba(125, 154, 196, 0.075)",
    capHover: "rgba(205, 226, 252, 0.5)",
    capSelected: "rgba(255, 214, 124, 0.93)",
    capOutline: "#ffe9b0",
    border: "#a8c4e8",
    atmosphere: "#f5a524",
  },
};

/** Read resolved palette values out of CSS so the canvas can be tinted by the
 *  active theme without duplicating any colour constants in JS. */
export function useThemeTokens(theme: ThemeId): ThemeTokens {
  const [tokens, setTokens] = useState<ThemeTokens>(FALLBACK);
  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    setTokens({
      accent: read("--color-accent", FALLBACK.accent),
      accentSoft: read("--color-accent-soft", FALLBACK.accentSoft),
      accentInk: read("--color-accent-ink", FALLBACK.accentInk),
      globe: {
        cap: read("--globe-cap", FALLBACK.globe.cap),
        capDim: read("--globe-cap-dim", FALLBACK.globe.capDim),
        capHover: read("--globe-cap-hover", FALLBACK.globe.capHover),
        capSelected: read("--globe-cap-selected", FALLBACK.globe.capSelected),
        capOutline: read("--globe-cap-outline", FALLBACK.globe.capOutline),
        border: read("--globe-border", FALLBACK.globe.border),
        atmosphere: read("--globe-atmosphere", FALLBACK.globe.atmosphere),
      },
    });
  }, [theme]);
  return tokens;
}
