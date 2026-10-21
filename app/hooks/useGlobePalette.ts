import { useEffect, useState } from "react";

/**
 * Canvas-only colours.
 *
 * three-globe needs concrete colour strings, so these cannot be Tailwind
 * classes. The values live in `app.css` beside the rest of the design system
 * and are read once from the document, rather than duplicated in JS — there is
 * one theme now, so nothing ever needs to re-read or re-skin them.
 */
export interface GlobePalette {
  cap: string;
  capDim: string;
  capHover: string;
  capSelected: string;
  /** Crisp traced edge around the selected country. See OUTLINE_ALTITUDE. */
  capOutline: string;
  border: string;
  atmosphere: string;
}

const FALLBACK: GlobePalette = {
  cap: "rgba(190, 196, 178, 0.18)",
  capDim: "rgba(160, 166, 152, 0.075)",
  capHover: "rgba(236, 229, 208, 0.48)",
  capSelected: "rgba(217, 166, 75, 0.93)",
  capOutline: "#f1d29a",
  border: "#b9c0ae",
  atmosphere: "#6f7468",
};

export function useGlobePalette(): GlobePalette {
  const [palette, setPalette] = useState<GlobePalette>(FALLBACK);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    setPalette({
      cap: read("--globe-cap", FALLBACK.cap),
      capDim: read("--globe-cap-dim", FALLBACK.capDim),
      capHover: read("--globe-cap-hover", FALLBACK.capHover),
      capSelected: read("--globe-cap-selected", FALLBACK.capSelected),
      capOutline: read("--globe-cap-outline", FALLBACK.capOutline),
      border: read("--globe-border", FALLBACK.border),
      atmosphere: read("--globe-atmosphere", FALLBACK.atmosphere),
    });
  }, []);

  return palette;
}
