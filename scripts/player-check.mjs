// Browser gate for the playback core, with YouTube and the chart API replaced by
// deterministic doubles.
//
// WHY THIS IS A SEPARATE GATE
//
// `globe-pick-check.mjs` already clicks a real chart row and checks that a real
// YouTube iframe draws a progress bar. That is the right smoke test for the
// embed, but it cannot assert *what* the player was asked to do: there is no way
// to read the volume back out of a cross-origin iframe, and the order of
// `loadVideoById` versus `playVideo` is invisible. It is also network-bound, so
// the transport rules end up covered by inference ("the title changed") rather
// than by observation.
//
// The fake IFrame API below records every call and reports state changes the way
// the real one does. With the chart payloads also stubbed, every transport rule
// in issue #16 is a fast, exact assertion:
//
//   1. pressing play on a row loads that video and snapshots the queue
//   2. the active row is identified by video id, not index, so it survives a
//      tab switch and a country switch, and a different list at a different
//      index still marks the same video
//   3. changing country or tab never reloads, destroys or stops the player
//   4. next/previous walk the snapshot, not whatever list is on screen
//   5. the active row is a transport control: it pauses and resumes without
//      reloading the video
//   6. volume and mute use the IFrame API's 0-100 scale (the 0.8-is-0.8% bug),
//      unmuting at zero restores the last audible level, and the volume slider
//      is reachable without hover
//   7. scrubbing seeks on pointer and keyboard, and the progress bar paints
//   8. a blocked autoplay shows a tap-to-start action that unlocks the audio
//   9. Media Session commands are commands, not toggles (stop never starts)
//  10. the player docks inside the sheet, the folded sheet reserves its measured
//      height, and the rail clears it
//
// Run it against a dev server. Usage: node scripts/player-check.mjs [url]
import { chromium } from "playwright";
import { NO_CHART_REASON } from "../app/lib/chartTypes.ts";

const URL_ = process.argv[2] ?? "http://localhost:5173/?c=US";
const BASE = new URL(URL_).origin;

const stage = (name) =>
  process.stderr.write(`  [${new Date().toISOString().slice(11, 19)}] ${name}\n`);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// Deterministic chart payloads. The two countries share one video id on
// purpose: it is the proof that "now playing" is matched by id, not by rank or
// position, when the visible list changes underneath the player.
// ---------------------------------------------------------------------------
const THUMB =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const track = (videoId, title, rank) => ({
  rank,
  videoId,
  title,
  artists: "Test Artist",
  weeklyViews: 12000,
  thumbnail: THUMB,
  previousRank: rank,
  weeksOnChart: 2,
  trend: "same",
});

const week = { id: "2026-W42", start: "2026-10-17", end: "2026-10-23" };
const payload = (country, songs, videos) => ({
  charted: true,
  country,
  week,
  source: "live",
  fetchedAt: "2026-10-24T00:00:00.000Z",
  songs,
  videos,
});

const US_SONGS = [
  track("usSong00001", "US One", 1),
  track("usSong00002", "US Two", 2),
  track("usSong00003", "US Three", 3),
];
const US_VIDEOS = [
  track("usVideo0001", "US Video One", 1),
  track("usVideo0002", "US Video Two", 2),
  track("usVideo0003", "US Video Three", 3),
];
const CA_SONGS = [
  // The same video that is playing from the US queue, at a different index.
  track("usSong00002", "US Two", 1),
  track("caSong00001", "CA Two", 2),
];
const CA_VIDEOS = [track("caVideo0001", "CA Video One", 1)];

const CHARTS = {
  US: payload("US", US_SONGS, US_VIDEOS),
  CA: payload("CA", CA_SONGS, CA_VIDEOS),
};

/**
 * Replace the YouTube IFrame API before any app module runs. `startMuted` models
 * a browser that refuses audible autoplay: `unMute()` is ignored until a real
 * play call unlocks audio, which is what the tap-to-start action exists for.
 *
 * The failure modes are first-class here too:
 * - `apiFailure` leaves `window.YT` undefined until `__yt.enable()` is called,
 *   which is what a blocked `iframe_api` request looks like to the app.
 * - `neverReadyFirst` makes the first player construct without ever reporting
 *   `onReady`, so the bounded startup wait can be exercised without a clock.
 * - `failIds` makes those videos report the IFrame API's `onError`, so skipping
 *   and the all-unplayable stop can be asserted exactly.
 */
async function installDouble(
  page,
  { startMuted = false, apiFailure = false, neverReadyFirst = false, failIds = [] } = {}
) {
  await page.addInitScript(
    ({ startMuted, apiFailure, neverReadyFirst, failIds }) => {
      const api = {
        instances: [],
        calls: [],
        created: 0,
        current: null,
        failIds: [...failIds],
        neverReadyFirst,
      };
      window.__yt = api;

      class FakePlayer {
        constructor(el, opts) {
          this.n = ++api.created;
          this.el = el;
          this.opts = opts ?? {};
          this.events = this.opts.events ?? {};
          this.videoId = this.opts.videoId ?? null;
          this.muted = !!startMuted;
          this.volume = 100;
          this.playing = false;
          this.time = 24;
          this.duration = 180;
          this.destroyed = false;
          this.unlocked = false;
          api.instances.push(this);
          api.current = this;
          api.calls.push({ m: "new", n: this.n, id: this.videoId });
          setTimeout(() => {
            if (this.destroyed) return;
            if (api.neverReadyFirst && this.n === 1) {
              api.calls.push({ m: "neverReady", n: this.n });
              return;
            }
            this.events.onReady?.();
            if (api.failIds.includes(this.videoId)) {
              api.calls.push({ m: "error", n: this.n, id: this.videoId });
              this.events.onError?.({ data: 150 });
              return;
            }
            // `autoplay: 1` means the real player starts on its own.
            this.playing = true;
            this.events.onStateChange?.({ data: 1 });
          }, 0);
        }
        loadVideoById(id) {
          if (this.destroyed) return;
          this.videoId = id;
          this.time = 0;
          api.calls.push({ m: "loadVideoById", n: this.n, id });
          if (api.failIds.includes(id)) {
            this.playing = false;
            api.calls.push({ m: "error", n: this.n, id });
            this.events.onError?.({ data: 150 });
            return;
          }
          this.playing = true;
          this.events.onStateChange?.({ data: 1 });
        }
        playVideo() {
          if (this.destroyed) return;
          api.calls.push({ m: "playVideo", n: this.n });
          this.playing = true;
          if (startMuted) {
            // A play call is the gesture the browser was waiting for.
            this.unlocked = true;
            this.muted = false;
          }
          this.events.onStateChange?.({ data: 1 });
        }
        pauseVideo() {
          if (this.destroyed) return;
          api.calls.push({ m: "pauseVideo", n: this.n });
          this.playing = false;
          this.events.onStateChange?.({ data: 2 });
        }
        seekTo(seconds, allowSeekAhead) {
          if (this.destroyed) return;
          this.time = seconds;
          api.calls.push({ m: "seekTo", n: this.n, seconds, allowSeekAhead });
        }
        setVolume(v) {
          this.volume = v;
          api.calls.push({ m: "setVolume", n: this.n, v });
        }
        mute() {
          this.muted = true;
          api.calls.push({ m: "mute", n: this.n });
        }
        unMute() {
          api.calls.push({ m: "unMute", n: this.n });
          if (!startMuted || this.unlocked) this.muted = false;
        }
        isMuted() {
          return this.muted;
        }
        getVolume() {
          return this.volume;
        }
        getCurrentTime() {
          return this.time;
        }
        getDuration() {
          return this.duration;
        }
        getVideoLoadedFraction() {
          return 0.5;
        }
        setSize(w, h) {
          api.calls.push({ m: "setSize", n: this.n, w, h });
        }
        destroy() {
          this.destroyed = true;
          api.calls.push({ m: "destroy", n: this.n });
        }
      }

      // A blocked script means `window.YT` is simply absent until the gate
      // chooses to provide it, exactly as an ad blocker leaves it.
      api.enable = () => {
        window.YT = { Player: FakePlayer };
      };
      if (!apiFailure) api.enable();

      // Capture the Media Session handlers so the gate can invoke the same
      // callbacks the OS transport keys would.
      window.__msHandlers = {};
      const wrapMediaSession = () => {
        const ms = navigator.mediaSession;
        if (!ms || ms.__wrappedForTest) return;
        const original = ms.setActionHandler.bind(ms);
        ms.setActionHandler = (action, handler) => {
          window.__msHandlers[action] = handler;
          return original(action, handler);
        };
        ms.__wrappedForTest = true;
      };
      wrapMediaSession();
      document.addEventListener("readystatechange", wrapMediaSession, { once: true });
    },
    { startMuted, apiFailure, neverReadyFirst, failIds }
  );
}

/** Intercept every chart request so the gate is offline and deterministic. */
async function installCharts(page, requests) {
  await page.route(/\/api\/charts\?/, async (route) => {
    const url = new URL(route.request().url());
    const iso = (url.searchParams.get("country") ?? "").toUpperCase();
    requests.push({ iso, refresh: url.searchParams.get("refresh") === "1" });
    const body = CHARTS[iso] ?? {
      charted: false,
      country: iso,
      reason: NO_CHART_REASON,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(body),
    });
  });
}

function watchErrors(target) {
  const errors = [];
  target.on("pageerror", (e) => errors.push(String(e).slice(0, 240)));
  target.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    const url = m.location()?.url ?? "";
    if (/Permissions policy violation/.test(text)) return;
    if (/googleads\.g\.doubleclick\.net/.test(text) || /googleads\.g\.doubleclick\.net/.test(url)) return;
    // The blocked-API case deliberately aborts this request; the browser logs
    // the network failure, but the app's own error surface is what is asserted.
    if (/iframe_api/.test(text) || /iframe_api/.test(url)) return;
    errors.push(`${text.slice(0, 160)}${url ? ` @ ${url.slice(0, 200)}` : ""}`);
  });
  return errors;
}

async function openPage(browser, { viewport, startMuted = false, blockApi = false, ...player } = {}) {
  const page = await browser.newPage({
    viewport: viewport ?? { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const requests = [];
  if (blockApi) {
    // The real failure the bound exists for: an ad blocker or a blocked CDN.
    await page.route(/youtube\.com\/iframe_api/, (route) => route.abort());
  }
  await installDouble(page, { startMuted, ...player });
  await installCharts(page, requests);
  const errors = watchErrors(page);
  await page.goto(`${BASE}/?c=US`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll('section[aria-label$="chart"] ol li button').length > 0,
    null,
    { timeout: 20_000 }
  );
  return { page, requests, errors };
}

/** The player's declared state, the fake's real state, and every call so far. */
const read = (page) =>
  page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Now playing"]');
    const fake = window.__yt?.current ?? null;
    const range = document.querySelector('input[aria-label="Seek"]');
    const fill = document.querySelectorAll("span.origin-left")[1] ?? null;
    const bars = document.querySelectorAll("span.origin-left");
    return {
      exists: !!section,
      videoId: section?.dataset.videoId ?? null,
      playing: section?.dataset.playing ?? null,
      muted: section?.dataset.muted ?? null,
      volume: section?.dataset.volume ?? null,
      needsGesture: section?.dataset.needsGesture ?? null,
      playerState: section?.dataset.playerState ?? null,
      playerError: section
        ? {
            present: !!section.querySelector("[data-player-error]"),
            title:
              section.querySelector("[data-player-error] p")?.textContent?.trim() ?? null,
            message:
              section
                .querySelector("[data-player-error-message]")
                ?.textContent?.trim() ?? null,
            retry: !!section.querySelector("[data-player-retry]"),
            playDisabled:
              section.querySelector('button[aria-label="Play"], button[aria-label="Pause"]')
                ?.disabled ?? null,
          }
        : null,
      title:
        section?.querySelector("[data-now-playing-title]")?.textContent?.trim() ??
        null,
      artists:
        section?.querySelector("[data-now-playing-artists]")?.textContent?.trim() ??
        null,
      banner: !!section?.querySelector("[data-autoplay-blocked]"),
      currentRows: Array.from(
        document.querySelectorAll('section[aria-label$="chart"] ol li button[aria-current="true"]')
      ).map((b) => b.getAttribute("aria-label")),
      fake: fake
        ? {
            n: fake.n,
            videoId: fake.videoId,
            playing: fake.playing,
            muted: fake.muted,
            volume: fake.volume,
            destroyed: fake.destroyed,
          }
        : null,
      calls: window.__yt?.calls ?? [],
      seek: range
        ? {
            value: Number(range.value),
            text: range.getAttribute("aria-valuetext"),
            transform: fill ? fill.style.transform : null,
            width: fill ? Math.round(fill.getBoundingClientRect().width) : null,
            trackWidth: fill?.parentElement
              ? Math.round(fill.parentElement.getBoundingClientRect().width)
              : null,
          }
        : null,
    };
  });

const callsSince = (calls, mark) => calls.slice(mark);
const countOf = (calls, method) => calls.filter((c) => c.m === method).length;
const lastOf = (calls, method) => [...calls].reverse().find((c) => c.m === method);

/** Focus a range input and set it through the native setter, as a pointer would. */
const setRange = (page, label, value) =>
  page.evaluate(
    ({ label, value }) => {
      const el = document.querySelector(`input[aria-label="${label}"]`);
      if (!el) throw new Error(`no range labelled ${label}`);
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(el, String(value));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { label, value }
  );

const browser = await chromium.launch();
const { page, requests, errors } = await openPage(browser);

// ---------------------------------------------------------------------------
// 1. Play from a row starts that video and snapshots the list.
// ---------------------------------------------------------------------------
stage("checking play from a row");
const rows = page.locator('section[aria-label$="chart"] ol li button');
await rows.nth(1).click();
await page.waitForFunction(
  () => window.__yt?.current && !window.__yt.current.destroyed,
  null,
  { timeout: 10_000 }
);
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.playing === "true",
  null,
  { timeout: 10_000 }
);
// Let a StrictMode remount settle: the last instance is the live one.
await page.waitForTimeout(300);

let state = await read(page);
check(
  "pressing play on a row loads that video",
  state.videoId === US_SONGS[1].videoId &&
    state.fake?.videoId === US_SONGS[1].videoId &&
    state.title === US_SONGS[1].title &&
    state.artists === US_SONGS[1].artists,
  `player ${state.videoId} (${state.title}), fake ${state.fake?.videoId}`
);
check(
  "the playing row is marked current and offers pause",
  state.currentRows.length === 1 &&
    state.currentRows[0].startsWith("Pause") &&
    state.currentRows[0].includes(US_SONGS[1].title),
  state.currentRows[0] ?? "no current row"
);

// ---------------------------------------------------------------------------
// 2. The active row is a transport control, not a second play.
// ---------------------------------------------------------------------------
const toggleMark = state.calls.length;
await rows.nth(1).click();
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.playing === "false",
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "pressing the active row pauses without reloading it",
  state.playing === "false" &&
    state.fake?.playing === false &&
    countOf(callsSince(state.calls, toggleMark), "pauseVideo") === 1 &&
    countOf(callsSince(state.calls, toggleMark), "loadVideoById") === 0 &&
    state.currentRows.length === 1 &&
    state.currentRows[0].startsWith("Resume"),
  `playing ${state.playing}, ${callsSince(state.calls, toggleMark)
    .map((c) => c.m)
    .join(", ")}`
);

const resumeMark = state.calls.length;
await rows.nth(1).click();
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.playing === "true",
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "pressing it again resumes at the same video",
  state.playing === "true" &&
    state.fake?.videoId === US_SONGS[1].videoId &&
    countOf(callsSince(state.calls, resumeMark), "playVideo") === 1 &&
    countOf(callsSince(state.calls, resumeMark), "loadVideoById") === 0,
  `${state.fake?.videoId}, ${callsSince(state.calls, resumeMark)
    .map((c) => c.m)
    .join(", ")}`
);

// Next walks the snapshot, not the DOM.
await page.getByRole("button", { name: "Next track" }).click();
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.videoId === "usSong00003",
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "next advances through the snapshot queue",
  state.videoId === US_SONGS[2].videoId &&
    state.title === US_SONGS[2].title &&
    lastOf(state.calls, "loadVideoById")?.id === US_SONGS[2].videoId,
  `${state.videoId} (${state.title})`
);

// Back to the shared song so the cross-list identity check is about US Two.
await page.getByRole("button", { name: "Previous track" }).click();
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.videoId === "usSong00002",
  null,
  { timeout: 5_000 }
);

// ---------------------------------------------------------------------------
// 3. Tabs and countries are not playback events.
// ---------------------------------------------------------------------------
stage("checking tab and country changes");
state = await read(page);
const instanceBefore = state.fake?.n;
const videoBefore = state.videoId;
const loadsBeforeTabs = countOf(state.calls, "loadVideoById");
const requestsBeforeTabs = requests.length;

await page.getByRole("tab", { name: "Videos" }).click();
await page.waitForFunction(
  () => new URLSearchParams(location.search).get("kind") === "videos",
  null,
  { timeout: 5_000 }
);
await page.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li button').length === 3,
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "switching tab keeps the same player, video and audio state",
  state.videoId === videoBefore &&
    state.fake?.n === instanceBefore &&
    state.playing === "true" &&
    countOf(state.calls, "loadVideoById") === loadsBeforeTabs,
  `video ${state.videoId}, instance ${state.fake?.n}, playing ${state.playing}, ` +
    `${countOf(state.calls, "loadVideoById") - loadsBeforeTabs} reloads`
);
check(
  "switching tab issues no second chart request",
  requests.length === requestsBeforeTabs,
  `${requestsBeforeTabs} -> ${requests.length} requests`
);
check(
  "a video is not a song, so no video row claims to be playing",
  state.currentRows.length === 0,
  state.currentRows.join(", ") || "none marked"
);

// Country switch happens through the picker, so the history entry is real.
await page.getByRole("tab", { name: "Songs" }).click();
await page.waitForFunction(
  () => new URLSearchParams(location.search).get("kind") === "songs",
  null,
  { timeout: 5_000 }
);
await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
await page.getByRole("combobox", { name: "Search countries" }).fill("Canada");
await page.keyboard.press("Enter");
await page.waitForFunction(
  () => new URLSearchParams(location.search).get("c") === "CA",
  null,
  { timeout: 5_000 }
);
await page.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li button').length === 2,
  null,
  { timeout: 10_000 }
);
state = await read(page);
check(
  "switching country keeps the same player and playing video",
  state.videoId === videoBefore &&
    state.fake?.n === instanceBefore &&
    state.playing === "true",
  `video ${state.videoId}, instance ${state.fake?.n}, playing ${state.playing}`
);
check(
  "the same video at a different index in another country is still current",
  state.currentRows.length === 1 &&
    state.currentRows[0].includes(US_SONGS[1].title) &&
    state.currentRows[0].startsWith("Pause"),
  state.currentRows[0] ?? "no current row"
);

// The queue is the US snapshot, not the Canadian list on screen.
await page.getByRole("button", { name: "Next track" }).click();
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.videoId === "usSong00003",
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "next after a country switch still walks the snapshot queue",
  state.videoId === US_SONGS[2].videoId && state.title === US_SONGS[2].title,
  `${state.videoId} (${state.title})`
);

// Pressing a row in the new country replaces the snapshot.
const caRows = page.locator('section[aria-label$="chart"] ol li button');
await caRows.nth(1).click();
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.videoId === "caSong00001",
  null,
  { timeout: 5_000 }
);
await page.getByRole("button", { name: "Next track" }).click();
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.videoId === "usSong00002",
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "a new play snapshots the new country's list and wraps within it",
  state.videoId === CA_SONGS[0].videoId && state.title === CA_SONGS[0].title,
  `after wrap ${state.videoId} (${state.title})`
);

// ---------------------------------------------------------------------------
// 4. Volume and mute: the IFrame API's own 0-100 scale.
// ---------------------------------------------------------------------------
stage("checking volume and mute");
await page.getByRole("button", { name: "Mute" }).click();
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.muted === "true",
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "mute calls the player and is reflected in the transport",
  state.muted === "true" && state.fake?.muted === true && countOf(state.calls, "mute") > 0,
  `muted ${state.muted}, fake ${state.fake?.muted}, ${countOf(state.calls, "mute")} mute calls`
);

await page.getByRole("button", { name: "Unmute" }).click();
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.muted === "false",
  null,
  { timeout: 5_000 }
);

// Setting 35 must reach setVolume(35), not setVolume(0.35).
const volumeMark = (await read(page)).calls.length;
await setRange(page, "Volume", 35);
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.volume === "35",
  null,
  { timeout: 5_000 }
);
state = await read(page);
const volumeCall = lastOf(callsSince(state.calls, volumeMark), "setVolume");
check(
  "volume uses the 0-100 scale all the way to the player",
  state.volume === "35" &&
    state.fake?.volume === 35 &&
    volumeCall?.v === 35 &&
    !callsSince(state.calls, volumeMark).some((c) => c.m === "setVolume" && c.v > 0 && c.v < 1),
  `ui ${state.volume}, player ${state.fake?.volume}, call ${volumeCall?.v}`
);

await setRange(page, "Volume", 0);
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.volume === "0",
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "dragging to zero mutes rather than playing silently at a fraction",
  state.muted === "true" && state.fake?.muted === true,
  `muted ${state.muted}, fake ${state.fake?.muted}`
);

await page.getByRole("button", { name: "Unmute" }).click();
await page.waitForFunction(
  () =>
    document.querySelector('section[aria-label="Now playing"]')?.dataset.muted === "false" &&
    document.querySelector('section[aria-label="Now playing"]')?.dataset.volume === "35",
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "unmuting at zero restores the last audible volume",
  state.volume === "35" && state.fake?.muted === false && state.fake?.volume === 35,
  `volume ${state.volume}, muted ${state.muted}`
);

// The slider is 0-width until the volume group is hovered or focused. Moving the
// pointer away leaves it expanded only if focus-within is doing the work, which
// is what makes it reachable on a touch screen.
const muteBox = await page.getByRole("button", { name: "Mute" }).boundingBox();
if (muteBox) await page.mouse.click(muteBox.x + muteBox.width / 2, muteBox.y + muteBox.height / 2);
await page.mouse.move(20, 20);
await page.waitForTimeout(450);
const sliderBox = await page.locator('input[aria-label="Volume"]').boundingBox();
check(
  "the volume slider is reachable without hover",
  !!sliderBox && sliderBox.width >= 60,
  `slider width ${sliderBox ? Math.round(sliderBox.width) : "none"}px with the pointer away`
);
// Undo the mute for the scrub checks.
await page.getByRole("button", { name: "Unmute" }).click();

// ---------------------------------------------------------------------------
// 5. Scrubbing: pointer, keyboard, and the painted bar.
// ---------------------------------------------------------------------------
stage("checking the scrubber");
const seek = page.locator('input[aria-label="Seek"]');
await seek.focus();
// End first: the loaded track starts at 0, so Home would be a no-op and the
// range would not emit a change for React to hear.
await page.keyboard.press("End");
await page.waitForFunction(() => {
  const calls = window.__yt?.calls ?? [];
  const last = [...calls].reverse().find((c) => c.m === "seekTo");
  return last?.seconds === 180;
});
let seekState = await read(page);
const endValue = seekState.seek?.value;
const endText = seekState.seek?.text;
await page.keyboard.press("Home");
await page.waitForFunction(() => {
  const calls = window.__yt?.calls ?? [];
  const last = [...calls].reverse().find((c) => c.m === "seekTo");
  return last?.seconds === 0;
});
seekState = await read(page);
check(
  "keyboard scrubbing seeks to the ends of the track",
  endValue === 1000 &&
    endText === "3:00 of 3:00" &&
    seekState.seek?.value === 0 &&
    seekState.seek?.text === "0:00 of 3:00",
  `end ${endValue} "${endText}", home ${seekState.seek?.value} "${seekState.seek?.text}"`
);

const seekBox = await seek.boundingBox();
if (seekBox) {
  await page.mouse.click(
    seekBox.x + seekBox.width * 0.5,
    seekBox.y + seekBox.height / 2
  );
}
await page.waitForTimeout(250);
seekState = await read(page);
const midpointSeek = lastOf(seekState.calls, "seekTo")?.seconds ?? 0;
check(
  "pointer scrubbing seeks to the clicked position",
  midpointSeek > 70 && midpointSeek < 110,
  `seekTo ${midpointSeek.toFixed(1)}s of 180s`
);
check(
  "the progress bar paints the position",
  seekState.seek?.width !== null &&
    seekState.seek.width > 0 &&
    seekState.seek.trackWidth > 0 &&
    /scaleX\(0?\.[1-9]/.test(seekState.seek.transform ?? "") &&
    /\d+:\d\d of 3:00/.test(seekState.seek.text ?? ""),
  `${seekState.seek?.width}px of ${seekState.seek?.trackWidth}px, ${seekState.seek?.transform}, "${seekState.seek?.text}"`
);

// ---------------------------------------------------------------------------
// 6. Media Session: play, pause and stop are commands, not a toggle.
// ---------------------------------------------------------------------------
stage("checking the OS transport");
const ms = await page.evaluate(() =>
  Object.entries(window.__msHandlers ?? {})
    .filter(([, handler]) => typeof handler === "function")
    .map(([action]) => action)
);
check(
  "Media Session transport handlers are installed",
  ["play", "pause", "stop", "nexttrack", "previoustrack", "seekto"].every((a) => ms.includes(a)),
  ms.join(", ") || "none"
);

const msMark = (await read(page)).calls.length;
await page.evaluate(() => window.__msHandlers.pause?.());
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.playing === "false"
);
await page.evaluate(() => window.__msHandlers.pause?.());
await page.waitForTimeout(150);
state = await read(page);
check(
  "pause is idempotent and never starts playback",
  state.playing === "false" &&
    state.fake?.playing === false &&
    countOf(callsSince(state.calls, msMark), "pauseVideo") >= 1 &&
    countOf(callsSince(state.calls, msMark), "playVideo") === 0,
  `${callsSince(state.calls, msMark).map((c) => c.m).join(", ")}`
);

await page.evaluate(() => window.__msHandlers.play?.());
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.playing === "true"
);
await page.evaluate(() => window.__msHandlers.stop?.());
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.playing === "false"
);
state = await read(page);
check(
  "play plays and stop pauses, even when already paused",
  state.playing === "false" && state.fake?.playing === false,
  `final state ${state.playing}`
);

// The MacBook's next/previous keys arrive as the same handlers. Radio keys and
// the Touch Bar get no keydown at all, so this path *is* the hardware transport.
const nextKeyMark = (await read(page)).calls.length;
await page.evaluate(() => window.__msHandlers.nexttrack?.());
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.videoId === "caSong00001",
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "the OS next-track key advances the snapshot queue",
  state.videoId === CA_SONGS[1].videoId &&
    state.title === CA_SONGS[1].title &&
    lastOf(callsSince(state.calls, nextKeyMark), "loadVideoById")?.id === CA_SONGS[1].videoId,
  `${state.videoId} (${state.title})`
);

const prevKeyMark = (await read(page)).calls.length;
await page.evaluate(() => window.__msHandlers.previoustrack?.());
await page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.videoId === "usSong00002",
  null,
  { timeout: 5_000 }
);
state = await read(page);
check(
  "the OS previous-track key walks back through the queue",
  state.videoId === CA_SONGS[0].videoId &&
    state.title === CA_SONGS[0].title &&
    lastOf(callsSince(state.calls, prevKeyMark), "loadVideoById")?.id === CA_SONGS[0].videoId,
  `${state.videoId} (${state.title})`
);

check("no page errors on the transport page", errors.length === 0, errors.slice(0, 3).join(" | "));
await page.close();

// ---------------------------------------------------------------------------
// 7. A blocked autoplay is explained and one tap fixes it.
// ---------------------------------------------------------------------------
stage("checking blocked autoplay");
const autoplay = await openPage(browser, { startMuted: true });
await autoplay.page.locator('section[aria-label$="chart"] ol li button').first().click();
await autoplay.page.waitForSelector("[data-autoplay-blocked]", { timeout: 10_000 });
let blocked = await read(autoplay.page);
check(
  "blocked autoplay shows a tap-to-start action instead of silent playback",
  blocked.needsGesture === "true" &&
    blocked.banner &&
    blocked.muted === "false" &&
    blocked.fake?.muted === true,
  `needsGesture ${blocked.needsGesture}, ui muted ${blocked.muted}, player muted ${blocked.fake?.muted}`
);

const unMuteBeforeTap = countOf(blocked.calls, "unMute");
await autoplay.page.locator("[data-autoplay-blocked]").click();
await autoplay.page.waitForFunction(
  () =>
    document.querySelector('section[aria-label="Now playing"]')?.dataset.needsGesture === "false"
);
blocked = await read(autoplay.page);
check(
  "the tap unlocks audio and dismisses the notice",
  !blocked.banner &&
    blocked.needsGesture === "false" &&
    blocked.fake?.muted === false &&
    blocked.playing === "true" &&
    countOf(blocked.calls, "unMute") > unMuteBeforeTap,
  `banner ${blocked.banner}, player muted ${blocked.fake?.muted}, playing ${blocked.playing}`
);
check(
  "no page errors on the autoplay page",
  autoplay.errors.length === 0,
  autoplay.errors.slice(0, 3).join(" | ")
);
await autoplay.page.close();

// ---------------------------------------------------------------------------
// 8. Broken tracks are skipped; an entirely broken queue stops, once.
// ---------------------------------------------------------------------------
stage("checking unplayable tracks");
const broken = await openPage(browser, { failIds: ["usSong00002"] });
const brokenRows = broken.page.locator('section[aria-label$="chart"] ol li button');
await brokenRows.nth(0).click();
await broken.page.waitForFunction(
  () =>
    document.querySelector('section[aria-label="Now playing"]')?.dataset.videoId === "usSong00001" &&
    document.querySelector('section[aria-label="Now playing"]')?.dataset.playing === "true"
);
// Advancing onto the broken track must land on the next playable one instead of
// leaving the player on a dead video.
await broken.page.getByRole("button", { name: "Next track" }).click();
await broken.page.waitForFunction(
  () => document.querySelector('section[aria-label="Now playing"]')?.dataset.videoId === "usSong00003",
  null,
  { timeout: 5_000 }
);
await broken.page.waitForTimeout(250);
let brokenState = await read(broken.page);
check(
  "a broken track is skipped instead of stalling the queue",
  brokenState.videoId === US_SONGS[2].videoId &&
    brokenState.fake?.videoId === US_SONGS[2].videoId &&
    brokenState.playing === "true" &&
    !brokenState.playerError?.present,
  `${brokenState.videoId}, playing ${brokenState.playing}, ` +
    `${countOf(brokenState.calls, "error")} error events`
);

// Now make every entry fail. The route must try each untried track once and then
// stop, rather than wrapping around and loading forever.
await broken.page.evaluate(() => {
  window.__yt.failIds = ["usSong00001", "usSong00002", "usSong00003"];
});
const failMark = (await read(broken.page)).calls.length;
await brokenRows.nth(0).click();
await broken.page.waitForSelector("[data-player-error]", { timeout: 8_000 });
await broken.page.waitForTimeout(500);
brokenState = await read(broken.page);
const failedLoads = callsSince(brokenState.calls, failMark).filter(
  (c) => c.m === "loadVideoById"
).length;
check(
  "an entirely unplayable queue stops with an explanation and a retry",
  brokenState.playerState === "error" &&
    brokenState.playerError?.present &&
    brokenState.playerError.retry &&
    brokenState.playerError.playDisabled === true &&
    /unavailable/i.test(brokenState.playerError.message ?? ""),
  `state ${brokenState.playerState}, "${brokenState.playerError?.message}", ` +
    `play disabled ${brokenState.playerError?.playDisabled}`
);
check(
  "it tries each track once instead of looping",
  failedLoads === US_SONGS.length &&
    countOf(callsSince(brokenState.calls, failMark), "error") === US_SONGS.length,
  `${failedLoads} loads, ${countOf(callsSince(brokenState.calls, failMark), "error")} errors ` +
    `for a ${US_SONGS.length}-track queue`
);

// Retry clears the failure record and builds a fresh player even though the
// active video id has not changed.
const failedInstance = brokenState.fake?.n;
await broken.page.evaluate(() => {
  window.__yt.failIds = [];
});
await broken.page.locator("[data-player-retry]").click();
await broken.page.waitForFunction(
  () =>
    document.querySelector('section[aria-label="Now playing"]')?.dataset.playerState === "ready" &&
    document.querySelector('section[aria-label="Now playing"]')?.dataset.playing === "true",
  null,
  { timeout: 8_000 }
);
brokenState = await read(broken.page);
check(
  "retry after an unplayable queue rebuilds the player and resumes",
  !brokenState.playerError?.present &&
    brokenState.fake?.n > failedInstance &&
    brokenState.fake?.playing === true,
  `instance ${failedInstance} -> ${brokenState.fake?.n}, playing ${brokenState.playing}`
);
check(
  "no page errors on the unplayable page",
  broken.errors.length === 0,
  broken.errors.slice(0, 3).join(" | ")
);
await broken.page.close();

// ---------------------------------------------------------------------------
// 9. A blocked player API fails visibly, and retry recovers.
// ---------------------------------------------------------------------------
stage("checking a blocked player API");
const blockedApi = await openPage(browser, { apiFailure: true, blockApi: true });
await blockedApi.page.locator('section[aria-label$="chart"] ol li button').first().click();
await blockedApi.page.waitForSelector("[data-player-error]", { timeout: 10_000 });
let apiState = await read(blockedApi.page);
check(
  "a blocked player API reports failure with a retry instead of dead controls",
  apiState.playerState === "error" &&
    apiState.playerError?.present &&
    apiState.playerError.retry &&
    apiState.playerError.playDisabled === true &&
    /couldn't load/i.test(apiState.playerError.message ?? ""),
  `"${apiState.playerError?.title}: ${apiState.playerError?.message}", ` +
    `play disabled ${apiState.playerError?.playDisabled}`
);

// Hand the app an API as an unblocked browser eventually would, then retry.
await blockedApi.page.evaluate(() => window.__yt.enable());
await blockedApi.page.locator("[data-player-retry]").click();
await blockedApi.page.waitForFunction(
  () =>
    document.querySelector('section[aria-label="Now playing"]')?.dataset.playerState === "ready" &&
    document.querySelector('section[aria-label="Now playing"]')?.dataset.playing === "true",
  null,
  { timeout: 8_000 }
);
apiState = await read(blockedApi.page);
check(
  "retry after the player API is available starts playback",
  !apiState.playerError?.present && apiState.fake?.playing === true,
  `state ${apiState.playerState}, playing ${apiState.playing}`
);
check(
  "no page errors on the blocked API page",
  blockedApi.errors.length === 0,
  blockedApi.errors.slice(0, 3).join(" | ")
);
await blockedApi.page.close();

// ---------------------------------------------------------------------------
// 10. A player that never reports ready fails within the bound.
// ---------------------------------------------------------------------------
stage("checking the player startup bound");
const slowApi = await openPage(browser, { neverReadyFirst: true });
const startedAt = Date.now();
await slowApi.page.locator('section[aria-label$="chart"] ol li button').first().click();
await slowApi.page.waitForSelector("[data-player-error]", { timeout: 12_000 });
const waitedMs = Date.now() - startedAt;
let slowState = await read(slowApi.page);
check(
  "a player that never reports ready fails within the bound",
  waitedMs < 10_000 &&
    slowState.playerState === "error" &&
    slowState.playerError?.retry &&
    /too long/i.test(slowState.playerError.message ?? ""),
  `failed after ${waitedMs}ms: "${slowState.playerError?.message}"`
);
await slowApi.page.locator("[data-player-retry]").click();
await slowApi.page.waitForFunction(
  () =>
    document.querySelector('section[aria-label="Now playing"]')?.dataset.playerState === "ready" &&
    document.querySelector('section[aria-label="Now playing"]')?.dataset.playing === "true",
  null,
  { timeout: 8_000 }
);
slowState = await read(slowApi.page);
check(
  "retry after a startup timeout builds a working player",
  !slowState.playerError?.present &&
    slowState.fake?.n === 2 &&
    slowState.fake?.playing === true,
  `instance ${slowState.fake?.n}, playing ${slowState.playing}`
);
check(
  "no page errors on the slow player page",
  slowApi.errors.length === 0,
  slowApi.errors.slice(0, 3).join(" | ")
);
await slowApi.page.close();

// ---------------------------------------------------------------------------
// 11. The player in the panel and the sheet.
// ---------------------------------------------------------------------------
stage("checking the player layout");
const phone = await openPage(browser, { viewport: { width: 390, height: 844 } });
const phonePage = phone.page;
await phonePage.locator('section[aria-label$="chart"] ol li button').first().click();
await phonePage.waitForSelector('section[aria-label="Now playing"]');
await phonePage.waitForTimeout(300);

const readLayout = () =>
  phonePage.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const main = document.querySelector("#main");
    const css = main ? getComputedStyle(main) : null;
    return {
      sheetH: css ? parseFloat(css.getPropertyValue("--sheet-h")) || 0 : 0,
      playerH: css ? parseFloat(css.getPropertyValue("--player-h")) || 0 : 0,
      aside: box('aside[aria-label="Chart and player"]'),
      panel: box('section[aria-label$="chart"]'),
      player: box('section[aria-label="Now playing"]'),
      peek: box('button[aria-label^="Show the "]'),
      rail: box('nav[aria-label="Filter by region"]'),
      viewportH: innerHeight,
    };
  });

const openLayout = await readLayout();
check(
  "the player sits inside the open sheet, under the chart",
  !!openLayout.aside &&
    !!openLayout.panel &&
    !!openLayout.player &&
    Math.abs(openLayout.aside.height - openLayout.sheetH) < 1.5 &&
    openLayout.panel.bottom <= openLayout.player.top - 8 &&
    openLayout.player.bottom <= openLayout.aside.bottom + 0.5,
  `aside ${Math.round(openLayout.aside?.height ?? 0)} vs --sheet-h ${openLayout.sheetH}, ` +
    `list bottom ${Math.round(openLayout.panel?.bottom ?? 0)} vs player top ${Math.round(openLayout.player?.top ?? 0)}`
);
check(
  "the reserved player height is the measured card, not a guess",
  Math.abs(openLayout.playerH - Math.ceil(openLayout.player?.height ?? 0)) <= 1,
  `--player-h ${openLayout.playerH} vs card ${Math.round(openLayout.player?.height ?? 0)}`
);
check(
  "the region rail clears the open sheet",
  !openLayout.rail || (!!openLayout.aside && openLayout.rail.bottom <= openLayout.aside.top + 1),
  `rail bottom ${Math.round(openLayout.rail?.bottom ?? 0)} vs sheet top ${Math.round(openLayout.aside?.top ?? 0)}`
);

// Expanding the video grows the card; the reserve must follow it.
await phonePage.getByRole("button", { name: "Show video" }).click();
await phonePage.waitForTimeout(500);
const videoLayout = await readLayout();
check(
  "opening the video grows the measured reserve",
  (videoLayout.player?.height ?? 0) > (openLayout.player?.height ?? 0) + 100 &&
    Math.abs(videoLayout.playerH - Math.ceil(videoLayout.player?.height ?? 0)) <= 1,
  `card ${Math.round(openLayout.player?.height ?? 0)} -> ${Math.round(videoLayout.player?.height ?? 0)}px, ` +
    `--player-h ${videoLayout.playerH}`
);

// Fold the sheet. The peek and the enlarged player are the whole reserve now.
await phonePage.getByRole("button", { name: "Collapse chart" }).click();
await phonePage.waitForFunction(
  () => !!document.querySelector('button[aria-label^="Show the "]'),
  null,
  { timeout: 5_000 }
);
await phonePage.waitForTimeout(400);
const folded = await readLayout();
const expectedReserve = (folded.peek?.height ?? 0) + (folded.player?.height ?? 0) + 10;
check(
  "the folded sheet reserves the peek bar and the measured player together",
  !!folded.peek &&
    !!folded.player &&
    Math.abs(folded.sheetH - expectedReserve) <= 3 &&
    Math.abs(folded.playerH - Math.ceil(folded.player.height)) <= 1,
  `--sheet-h ${folded.sheetH}, peek ${Math.round(folded.peek?.height ?? 0)} + player ` +
    `${Math.round(folded.player?.height ?? 0)} + gap, --player-h ${folded.playerH}`
);
check(
  "the rail clears the folded player",
  !folded.rail || (!!folded.player && folded.rail.bottom <= folded.player.top - 4),
  `rail bottom ${Math.round(folded.rail?.bottom ?? 0)} vs player top ${Math.round(folded.player?.top ?? 0)}`
);
check(
  "the player stays fully on screen when the sheet is folded",
  !!folded.player && folded.player.top >= 0 && folded.player.bottom <= folded.viewportH,
  `player ${Math.round(folded.player?.top ?? 0)}-${Math.round(folded.player?.bottom ?? 0)} of ${folded.viewportH}`
);
check(
  "no page errors on the phone page",
  phone.errors.length === 0,
  phone.errors.slice(0, 3).join(" | ")
);
await phonePage.close();

// ---------------------------------------------------------------------------
// 9. Wide layouts: a rail, a chart above the player, no fold.
// ---------------------------------------------------------------------------
stage("checking the wide layout");
const wide = await openPage(browser, { viewport: { width: 1440, height: 900 } });
await wide.page.locator('section[aria-label$="chart"] ol li button').first().click();
await wide.page.waitForSelector('section[aria-label="Now playing"]');
await wide.page.waitForTimeout(300);
const wideLayout = await wide.page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  };
  const main = document.querySelector("#main");
  return {
    aside: box('aside[aria-label="Chart and player"]'),
    panel: box('section[aria-label$="chart"]'),
    player: box('section[aria-label="Now playing"]'),
    playerH: main ? parseFloat(getComputedStyle(main).getPropertyValue("--player-h")) : 0,
    fold: !!document.querySelector('button[aria-label="Collapse chart"]'),
    viewportW: innerWidth,
    viewportH: innerHeight,
  };
});
check(
  "a wide layout has no fold, a rail-width panel and the player under the chart",
  !!wideLayout.aside &&
    !!wideLayout.panel &&
    !!wideLayout.player &&
    Math.abs(wideLayout.aside.width - 384) < 2 &&
    Math.abs(wideLayout.aside.right - (wideLayout.viewportW - 20)) < 2 &&
    wideLayout.panel.bottom <= wideLayout.player.top - 8 &&
    wideLayout.player.bottom <= wideLayout.aside.bottom + 0.5 &&
    Math.abs(wideLayout.playerH - Math.ceil(wideLayout.player.height)) <= 1 &&
    !wideLayout.fold,
  `aside ${Math.round(wideLayout.aside?.width ?? 0)}px, ` +
    `list bottom ${Math.round(wideLayout.panel?.bottom ?? 0)} vs player top ${Math.round(wideLayout.player?.top ?? 0)}`
);
check(
  "no page errors on the wide page",
  wide.errors.length === 0,
  wide.errors.slice(0, 3).join(" | ")
);
await wide.page.close();

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log("");
console.log(`${results.length - failed.length}/${results.length} player checks passed`);
process.exit(failed.length ? 1 : 0);
