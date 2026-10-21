import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Search, X } from "lucide-react";
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

/**
 * Everyday names that appear in neither the display name nor the ISO code.
 * Deliberately small: this is a convenience for the handful of countries people
 * type by another name, not a translation layer.
 */
const ALIASES: Record<string, readonly string[]> = {
  AE: ["uae"],
  CI: ["ivory coast"],
  CZ: ["czech republic"],
  GB: ["uk", "britain", "england"],
  MM: ["burma"],
  NL: ["holland"],
  US: ["usa", "america"],
};

/**
 * Fold case and diacritics, so "cote" finds "Côte d'Ivoire" and "aland" finds
 * "Åland Islands". Punctuation is kept: the subsequence fallback below lets
 * "cote divoire" skip the apostrophe.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** A character that starts a new word, so a hit after it outranks a mid-word one. */
const WORD_BOUNDARY = /[\s'’.\-&(/]/;

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

interface Entry {
  country: StageCountry;
  iso: string;
  name: string;
  aliases: string[];
}

/**
 * Lower is better. ISO code outranks name and an exact hit outranks a prefix,
 * so "in" offers India before Indonesia and "gb" finds the United Kingdom even
 * though those letters are nowhere in its name. A subsequence match is the last
 * resort — it keeps a compressed query like "untdst" useful without letting
 * "India" lose to "British Indian Ocean Territory".
 */
function rank(needle: string, entry: Entry): number {
  if (entry.iso === needle) return 0;
  if (entry.aliases.includes(needle)) return 1;
  if (entry.iso.startsWith(needle)) return 2;

  let best = Infinity;
  for (const name of [entry.name, ...entry.aliases]) {
    const score = rankName(needle, name);
    if (score < best) best = score;
  }
  return best;
}

function rankName(needle: string, name: string): number {
  if (name === needle) return 3;
  if (name.startsWith(needle)) return 4;

  let at = name.indexOf(needle);
  if (at >= 0) {
    while (at >= 0) {
      if (WORD_BOUNDARY.test(name[at - 1])) return 5;
      at = name.indexOf(needle, at + 1);
    }
    return 6;
  }

  // Subsequence matching on one character turns the list into noise; the prefix
  // and substring ranks above already cover every useful single-letter query.
  return needle.length >= 2 && isSubsequence(needle, name) ? 7 : Infinity;
}

export default function CountryPicker({ countries, selectedIso, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const entries = useMemo<Entry[]>(
    () =>
      [...countries]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((country) => ({
          country,
          iso: country.iso.toLowerCase(),
          name: fold(country.name),
          aliases: (ALIASES[country.iso] ?? []).map(fold),
        })),
    [countries]
  );

  const results = useMemo(() => {
    const needle = fold(query.trim());
    if (!needle) return entries;
    return entries
      .map((entry) => ({ entry, score: rank(needle, entry) }))
      .filter((x) => x.score < Infinity)
      .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name))
      .map((x) => x.entry);
  }, [entries, query]);

  const grouped = useMemo(() => {
    if (query.trim()) return null; // a flat, ranked list reads better while typing
    const byRegion = new Map<Region, Entry[]>();
    for (const entry of entries) {
      const list = byRegion.get(entry.country.region) ?? [];
      list.push(entry);
      byRegion.set(entry.country.region, list);
    }
    // Flatten in the same order the groups render, so one running counter gives
    // every option its index into `visible`.
    const groups: { region: Region; items: Entry[]; start: number }[] = [];
    let start = 0;
    for (const region of REGIONS) {
      const list = byRegion.get(region);
      if (!list?.length) continue;
      groups.push({ region, items: list, start });
      start += list.length;
    }
    return groups;
  }, [entries, query]);

  /**
   * The order the list is actually rendered in: region order while grouped,
   * ranked order while filtering. Keyboard selection reads from this rather
   * than from `results` — when the query is empty the two orders differ, and
   * Enter would otherwise pick whichever country happens to be first
   * alphabetically rather than the option that is highlighted.
   */
  const visible = useMemo(
    () => (grouped ? grouped.flatMap((group) => group.items) : results),
    [grouped, results]
  );

  const close = useCallback(() => setOpen(false), []);

  // Global shortcut. "/" is ignored while the user is typing somewhere else;
  // ⌘K/Ctrl-K is the escape hatch from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset on every close, whichever way it happened — Escape, a selection, a
  // backdrop click, or the shortcut pressed a second time. Reopening always
  // starts with the region-grouped list rather than yesterday's search.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setCursor(0);
  }, [open]);

  // Focus the search box while open, lock the page behind the dialog, and put
  // focus back on the trigger on close so a keyboard user is never dropped on
  // the body.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      if (wasOpen.current) {
        wasOpen.current = false;
        triggerRef.current?.focus();
      }
      return;
    }
    wasOpen.current = true;
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  // Keep the active option in view during keyboard navigation.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  const choose = useCallback(
    (country: StageCountry) => {
      onPick(country);
      close();
    },
    [onPick, close]
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((i) => (visible.length ? (i + 1) % visible.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((i) => (visible.length ? (i - 1 + visible.length) % visible.length : 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setCursor(Math.max(0, visible.length - 1));
    } else if (e.key === "Enter" && visible[cursor]) {
      e.preventDefault();
      choose(visible[cursor].country);
    }
  };

  // Escape closes from anywhere in the dialog, and Tab cycles between the only
  // two focusable elements rather than escaping into the page behind it.
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("input, button");
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const selected = countries.find((c) => c.iso === selectedIso);
  const emptyMessage =
    countries.length === 0
      ? "Loading countries…"
      : query.trim()
        ? `No country matches “${query.trim()}”.`
        : "No countries are available.";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={selected ? `Change country, currently ${selected.name}` : "Pick a country"}
        className="btn btn-quiet h-9 gap-2 px-2.5 text-small"
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
        <kbd className="kbd ml-1 hidden sm:inline-flex">⌘K</kbd>
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh] sm:pt-[16vh]">
              <button
                type="button"
                tabIndex={-1}
                aria-label="Close country picker"
                onClick={close}
                className="absolute inset-0 bg-void/78 motion-safe:animate-fade"
              />
              <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="Pick a country"
                onKeyDown={onDialogKeyDown}
                className="surface-pop relative w-full max-w-lg overflow-hidden motion-safe:animate-rise"
              >
                <div className="flex items-center gap-2.5 border-b border-line px-4 py-3 ring-inset transition-colors focus-within:bg-raised/30 focus-within:ring-1 focus-within:ring-accent/35">
                  <Search className="h-4 w-4 shrink-0 text-faint" />
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onInputKeyDown}
                    role="combobox"
                    aria-expanded="true"
                    aria-controls={listId}
                    aria-activedescendant={visible[cursor] ? `${listId}-opt-${cursor}` : undefined}
                    aria-autocomplete="list"
                    aria-label="Search countries"
                    placeholder={
                      countries.length > 0
                        ? `Search ${countries.length} countries…`
                        : "Search countries…"
                    }
                    className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-faint"
                  />
                  <button
                    type="button"
                    onClick={close}
                    aria-label="Close"
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-[0.3125rem] text-faint transition hover:bg-raised hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div
                  ref={listRef}
                  id={listId}
                  role="listbox"
                  aria-label="Countries"
                  className="max-h-[52vh] overflow-y-auto overscroll-contain p-1.5"
                >
                  {grouped
                    ? grouped.map(({ region, items, start }) => (
                        <div key={region} role="group" aria-label={region}>
                          <p className="eyebrow px-2.5 pt-2.5 pb-1">
                            {region}
                            <span className="tnum ml-1.5 text-faint/60">{items.length}</span>
                          </p>
                          {items.map((entry, i) => (
                            <Option
                              key={entry.country.iso}
                              listId={listId}
                              entry={entry}
                              idx={start + i}
                              active={start + i === cursor}
                              selected={entry.country.iso === selectedIso}
                              onHover={setCursor}
                              onChoose={choose}
                            />
                          ))}
                        </div>
                      ))
                    : results.map((entry, i) => (
                        <Option
                          key={entry.country.iso}
                          listId={listId}
                          entry={entry}
                          idx={i}
                          active={i === cursor}
                          selected={entry.country.iso === selectedIso}
                          onHover={setCursor}
                          onChoose={choose}
                        />
                      ))}
                </div>

                {visible.length === 0 ? (
                  <p role="status" className="px-3 py-8 text-center text-small text-muted">
                    {emptyMessage}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-line px-4 py-2 text-micro text-faint">
                  <span className="hidden items-center gap-1.5 sm:flex">
                    <kbd className="kbd">↑↓</kbd> move
                    <kbd className="kbd">↵</kbd> select
                    <kbd className="kbd">esc</kbd> close
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-muted" />
                      Charted
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full border border-faint/70" />
                      Uncharted
                    </span>
                  </span>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function Option({
  listId,
  entry,
  idx,
  active,
  selected,
  onHover,
  onChoose,
}: {
  listId: string;
  entry: Entry;
  idx: number;
  active: boolean;
  selected: boolean;
  onHover: (idx: number) => void;
  onChoose: (country: StageCountry) => void;
}) {
  const { country } = entry;
  const charted = isChartCountry(country.iso);

  return (
    <div
      role="option"
      id={`${listId}-opt-${idx}`}
      data-idx={idx}
      data-iso={country.iso}
      aria-selected={selected}
      aria-label={`${country.name}, ${charted ? "has an official chart" : "no official chart"}`}
      onClick={() => onChoose(country)}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => onHover(idx)}
      className={`flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left transition ${
        active ? "bg-raised text-ink" : "text-muted hover:bg-raised/60"
      }`}
    >
      <CountryMark iso={country.iso} region={country.region} size="sm" />
      <span className={`min-w-0 flex-1 truncate text-small ${selected ? "text-ink" : ""}`}>
        {country.name}
      </span>
      {/* Quiet availability mark: filled for a country with an official chart,
          hollow for one without. The footer legend names both. */}
      <span aria-hidden className="grid w-3 shrink-0 place-items-center">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            charted ? "bg-muted" : "border border-faint/70"
          }`}
        />
      </span>
      <span className="grid w-3.5 shrink-0 place-items-center">
        {selected ? <Check aria-hidden className="h-3.5 w-3.5 text-accent" /> : null}
      </span>
    </div>
  );
}
