import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CountryFeature } from "./GlobeView";
import { flagEmoji } from "~/lib/countries";

interface Props {
  countries: CountryFeature[];
  quickList: CountryFeature[];
  onPick: (c: CountryFeature) => void;
}

export default memo(function SearchBar({ countries, quickList, onPick }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return quickList;
    // Rank: exact match, then prefix, then substring — so "India" never
    // loses to "Br. Indian Ocean Ter.".
    const scored = countries
      .map((c) => {
        const n = c.name.toLowerCase();
        if (n === needle) return { c, s: 0 };
        if (n.startsWith(needle)) return { c, s: 1 };
        if (n.includes(needle)) return { c, s: 2 };
        if (c.iso.toLowerCase() === needle) return { c, s: 0 };
        return null;
      })
      .filter((x): x is { c: CountryFeature; s: number } => x != null)
      .sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name));
    return scored.slice(0, 8).map((x) => x.c);
  }, [q, countries, quickList]);

  const showQuick = q.trim().length < 2;

  return (
    <div ref={boxRef} className="relative w-56 sm:w-64">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search country…"
        className="w-full rounded-full border border-white/15 bg-black/60 px-4 py-2 text-sm text-white placeholder-zinc-500 backdrop-blur outline-none focus:border-blue-400"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-2 max-h-64 w-full overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/95 p-1 shadow-2xl backdrop-blur-xl">
          {showQuick && (
            <li className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Top charts
            </li>
          )}
          {results.map((c) => (
            <li key={c.iso + c.name}>
              <button
                onClick={() => {
                  onPick(c);
                  setOpen(false);
                  setQ("");
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 hover:bg-white/10"
              >
                <span>{flagEmoji(c.iso)}</span>
                <span className="truncate">{c.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
