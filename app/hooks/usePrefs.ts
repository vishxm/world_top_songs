import { useEffect, useState } from "react";

/** Live `prefers-reduced-motion`. Everything animated subscribes to this so the
 *  globe stops spinning, fly-to becomes instant and the equalizer freezes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return reduced;
}

/** Matches a media query by name, re-rendering on change. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** localStorage-backed state that never throws (private mode, SSR, quota).
 *  The stored string is untrusted, so the initial value stays the type anchor. */
export function useStoredState(key: string, initial: string) {
  const [value, setValue] = useState<string>(initial);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(raw);
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  }, [key, value, hydrated]);

  return [value, setValue] as const;
}
