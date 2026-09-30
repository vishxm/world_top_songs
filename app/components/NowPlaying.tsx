import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartTrack } from "~/lib/analyticsCharts";
import { fmtDuration } from "~/lib/format";

interface Props {
  tracks: ChartTrack[];
  activeIndex: number | null;
  onSelect: (index: number) => void;
  onEnded: () => void;
  onPlayingChange?: (playing: boolean) => void;
}

// ---------------------------------------------------------------------------
// YouTube IFrame API plumbing.
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement,
        opts: {
          videoId?: string;
          width?: number | string;
          height?: number | string;
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
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  destroy(): void;
  setSize(w: number, h: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoLoadedFraction(): number;
  getVolume(): number;
  setVolume(v: number): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
}

const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;

/** Range is 0..1000 so a 120ms poll lands on whole permille without jitter. */
const RANGE_MAX = 1000;

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
      s.async = true;
      document.head.appendChild(s);
    }
  });
  return apiPromise;
}

const DEFAULT_VOLUME = 100;

const PATHS = {
  play: "M8 5.14v13.72a1 1 0 0 0 1.52.85l11.14-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z",
  pause: "M7 4h3.5v16H7zM13.5 4H17v16h-3.5z",
  prev: "M7 5h2.4v14H7zM19.5 5.86v12.28a1 1 0 0 1-1.54.84l-9.2-6.14a1 1 0 0 1 0-1.68l9.2-6.14a1 1 0 0 1 1.54.84Z",
  next: "M14.6 5H17v14h-2.4zM4.5 5.86 13.7 12l-9.2 6.14A1 1 0 0 1 3 17.14V6.86a1 1 0 0 1 1.5-.84Z",
  volume: "M11 4.5 6.6 8H3.5A1.5 1.5 0 0 0 2 9.5v5A1.5 1.5 0 0 0 3.5 16h3.1L11 19.5a.8.8 0 0 0 1.3-.62V5.12a.8.8 0 0 0-1.3-.62Z",
  muted:
    "M11 4.5 6.6 8H3.5A1.5 1.5 0 0 0 2 9.5v5A1.5 1.5 0 0 0 3.5 16h3.1L11 19.5a.8.8 0 0 0 1.3-.62V5.12a.8.8 0 0 0-1.3-.62ZM15.1 9.3a1 1 0 1 1 1.4 0l1.3 1.3 1.3-1.3a1 1 0 1 1 1.4 1.4L19.2 12l1.3 1.3a1 1 0 0 1-1.4 1.4l-1.3-1.3-1.3 1.3a1 1 0 0 1-1.4-1.4l1.3-1.3-1.3-1.3a1 1 0 0 1 0-1.4Z",
  collapse: "M9 4v5H4V7h3V4zm11 0v3h-3v2h5V4zM4 15h5v5H7v-3H4zm16 0v5h-5v-2h3v-3z",
  video: "M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v11A2.5 2.5 0 0 1 13.5 20h-7A2.5 2.5 0 0 1 4 17.5zM17.5 10.2 22 7.6v8.8l-4.5-2.6z",
} as const;

function Icon({ d, className = "h-4 w-4" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d={d} />
    </svg>
  );
}

export default function NowPlaying({ tracks, activeIndex, onSelect, onEnded, onPlayingChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const bufferedRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const endedRef = useRef(onEnded);
  const [apiReady, setApiReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [muted, setMuted] = useState(false);
  /** 0–100, the IFrame API's own scale. Keeping anything else here silently
   *  plays at a fraction of the intended volume — `setVolume(0.8)` is 0.8%, not
   *  80%, which is why the player used to sound like a whisper. */
  const [volume, setVolume] = useState(DEFAULT_VOLUME);
  const [videoOpen, setVideoOpen] = useState(false);
  /** Set when the browser refuses to autoplay; we then wait for a real click. */
  const [needsGesture, setNeedsGesture] = useState(false);

  useEffect(() => {
    endedRef.current = onEnded;
  }, [onEnded]);

  // Lift playback state to the parent so the chart row can show its equalizer.
  const playingRef = useRef(onPlayingChange);
  useEffect(() => {
    playingRef.current = onPlayingChange;
  }, [onPlayingChange]);
  useEffect(() => {
    playingRef.current?.(playing);
  }, [playing]);

  const active = activeIndex != null ? tracks[activeIndex] : null;
  const activeId = active?.videoId;

  // The user's intent, mirrored into refs so the callbacks below can read it
  // without being re-created — re-creating them would tear the player down.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  /**
   * Re-assert the audio state the UI is showing, onto the player.
   *
   * This cannot be a one-shot. Chrome and Safari block audible autoplay, and
   * YouTube's response is to start the video *muted and stay there* — which is
   * exactly the "why is it silent" report. The IFrame API has no volume or mute
   * playerVars, so the only cure is to push the state again every time the
   * player reports something. Writes are guarded, so this is a no-op once the
   * browser agrees.
   */
  const syncAudio = useCallback((p?: YTPlayer | null) => {
    const player = p ?? playerRef.current;
    if (!player) return;
    try {
      if (mutedRef.current) {
        player.mute();
        return;
      }
      if (player.isMuted()) player.unMute();
      if (player.getVolume() !== volumeRef.current) player.setVolume(volumeRef.current);
    } catch {
      /* not ready */
    }
  }, []);

  const fitPlayer = useCallback(() => {
    const p = playerRef.current;
    const w = wrapRef.current;
    if (p && typeof p.setSize === "function" && w && w.clientWidth > 0) {
      p.setSize(w.clientWidth, w.clientHeight);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadApi().then(() => {
      if (!cancelled) setApiReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Create the player on a FRESH container each time: the YT constructor
   * replaces its target node with an iframe, so reusing a node across
   * (StrictMode double-)mounts leaves a detached node and a broken player.
   *
   * The key point is that this effect keys on `activeId` alone — not on the
   * track list. The player is a sibling of the chart panel, so switching country
   * leaves this component mounted and the audio untouched.
   */
  useEffect(() => {
    if (!apiReady || !activeId || !wrapRef.current) return;
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.inset = "0";
    wrapRef.current.appendChild(el);
    setNeedsGesture(false);
    const player = new window.YT!.Player(el, {
      videoId: activeId,
      playerVars: {
        rel: 0,
        modestbranding: 1,
        autoplay: 1,
        playsinline: 1,
        iv_load_policy: 3,
      },
      events: {
        onReady: () => {
          fitPlayer();
          syncAudio(player);
        },
        onStateChange: (e) => {
          if (e.data === ENDED) {
            setPlaying(false);
            endedRef.current();
          } else if (e.data === PLAYING) {
            setPlaying(true);
            setBuffering(false);
            syncAudio(player);
            // If the autoplay policy held the mute anyway, say so rather than
            // showing an unmuted speaker over silent audio — the button becomes
            // the gesture that unlocks sound.
            try {
              setNeedsGesture(!mutedRef.current && player.isMuted());
            } catch {
              setNeedsGesture(false);
            }
          } else if (e.data === PAUSED) {
            setPlaying(false);
          } else if (e.data === BUFFERING) {
            setBuffering(true);
          }
        },
        // Unavailable videos are skipped rather than left dead.
        onError: () => {
          setPlaying(false);
          endedRef.current();
        },
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
  }, [apiReady, activeId != null]);

  // Load subsequent tracks into the existing player.
  useEffect(() => {
    const p = playerRef.current;
    if (activeId && p && typeof p.loadVideoById === "function") p.loadVideoById(activeId);
  }, [activeId]);

  // Progress is written straight to the DOM on a timer. Re-rendering React eight
  // times a second just to move a bar is exactly what makes players feel cheap.
  useEffect(() => {
    if (!activeId) return;
    const id = setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      const now = p.getCurrentTime?.() ?? 0;
      const dur = p.getDuration?.() ?? 0;
      const frac = dur > 0 ? Math.min(1, now / dur) : 0;
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${frac})`;
      if (bufferedRef.current) {
        bufferedRef.current.style.transform = `scaleX(${Math.min(1, p.getVideoLoadedFraction?.() ?? 0)})`;
      }
      if (timeRef.current) {
        timeRef.current.textContent = dur > 0 ? `${fmtDuration(now)} / ${fmtDuration(dur)}` : fmtDuration(now);
      }
      const range = rangeRef.current;
      if (range) {
        range.value = String(Math.round(frac * RANGE_MAX));
        range.setAttribute("aria-valuetext", dur > 0 ? `${fmtDuration(now)} of ${fmtDuration(dur)}` : fmtDuration(now));
      }
    }, 120);
    return () => clearInterval(id);
  }, [activeId]);

  useEffect(() => {
    window.addEventListener("resize", fitPlayer);
    return () => window.removeEventListener("resize", fitPlayer);
  }, [fitPlayer]);

  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (!p || typeof p.playVideo !== "function") return;
    if (needsGesture) {
      setNeedsGesture(false);
      // Inside a real gesture, un-muting sticks. This is the click that turns
      // the volume on.
      syncAudio();
      p.playVideo();
      return;
    }
    if (playing) p.pauseVideo();
    else p.playVideo();
  }, [playing, needsGesture, syncAudio]);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (activeIndex == null) return;
      onSelect((activeIndex + dir + tracks.length) % tracks.length);
    },
    [activeIndex, onSelect, tracks.length]
  );

  const seekToFraction = useCallback((frac: number) => {
    const p = playerRef.current;
    const dur = p?.getDuration?.() ?? 0;
    if (p && dur > 0 && typeof p.seekTo === "function") p.seekTo(frac * dur, true);
  }, []);

  const changeVolume = useCallback(
    (v: number) => {
      volumeRef.current = v;
      setVolume(v);
      mutedRef.current = v === 0;
      setMuted(v === 0);
      syncAudio();
    },
    [syncAudio]
  );

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    setNeedsGesture(false);
    syncAudio();
  }, [syncAudio]);

  if (!active) return null;

  return (
    <section aria-label="Now playing" className="lit glass overflow-hidden rounded-panel">
      {/* Video expands on demand instead of permanently occupying a 16:9 box. */}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          videoOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <div className="relative aspect-video w-full bg-black">
            {!apiReady ? (
              <img
                src={active.thumbnail}
                alt=""
                className="absolute inset-0 h-full w-full object-cover opacity-60"
              />
            ) : null}
            <div
              ref={wrapRef}
              className="absolute inset-0 [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:h-full [&>iframe]:w-full"
            />
            <button
              type="button"
              onClick={() => setVideoOpen(false)}
              aria-label="Hide video"
              className="absolute top-2 right-2 grid h-7 w-7 place-items-center rounded-lg bg-void/70 text-ink backdrop-blur transition hover:bg-void"
            >
              <Icon d={PATHS.collapse} className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="px-3 pt-3 pb-2.5">
        {/* Scrubber. The native range input is transparent and sits on top of the
            painted rail, so keyboard, drag and screen-reader semantics are free
            while the visuals stay driven by direct DOM writes. */}
        <div className="relative -mx-1 h-4">
          <span className="pointer-events-none absolute inset-x-1 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-raised">
            <span
              ref={bufferedRef}
              className="absolute inset-0 origin-left scale-x-0 rounded-full bg-line-bright"
            />
            <span
              ref={fillRef}
              className="absolute inset-0 origin-left scale-x-0 rounded-full bg-accent"
            />
          </span>
          <input
            ref={rangeRef}
            type="range"
            min={0}
            max={RANGE_MAX}
            defaultValue={0}
            aria-label="Seek"
            onChange={(e) => seekToFraction(Number(e.target.value) / RANGE_MAX)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 focus-visible:opacity-0"
          />
        </div>

        <div className="mt-2 flex items-center gap-2.5">
          <span ref={timeRef} className="tnum w-[76px] shrink-0 text-[10.5px] text-faint">
            0:00
          </span>

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Previous track"
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-raised hover:text-ink"
            >
              <Icon d={PATHS.prev} />
            </button>
            <button
              type="button"
              onClick={toggle}
              aria-label={needsGesture ? "Start playback" : playing ? "Pause" : "Play"}
              className="grid h-9 w-9 place-items-center rounded-full bg-accent text-accent-ink transition hover:brightness-110 active:scale-95"
            >
              {buffering ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Icon d={playing ? PATHS.pause : PATHS.play} className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Next track"
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-raised hover:text-ink"
            >
              <Icon d={PATHS.next} />
            </button>
          </div>

          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] leading-tight font-medium text-ink">
              {active.title}
            </span>
            <span className="block truncate text-[11px] leading-tight text-muted">{active.artists}</span>
          </span>

          <div className="group/vol flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? "Unmute" : "Mute"}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-raised hover:text-ink"
            >
              <Icon d={muted ? PATHS.muted : PATHS.volume} className="h-3.5 w-3.5" />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={muted ? 0 : Math.round(volume)}
              onChange={(e) => changeVolume(Number(e.target.value))}
              aria-label="Volume"
              className="h-1 w-0 cursor-pointer appearance-none rounded-full bg-raised opacity-0 transition-all duration-300 group-hover/vol:w-16 group-hover/vol:opacity-100 focus:w-16 focus:opacity-100 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
            />
          </div>

          <button
            type="button"
            onClick={() => setVideoOpen((v) => !v)}
            aria-label={videoOpen ? "Hide video" : "Show video"}
            aria-pressed={videoOpen}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-raised hover:text-ink"
          >
            <Icon d={videoOpen ? PATHS.collapse : PATHS.video} className="h-4 w-4" />
          </button>
        </div>

        {needsGesture ? (
          <button
            type="button"
            onClick={toggle}
            className="mt-2 w-full rounded-lg bg-accent/12 py-1.5 text-[11.5px] font-semibold text-accent transition hover:bg-accent/20"
          >
            Browser blocked autoplay — tap to start
          </button>
        ) : null}
      </div>
    </section>
  );
}
