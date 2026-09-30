import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Globe2, Search, Sparkles, X } from "lucide-react";
import type { Region } from "~/lib/countryMeta";
import { REGIONS } from "~/lib/countryMeta";
import { isChartCountry } from "~/lib/countries";
import type { StageCountry } from "./GlobeView";
import { CountryMark } from "./ui";

interface Props {
  countries: StageCountry[];
  selectedIso: string | null;
  onPick: (c: StageCountry) => void;
}

/** Lower is better. Exact > prefix > word-boundary > substring > subsequence,
 *  so "India" never loses to "British Indian Ocean Territory". */
function score(needle: string, name: string, iso: string): number {
  const n = name.toLowerCase();
  if (iso.toLowerCase() === needle) return -1;
  if (n === needle) return 0;
  if (n.startsWith(needle)) return 1;
  const wordStart = n.search(new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  if (wordStart === 0) return 2;
  if (wordStart > 0) return 3;
  if (n.includes(needle)) return 4;
  // Subsequence: "gbr" -> "Gabon"? no. "jp" -> "Japan" via ISO already.
  let i = 0;
  for (const ch of n) if (ch === needle[i]) i++;
  return i === needle.length ? 5 : Infinity;
}

export default function CountryPicker({ countries, selectedIso, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const sorted = useMemo(
    () => [...countries].sort((a, b) => a.name.localeCompare(b.name)),
    [countries]
  );

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return sorted;
    return sorted
      .map((c) => ({ c, s: score(needle, c.name, c.iso) }))
      .filter((x) => x.s < Infinity)
      .sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name))
      .map((x) => x.c);
  }, [query, sorted]);

  const grouped = useMemo(() => {
    if (query.trim()) return null; // a flat, ranked list reads better while typing
    const byRegion = new Map<Region, StageCountry[]>();
    for (const c of sorted) {
      const list = byRegion.get(c.region) ?? [];
      list.push(c);
      byRegion.set(c.region, list);
    }
    // Flatten in the same order the two lists below render, so a single running
    // counter gives every option its index into `results`.
    const groups: { region: Region; items: StageCountry[] }[] = [];
    let idx = 0;
    for (const region of REGIONS) {
      const list = byRegion.get(region);
      if (!list?.length) continue;
      groups.push({ region, items: list });
      idx += list.length;
    }
    return groups;
  }, [query, sorted]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setCursor(0);
  }, []);

  // Global shortcut. "/" is ignored while the user is typing somewhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  // Keep the active option scrolled into view during keyboard navigation.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const choose = useCallback(
    (c: StageCountry) => {
      onPick(c);
      close();
    },
    [onPick, close]
  );

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter" && results[cursor]) {
      e.preventDefault();
      choose(results[cursor]);
    }
  };

  const selected = countries.find((c) => c.iso === selectedIso);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="glass group flex h-9 items-center gap-2 rounded-xl pr-2.5 pl-2.5 text-[12.5px] transition hover:border-line-bright"
      >
        {selected ? (
          <>
            <CountryMark iso={selected.iso} region={selected.region} size="sm" />
            <span className="max-w-[9rem] truncate font-medium text-ink">{selected.name}</span>
          </>
        ) : (
          <>
            <Search className="h-3.5 w-3.5 text-faint" />
            <span className="text-muted">Pick a country</span>
          </>
        )}
        <kbd className="ml-1 hidden rounded border border-line px-1.5 py-0.5 text-[10px] text-faint sm:inline">
          ⌘K
        </kbd>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh] sm:pt-[16vh]">
          <button
            type="button"
            aria-label="Close country picker"
            onClick={close}
            className="absolute inset-0 bg-void/80 backdrop-blur-sm motion-safe:animate-fade"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Pick a country"
            className="lit glass relative w-full max-w-lg overflow-hidden rounded-panel shadow-lift motion-safe:animate-rise"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
              <Search className="h-4 w-4 shrink-0 text-faint" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onListKeyDown}
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={results[cursor] ? `${listId}-opt` : undefined}
                aria-autocomplete="list"
                placeholder="Search 236 countries…"
                className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-faint"
              />
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition hover:bg-raised hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Countries"
              className="max-h-[52vh] overflow-y-auto overscroll-contain p-1.5"
            >
              {results.length === 0 ? (
                <li className="px-3 py-8 text-center text-[13px] text-muted">
                  No country matches “{query}”.
                </li>
              ) : null}

              {grouped
                ? (() => {
                    let idx = 0;
                    return grouped.map(({ region, items }) => {
                      const start = idx;
                      idx += items.length;
                      return (
                        <li key={region}>
                          <p className="px-2.5 pt-2.5 pb-1 text-[10px] font-semibold tracking-[0.12em] text-faint uppercase">
                            {region}
                            <span className="tnum ml-1.5 text-faint/60">{items.length}</span>
                          </p>
                          <ul role="group" aria-label={region}>
                            {items.map((c, i) => (
                              <Option
                                key={c.iso}
                                listId={listId}
                                country={c}
                                idx={start + i}
                                active={start + i === cursor}
                                selected={c.iso === selectedIso}
                                onHover={setCursor}
                                onChoose={choose}
                              />
                            ))}
                          </ul>
                        </li>
                      );
                    });
                  })()
                : results.map((c, i) => (
                    <Option
                      key={c.iso}
                      listId={listId}
                      country={c}
                      idx={i}
                      active={i === cursor}
                      selected={c.iso === selectedIso}
                      onHover={setCursor}
                      onChoose={choose}
                    />
                  ))}
            </ul>

            <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[10.5px] text-faint">
              <span className="flex items-center gap-1.5">
                <kbd className="rounded border border-line px-1">↑↓</kbd> move
                <kbd className="rounded border border-line px-1">↵</kbd> select
                <kbd className="rounded border border-line px-1">esc</kbd> close
              </span>
              <span className="tnum">{results.length} countries</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Option({
  listId,
  country,
  idx,
  active,
  selected,
  onHover,
  onChoose,
}: {
  listId: string;
  country: StageCountry;
  idx: number;
  active: boolean;
  selected: boolean;
  onHover: (idx: number) => void;
  onChoose: (c: StageCountry) => void;
}) {
  return (
    <li role="option" aria-selected={active} id={`${listId}-opt`} data-idx={idx}>
      <button
        type="button"
        onClick={() => onChoose(country)}
        onMouseMove={() => onHover(idx)}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition ${
          active ? "bg-accent/12 text-ink" : "text-muted hover:bg-raised"
        }`}
      >
        <CountryMark iso={country.iso} region={country.region} size="sm" />
        <span className="min-w-0 flex-1 truncate text-[13px]">{country.name}</span>
        {isChartCountry(country.iso) ? (
          <span
            title="Has its own weekly chart"
            className="shrink-0 text-faint"
            aria-label="Has its own weekly chart"
          >
            <Sparkles className="h-3 w-3" />
          </span>
        ) : (
          <span title="Uses the Spotify fallback" aria-label="Uses the Spotify fallback">
            <Globe2 className="h-3 w-3 text-faint/50" />
          </span>
        )}
        {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" /> : null}
      </button>
    </li>
  );
}
