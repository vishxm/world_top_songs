import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ChartTrack } from "~/lib/chartTypes";
import { fmtDuration } from "~/lib/format";

/**
 * The transport, exposed to the route so a chart row can act on the track that
 * is already loaded.
 *
 * Pressing the active row must pause or resume *this* player. Bouncing the
 * request through React state would be a no-op when the index did not change
 * (a dead click on a paused row) or reload the video if it did, losing the
 * position. The call has to happen inside the click handler too, because
 * unmuting after the browser blocked autoplay only sticks inside a gesture.
 */
export interface PlayerHandle {
  play(): void;
  pause(): void;
  toggle(): void;
  /** Tear the player down and build it again, for the retry after a failure. */
  retry(): void;
}

interface Props {
  tracks: ChartTrack[];
  activeIndex: number | null;
  onSelect: (index: number) => void;
  onEnded: () => void;
  /** A track the player could not start. The route owns the queue, so skipping
   *  past it (and stopping when every entry has failed) happens there. */
  onTrackError?: (videoId: string) => void;
  /** The route's explanation when the whole queue proved unplayable. */
  queueError?: string | null;
  onRetryQueue?: () => void;
  onPlayingChange?: (playing: boolean) => void;
  handleRef?: RefObject<PlayerHandle | null>;
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
            onError?: (e: { data: number }) => void;
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

/**
 * How long the page waits for YouTube's player before saying so.
 *
 * Both waits matter and both were unbounded. An ad blocker or a blocked CDN
 * means `iframe_api` never loads and `onYouTubeIframeAPIReady` never fires, so
 * the promise below never settles and every transport control silently does
 * nothing. A script that loads but whose player never reports `onReady` leaves
 * the same dead controls by a different route. A failure the user can see and
 * retry is the whole point of the bound.
 */
const PLAYER_TIMEOUT_MS = 6000;

let apiPromise: Promise<void> | null = null;

function loadApi(): Promise<void> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<void>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let script = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]'
    );

    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // A script that never delivered must be removed, or a retry has nothing
      // to fetch and waits on the same dead request forever.
      script?.remove();
      reject(new Error(reason));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };

    timer = setTimeout(() => fail("timed out"), PLAYER_TIMEOUT_MS);
    if (!script) {
      script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("error", () => fail("failed to load"), { once: true });

    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      succeed();
    };
  }).catch((error: unknown) => {
    // Clear the cache so Retry starts a real second attempt rather than
    // replaying the rejection forever.
    apiPromise = null;
    throw error;
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

export default function NowPlaying({
  tracks,
  activeIndex,
  onSelect,
  onEnded,
  onTrackError,
  queueError,
  onRetryQueue,
  onPlayingChange,
  handleRef,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const bufferedRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  /** Last position/duration handed to the OS scrubber, to throttle the call. */
  const lastPositionRef = useRef<number | null>(null);
  const lastDurRef = useRef<number | null>(null);
  const endedRef = useRef(onEnded);
  const trackErrorRef = useRef(onTrackError);
  const [apiReady, setApiReady] = useState(false);
  /** A player that has reported `onReady` is the only one whose controls can be
   *  trusted; before that, every method call is silently ignored and the
   *  transport looks dead. */
  const [playerReady, setPlayerReady] = useState(false);
  /** Incremented by Retry. It is a dependency of both the API load and the
   *  player construction, so retrying tears the old player down and builds a
   *  fresh one even though the video id has not changed. */
  const [attempt, setAttempt] = useState(0);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [muted, setMuted] = useState(false);
  /** 0–100, the IFrame API's own scale. Keeping anything else here silently
   *  plays at a fraction of the intended volume — `setVolume(0.8)` is 0.8%, not
   *  80%, which is why the player used to sound like a whisper. */
  const [volume, setVolume] = useState(DEFAULT_VOLUME);
  const [videoOpen, setVideoOpen] = useState(false);
  /** Set when the browser refuses to start audible playback; we then wait for a
   *  real click. Mirrored into a ref because the transport callbacks read it and
   *  must not be re-created (re-creating them tears the player down). */
  const [needsGesture, setNeedsGesture] = useState(false);
  const needsGestureRef = useRef(false);
  const setGesture = useCallback((value: boolean) => {
    needsGestureRef.current = value;
    setNeedsGesture(value);
  }, []);
  /** The seek bar owns the thumb while a pointer is down. The 120ms poll must not
   *  write over the value the user is dragging — a scrubber that fights the
   *  pointer is exactly what makes a player feel cheap. */
  const scrubbingRef = useRef(false);

  useEffect(() => {
    endedRef.current = onEnded;
  }, [onEnded]);
  useEffect(() => {
    trackErrorRef.current = onTrackError;
  }, [onTrackError]);

  // Lift playback state to the parent so the chart row can show its equalizer.
  const playingChangeRef = useRef(onPlayingChange);
  useEffect(() => {
    playingChangeRef.current = onPlayingChange;
  }, [onPlayingChange]);
  useEffect(() => {
    playingChangeRef.current?.(playing);
  }, [playing]);

  // The progress poll is installed per-track and closes over `activeId` only, so
  // it needs its own mirror of `playing` rather than a stale capture.
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const active = activeIndex != null ? tracks[activeIndex] : null;
  const activeId = active?.videoId;
  /** The player outlives track changes, so its event handlers are created for
   *  the first track and must read the current id rather than a stale capture. */
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // The user's intent, mirrored into refs so the callbacks below can read it
  // without being re-created — re-creating them would tear the player down.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  /** The last non-zero volume, so muting at 0 is recoverable. */
  const lastAudibleRef = useRef(DEFAULT_VOLUME);

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
    // Height matters too: the video panel is collapsed to 0 when the player is
    // docked, and sizing the player to 0 would leave YouTube letterboxing a
    // zero-height box long after the panel expands.
    if (p && typeof p.setSize === "function" && w && w.clientWidth > 0 && w.clientHeight > 0) {
      p.setSize(w.clientWidth, w.clientHeight);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPlayerError(null);
    loadApi().then(
      () => {
        if (!cancelled) setApiReady(true);
      },
      () => {
        // One message for every way the API can fail. The reason is not
        // actionable for the listener; the retry is.
        if (!cancelled) {
          setApiReady(false);
          setPlayerError("The player couldn't load. Check your connection, then try again.");
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

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
    setGesture(false);
    setPlayerReady(false);

    let player: YTPlayer | null = null;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    let ready = false;

    try {
      player = new window.YT!.Player(el, {
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
            ready = true;
            if (readyTimer) clearTimeout(readyTimer);
            if (playerRef.current !== player) return;
            setPlayerReady(true);
            setPlayerError(null);
            fitPlayer();
            syncAudio(player);
          },
          onStateChange: (e) => {
            if (playerRef.current !== player) return;
            if (e.data === ENDED) {
              setPlaying(false);
              setBuffering(false);
              setGesture(false);
              endedRef.current();
            } else if (e.data === PLAYING) {
              setPlaying(true);
              setBuffering(false);
              syncAudio(player);
              // If the autoplay policy held the mute anyway, say so rather than
              // showing an unmuted speaker over silent audio — the button becomes
              // the gesture that unlocks sound.
              try {
                setGesture(!mutedRef.current && !!player && player.isMuted());
              } catch {
                setGesture(false);
              }
            } else if (e.data === PAUSED) {
              setPlaying(false);
              setBuffering(false);
            } else if (e.data === BUFFERING) {
              setBuffering(true);
            }
          },
          // A track the player refused to load. The route decides whether to
          // skip it or stop, because it owns the queue and what has failed.
          onError: () => {
            setPlaying(false);
            setBuffering(false);
            setGesture(false);
            const failedId = activeIdRef.current;
            if (failedId) trackErrorRef.current?.(failedId);
          },
        },
      });
    } catch {
      // A constructor that throws has not produced a player at all. There is
      // nothing for the transport to talk to, so say so instead of enabling it.
      el.remove();
      setPlayerReady(false);
      setPlayerError("The player didn't start. Try again.");
      return;
    }

    playerRef.current = player;
    readyTimer = setTimeout(() => {
      // The constructor returned but the player never became usable. Every
      // method on it is a silent no-op until `onReady`, which is exactly the
      // dead transport this bound exists to prevent. `ready` also covers an
      // implementation that reports readiness synchronously, before the timer
      // was assigned.
      if (ready || playerRef.current !== player) return;
      setPlayerReady(false);
      setPlaying(false);
      setBuffering(false);
      setPlayerError("The player took too long to start. Try again.");
    }, PLAYER_TIMEOUT_MS);

    return () => {
      if (readyTimer) clearTimeout(readyTimer);
      playerRef.current = null;
      try {
        player?.destroy();
      } catch {
        /* already gone */
      }
      el.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReady, activeId != null, attempt]);

  // Load subsequent tracks into the existing player.
  useEffect(() => {
    const p = playerRef.current;
    if (activeId && p && typeof p.loadVideoById === "function") p.loadVideoById(activeId);
  }, [activeId]);

  // Progress is written straight to the DOM on a timer. Re-rendering React eight
  // times a second just to move a bar is exactly what makes players feel cheap.
  useEffect(() => {
    if (!activeId) return;
    // A new track starts its own position history; keeping the previous track's
    // numbers would leave the OS scrubber on the old progress until the two
    // happened to differ by a second.
    lastPositionRef.current = null;
    lastDurRef.current = null;
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
      // Leave the range and its text alone while a pointer is dragging it: the
      // value on screen is the user's, not the player's, until they let go.
      const range = rangeRef.current;
      if (range && !scrubbingRef.current) {
        range.value = String(Math.round(frac * RANGE_MAX));
        range.setAttribute("aria-valuetext", dur > 0 ? `${fmtDuration(now)} of ${fmtDuration(dur)}` : fmtDuration(now));
      }
      // Feed the OS scrubber, which is what draws progress in Control Centre and
      // on the Touch Bar. Throttled to whole seconds: setPositionState on every
      // tick is a cross-browser call that nothing samples finer than that.
      const session = navigator.mediaSession;
      if (session && dur > 0 && Number.isFinite(dur)) {
        const last = lastPositionRef.current;
        if (last === null || Math.abs(now - last) >= 1 || dur !== lastDurRef.current) {
          lastPositionRef.current = now;
          lastDurRef.current = dur;
          try {
            session.setPositionState({
              duration: dur,
              // Always the real rate: 0 here is not "paused", and some browsers
              // reject it outright, which silently stopped the OS scrubber.
              playbackRate: 1,
              position: Math.min(Math.max(0, now), dur),
            });
          } catch {
            // Throws for live or unknown durations; the in-app bar is unaffected.
          }
        }
      }
    }, 120);
    return () => clearInterval(id);
  }, [activeId]);

  /**
   * Keep the iframe's internal size in step with its box. A window resize
   * listener was not enough: opening the video panel grows the box without
   * resizing the window, and folding the sheet changes it again.
   */
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => fitPlayer());
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [fitPlayer]);

  /**
   * Build the player again from scratch.
   *
   * Reusing a player that errored is how the transport stays dead: a failed
   * script leaves no `YT` at all, and a player that never reported ready has no
   * usable methods. Retry therefore reloads the API if needed and replaces the
   * player, even when the current video id has not changed.
   */
  const retry = useCallback(() => {
    setPlayerError(null);
    setPlayerReady(false);
    setAttempt((n) => n + 1);
  }, []);

  const play = useCallback(() => {
    // A chart row or media key pressed while the card is showing a failure is
    // asking for playback, not for a no-op on a player that does not work.
    if (playerError) {
      retry();
      return;
    }
    const p = playerRef.current;
    if (!p || typeof p.playVideo !== "function") return;
    // Inside a real gesture, unmuting sticks. This is the click that turns the
    // volume on; clearing the notice first means the next PLAYING event only
    // re-sets it if the browser still refuses.
    if (needsGestureRef.current) setGesture(false);
    syncAudio(p);
    p.playVideo();
  }, [playerError, retry, setGesture, syncAudio]);

  const pause = useCallback(() => {
    const p = playerRef.current;
    if (p && typeof p.pauseVideo === "function") p.pauseVideo();
  }, []);

  const toggle = useCallback(() => {
    // A tap on the "autoplay was blocked" action must unlock audio, not pause
    // the muted playback that is already running.
    if (needsGestureRef.current) {
      play();
      return;
    }
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  // The route's chart rows act through this. It is assigned in a layout effect
  // so the handle exists before the next user event, and the callbacks are
  // stable so re-registering does not churn.
  useLayoutEffect(() => {
    if (!handleRef) return;
    handleRef.current = { play, pause, toggle, retry };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, play, pause, toggle, retry]);

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
    if (!p || dur <= 0 || typeof p.seekTo !== "function") return;
    const seconds = Math.min(dur, Math.max(0, frac * dur));
    p.seekTo(seconds, true);
    // Paint the thumb and the time immediately. The poll deliberately stops
    // writing while a pointer is down, so without this the bar would not move
    // until the user let go of it.
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${seconds / dur})`;
    if (timeRef.current) timeRef.current.textContent = `${fmtDuration(seconds)} / ${fmtDuration(dur)}`;
    if (rangeRef.current) {
      rangeRef.current.setAttribute(
        "aria-valuetext",
        `${fmtDuration(seconds)} of ${fmtDuration(dur)}`
      );
    }
  }, []);

  const seekBy = useCallback((delta: number) => {
    const p = playerRef.current;
    const dur = p?.getDuration?.() ?? 0;
    if (!p || dur <= 0 || typeof p.seekTo !== "function") return;
    // Clamp inside the track: the OS calls this "skip back 15s", so running off
    // the front would be wrong — that is `previoustrack`'s job.
    const next = Math.min(dur - 0.25, Math.max(0, (p.getCurrentTime?.() ?? 0) + delta));
    p.seekTo(next, true);
  }, []);

  // ------------------------------------------------- macOS / keyboard transport
  // The next/previous keys on a MacBook (F7/F9, or the Touch Bar and Control
  // Centre transport) are media keys. Browsers do not deliver those as keydown
  // events — they surface them as Media Session actions, and only if the page has
  // installed handlers. Without this block the keys reached nothing at all, which
  // is why they did not change the song: there was no subscription for them to
  // arrive on.
  //
  // Handlers are registered once and read through a ref, because `toggle`/`step`
  // change identity whenever their deps do, and re-registering on every track
  // change would be churn for no benefit.
  const transport = useRef<{
    play: () => void;
    pause: () => void;
    toggle: () => void;
    step: (dir: 1 | -1) => void;
    seekBy: (delta: number) => void;
    seekTo: (seconds: number) => void;
  }>({
    play: () => {},
    pause: () => {},
    toggle: () => {},
    step: () => {},
    seekBy: () => {},
    seekTo: () => {},
  });
  transport.current = {
    play,
    pause,
    toggle,
    step,
    seekBy,
    seekTo: (seconds: number) => {
      const p = playerRef.current;
      const dur = p?.getDuration?.() ?? 0;
      if (p && dur > 0 && typeof p.seekTo === "function") {
        p.seekTo(Math.min(Math.max(0, seconds), dur), true);
      }
    },
  };

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    const bind = (
      action: MediaSessionAction,
      fn: (details: MediaSessionActionDetails) => void
    ) => {
      try {
        session.setActionHandler(action, fn);
      } catch {
        // Not every action is supported everywhere; a missing one is not fatal.
      }
    };
    bind("previoustrack", () => transport.current.step(-1));
    bind("nexttrack", () => transport.current.step(1));
    // `play`, `pause` and `stop` are commands, not toggles: acting on a stale
    // assumption of the current state made "stop" start playback and "play"
    // pause it.
    bind("play", () => transport.current.play());
    bind("pause", () => transport.current.pause());
    bind("stop", () => transport.current.pause());
    bind("seekbackward", () => transport.current.seekBy(-10));
    bind("seekforward", () => transport.current.seekBy(10));
    bind("seekto", (details) => {
      if (typeof details.seekTime === "number") transport.current.seekTo(details.seekTime);
    });
    return () => {
      for (const action of [
        "previoustrack",
        "nexttrack",
        "play",
        "pause",
        "stop",
        "seekbackward",
        "seekforward",
        "seekto",
      ] as MediaSessionAction[]) {
        try {
          session.setActionHandler(action, null);
        } catch {
          /* see above */
        }
      }
    };
  }, []);

  // Now-playing metadata. Without it the OS has nothing to attach the transport
  // keys to, and its own panel stays blank.
  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    session.metadata = active
      ? new MediaMetadata({
          title: active.title,
          artist: active.artists,
          artwork: active.thumbnail ? [{ src: active.thumbnail, sizes: "480x360" }] : [],
        })
      : null;
  }, [activeId, active?.title, active?.artists, active?.thumbnail]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    session.playbackState = playing ? "playing" : "paused";
  }, [playing, activeId]);

  const changeVolume = useCallback(
    (v: number) => {
      const clamped = Math.max(0, Math.min(100, Math.round(v)));
      if (clamped > 0) lastAudibleRef.current = clamped;
      volumeRef.current = clamped;
      setVolume(clamped);
      mutedRef.current = clamped === 0;
      setMuted(clamped === 0);
      syncAudio();
    },
    [syncAudio]
  );

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    // Unmuting at zero would be silent. Restore the last audible level instead,
    // which is what the volume slider and the OS mixer both do.
    if (!next && volumeRef.current === 0) {
      const restore = lastAudibleRef.current > 0 ? lastAudibleRef.current : DEFAULT_VOLUME;
      volumeRef.current = restore;
      setVolume(restore);
    }
    mutedRef.current = next;
    setMuted(next);
    setGesture(false);
    syncAudio();
  }, [setGesture, syncAudio]);

  if (!active) return null;

  /** A local player failure hides the queue error: nothing in the queue can be
   *  played until the player itself works again. */
  const failure = playerError ?? queueError ?? null;
  const usable = apiReady && playerReady && !failure;
  const busy = buffering || (!failure && !playerReady);

  return (
    // The attributes below are the transport state as the UI knows it: the
    // video id is the identity of what is playing — never the queue index,
    // which points at a different track the moment the visible list changes.
    <section
      aria-label="Now playing"
      data-video-id={active.videoId}
      data-playing={playing ? "true" : "false"}
      data-muted={muted ? "true" : "false"}
      data-volume={volume}
      data-needs-gesture={needsGesture ? "true" : "false"}
      data-player-state={failure ? "error" : usable ? "ready" : "loading"}
      className="surface overflow-hidden"
    >
      {/* Video expands on demand instead of permanently occupying a 16:9 box. */}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-slow ease-[var(--ease-out)] ${
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
              className="absolute top-2 right-2 grid h-7 w-7 place-items-center rounded-control bg-void/70 text-ink transition hover:bg-void"
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
        <div className="relative -mx-1 h-4 rounded-full focus-within:outline-2 focus-within:outline-accent/70 focus-within:outline-offset-2">
          <span className="pointer-events-none absolute inset-x-1 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-raised">
            {/* The starting scale is set inline, NOT with `scale-x-0`. Tailwind v4
                compiles `scale-x-0` to the standalone `scale: 0 1` property, and a
                later inline `transform: scaleX(0.15)` composes with that rather than
                replacing it — so the bar collapsed to zero width and never drew at
                all, while the time label, `aria-valuetext` and click-to-seek all kept
                working. In v3 both wrote `transform`, so this only broke on the v4
                upgrade. Driving the whole visual from the inline transform keeps it
                independent of whatever the scale utilities do next. */}
            <span
              ref={bufferedRef}
              style={{ transform: "scaleX(0)" }}
              className="absolute inset-0 origin-left rounded-full bg-line-bright"
            />
            <span
              ref={fillRef}
              style={{ transform: "scaleX(0)" }}
              className="absolute inset-0 origin-left rounded-full bg-accent"
            />
          </span>
          <input
            ref={rangeRef}
            type="range"
            min={0}
            max={RANGE_MAX}
            defaultValue={0}
            aria-label="Seek"
            disabled={!usable}
            onChange={(e) => seekToFraction(Number(e.target.value) / RANGE_MAX)}
            // The poll stops writing while a pointer owns the thumb, so the
            // value the user drags is the value on screen until release — and
            // the values are painted by `seekToFraction` as they move.
            onPointerDown={() => {
              scrubbingRef.current = true;
            }}
            onPointerUp={() => {
              scrubbingRef.current = false;
            }}
            onPointerCancel={() => {
              scrubbingRef.current = false;
            }}
            onBlur={() => {
              scrubbingRef.current = false;
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 focus-visible:opacity-0"
          />
        </div>

        <div className="mt-2 flex items-center gap-2.5">
          <span ref={timeRef} className="tnum w-[76px] shrink-0 text-micro text-faint">
            0:00
          </span>

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Previous track"
              disabled={!usable}
              className="grid h-8 w-8 place-items-center rounded-control text-muted transition hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon d={PATHS.prev} />
            </button>
            <button
              type="button"
              onClick={toggle}
              aria-label={needsGesture ? "Start playback" : playing ? "Pause" : "Play"}
              disabled={!usable}
              className="grid h-9 w-9 place-items-center rounded-pill bg-accent text-accent-ink transition hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
            >
              {busy ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Icon d={playing ? PATHS.pause : PATHS.play} className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Next track"
              disabled={!usable}
              className="grid h-8 w-8 place-items-center rounded-control text-muted transition hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon d={PATHS.next} />
            </button>
          </div>

          <span className="min-w-0 flex-1">
            <span
              data-now-playing-title
              className="block truncate text-small leading-tight font-medium text-ink"
            >
              {active.title}
            </span>
            <span
              data-now-playing-artists
              className="block truncate text-micro leading-tight text-muted"
            >
              {active.artists}
            </span>
          </span>

          {/* The slider collapses to nothing until the group is hovered or
              focused. `focus-within` is what makes it reachable on a touch
              screen, where there is no hover: tapping Mute focuses the group
              and the slider slides out. */}
          <div className="group/vol flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? "Unmute" : "Mute"}
              className="grid h-8 w-8 place-items-center rounded-control text-muted transition hover:bg-raised hover:text-ink"
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
              aria-valuetext={muted ? "Muted" : `${Math.round(volume)}%`}
              title="Volume"
              className="h-1 w-0 cursor-pointer appearance-none rounded-full bg-raised opacity-0 transition-all duration-300 group-hover/vol:w-16 group-hover/vol:opacity-100 group-focus-within/vol:w-16 group-focus-within/vol:opacity-100 focus:w-16 focus:opacity-100 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
            />
          </div>

          <button
            type="button"
            onClick={() => setVideoOpen((v) => !v)}
            aria-label={videoOpen ? "Hide video" : "Show video"}
            aria-pressed={videoOpen}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-control text-muted transition hover:bg-raised hover:text-ink"
          >
            <Icon d={videoOpen ? PATHS.collapse : PATHS.video} className="h-4 w-4" />
          </button>
        </div>

        {/* A failed player is not a disabled transport with no explanation. The
            message says what happened; the retry rebuilds the player. The
            controls above are genuinely disabled while this is up, so nothing
            on screen silently does nothing. */}
        {failure ? (
          <div
            role="alert"
            data-player-error="true"
            className="mt-2 rounded-control border border-down/30 bg-down/10 px-2.5 py-2"
          >
            <p className="text-micro font-semibold text-ink">
              {playerError ? "Playback isn't available" : "These tracks can't be played"}
            </p>
            <p
              data-player-error-message
              className="mt-0.5 text-pretty text-micro leading-relaxed text-muted"
            >
              {failure}
            </p>
            <button
              type="button"
              data-player-retry="true"
              onClick={playerError ? retry : (onRetryQueue ?? retry)}
              className="btn btn-primary mt-2 h-7 px-2.5 text-micro"
            >
              Try again
            </button>
          </div>
        ) : null}

        {/* The live region is always mounted and only gains text, because a
            status region inserted together with its message is not reliably
            announced. The action itself stays a plain button: a live region is
            not a control, and moving the role onto the button would remove it
            from the accessibility tree as something you can press. */}
        <p aria-live="polite" aria-atomic="true" className="sr-only">
          {needsGesture ? "Browser blocked autoplay. Tap to start." : ""}
        </p>

        {needsGesture && !failure ? (
          <button
            type="button"
            onClick={toggle}
            data-autoplay-blocked="true"
            className="mt-2 w-full rounded-control border border-accent/30 bg-accent/10 py-1.5 text-micro font-semibold text-accent transition hover:bg-accent/15"
          >
            Browser blocked autoplay — tap to start
          </button>
        ) : null}
      </div>
    </section>
  );
}
