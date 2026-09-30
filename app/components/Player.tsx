import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartTrack } from "~/lib/analyticsCharts";

interface Props {
  tracks: ChartTrack[];
  activeIndex: number | null;
  onSelect: (index: number) => void;
  onEnded: () => void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement,
        opts: {
          videoId?: string;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: () => void;
            onStateChange?: (e: { data: number }) => void;
            onError?: () => void;
          };
        }
      ) => YTPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface YTPlayer {
  loadVideoById(id: string): void;
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
  setSize(w: number, h: number): void;
}

const ENDED = 0;
const PLAYING = 1;

let apiPromise: Promise<void> | null = null;
function loadApi(): Promise<void> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    }
  });
  return apiPromise;
}

export default function Player({ tracks, activeIndex, onSelect, onEnded }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [apiReady, setApiReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const endedRef = useRef(onEnded);
  useEffect(() => {
    endedRef.current = onEnded;
  }, [onEnded]);

  const active = activeIndex != null ? tracks[activeIndex] : null;

  // Keep the compact frame filled: size the iframe to the wrapper,
  // on ready and on every resize.
  const fitPlayer = useCallback(() => {
    const p = playerRef.current;
    const w = wrapRef.current;
    if (p && typeof p.setSize === "function" && w) {
      p.setSize(w.clientWidth, w.clientHeight);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("resize", fitPlayer);
    return () => window.removeEventListener("resize", fitPlayer);
  }, [fitPlayer]);

  useEffect(() => {
    let cancelled = false;
    loadApi().then(() => {
      if (!cancelled) setApiReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Tear down on unmount (e.g. country switch) so audio never leaks.
  useEffect(() => {
    return () => {
      try {
        playerRef.current?.destroy();
      } catch {
        /* already gone */
      }
      playerRef.current = null;
    };
  }, []);

  // Create the player on a FRESH container div each time. The YT constructor
  // replaces its target node with an iframe, so reusing a node across
  // (StrictMode double-)mounts yields a detached node and a broken player.
  useEffect(() => {
    if (!apiReady || !active || !wrapRef.current) return;
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.inset = "0";
    wrapRef.current.appendChild(el);
    const player = new window.YT!.Player(el, {
      videoId: active.videoId,
      playerVars: { rel: 0, modestbranding: 1, autoplay: 1 },
      events: {
        onReady: () => fitPlayer(),
        onStateChange: (e) => {
          if (e.data === ENDED) endedRef.current();
          else setPlaying(e.data === PLAYING);
        },
        onError: () => endedRef.current(), // skip unavailable videos
      },
    });
    playerRef.current = player;
    return () => {
      playerRef.current = null;
      try {
        player.destroy();
      } catch {
        /* already gone */
      }
      el.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReady, active != null]);

  // Load subsequent tracks (guarded: never crash on a half-ready player).
  const activeId = active?.videoId;
  useEffect(() => {
    const p = playerRef.current;
    if (activeId && p && typeof p.loadVideoById === "function") {
      p.loadVideoById(activeId);
    }
  }, [activeId]);

  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (!p || typeof p.playVideo !== "function" || typeof p.pauseVideo !== "function") return;
    if (playing) p.pauseVideo();
    else p.playVideo();
  }, [playing]);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (activeIndex == null) return;
      onSelect((activeIndex + dir + tracks.length) % tracks.length);
    },
    [activeIndex, onSelect, tracks.length]
  );

  if (!active) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-black/60 p-3 backdrop-blur">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
        {!apiReady && (
          <img
            src={active.thumbnail}
            alt=""
            className="absolute inset-0 h-full w-full animate-pulse object-cover"
          />
        )}
        <div ref={wrapRef} className="absolute inset-0 [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:h-full [&>iframe]:w-full" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => step(-1)}
          className="rounded-full bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
          aria-label="Previous track"
        >
          ⏮
        </button>
        <button
          onClick={toggle}
          className="rounded-full bg-blue-500 px-4 py-1.5 text-sm font-semibold hover:bg-blue-400"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button
          onClick={() => step(1)}
          className="rounded-full bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
          aria-label="Next track"
        >
          ⏭
        </button>
        <div className="ml-1 min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">
            #{active.rank} {active.title}
          </p>
          <p className="truncate text-xs text-zinc-400">{active.artists}</p>
        </div>
      </div>
    </div>
  );
}
