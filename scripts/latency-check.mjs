// Production latency gate for the hover-prefetch contract.
//
// The dev gate proves the *wiring*: resting on a charted country issues exactly
// one request, the click that follows issues none and never shows a skeleton,
// and the rows land. Its timing assertion used to sit in the same script, and it
// was measuring the wrong thing: `react-router dev` runs React's development
// build, where a single selection traverses passive-unmount effects for the
// whole tree and calls `jsxDEV` for every element. A CDP profile of one hovered
// click showed 41.7% of samples in `recursivelyTraversePassiveUnmountEffects`
// and 15.5% in `exports.jsxDEV`; the same click measured 78-123ms across runs,
// against 44ms when the page was profiled in isolation. The product ships the
// production build, so that is where the budget is measured.
//
// This gate builds the app, serves `build/` with `react-router-serve` on an
// ephemeral port, and runs the same two hovered clicks as the dev gate with the
// renderer paused. It asserts the user-visible number: rows painted in under
// 100ms, no skeleton, and no request beyond the hover prefetch.
//
// Usage: node scripts/latency-check.mjs
//        LATENCY_SKIP_BUILD=1 node scripts/latency-check.mjs   (iterate on the gate)
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { chromium } from "playwright";

const BUDGET_MS = 100;
const results = [];
const check = (name, pass, detail = "") => results.push({ name, pass, detail });
const stage = (name) => console.log(`\n— ${name}`);

// --------------------------------------------------------------- production
if (!process.env.LATENCY_SKIP_BUILD) {
  stage("building the production bundle");
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const port = await freePort();
const server = spawn("node_modules/.bin/react-router-serve", ["./build/server/index.js"], {
  env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => (serverLog += chunk));
server.stderr.on("data", (chunk) => (serverLog += chunk));

const BASE = `http://127.0.0.1:${port}`;
const waitForServer = async (timeout = 30_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (server.exitCode !== null) {
      throw new Error(`react-router-serve exited with ${server.exitCode}\n${serverLog}`);
    }
    try {
      const response = await fetch(`${BASE}/`, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`react-router-serve did not answer within ${timeout}ms\n${serverLog}`);
};

let browser;
try {
  await waitForServer();
  stage("measuring two hovered clicks");

  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });

  const payloadFor = (country) => ({
    charted: true,
    country,
    week: { id: "2026-10-18", start: "2026-10-18", end: "2026-10-24" },
    source: "live",
    fetchedAt: new Date().toISOString(),
    songs: Array.from({ length: 20 }, (_, i) => ({
      rank: i + 1,
      videoId: `song${i}`,
      title: `Song ${i}`,
      artists: "Test",
      weeklyViews: 1000 - i,
      thumbnail:
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      previousRank: i + 1,
      weeksOnChart: 2,
      trend: "same",
    })),
    videos: [],
  });

  const requested = [];
  await page.route(/\/api\/charts\?/, (route) => {
    const country = new URL(route.request().url()).searchParams.get("country") ?? "";
    requested.push(country);
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payloadFor(country)),
    });
  });

  // Start on an uncharted country: its payload is answered without the upstream,
  // so this gate needs no network. The measured clicks still select charted
  // countries, and the first one is still a first selection on the page.
  await page.goto(`${BASE}/?c=AD`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__globe && !!window.__globeHit, null, {
    timeout: 30_000,
  });
  // Let the initial camera pose settle and the bootstrap selection finish.
  await page.waitForTimeout(600);

  // How much a software-rendered frame costs here. Headless Chromium rasterises
  // the scene on the CPU, and a frame already in flight when the renderer is
  // paused delays the click behind it. Reported, not asserted: the two timed
  // clicks run with the renderer paused so this measures the app.
  const frameMs = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const started = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - started < 1000) requestAnimationFrame(tick);
          else resolve(Math.round((performance.now() - started) / frames));
        };
        requestAnimationFrame(tick);
      })
  );

  const pauseRenderer = (paused) =>
    page.evaluate((p) => {
      const renderer = window.__globe?.renderer?.();
      if (!renderer) return false;
      if (p) {
        if (window.__realRender) return true;
        window.__realRender = renderer.render;
        renderer.render = () => {};
      } else if (window.__realRender) {
        renderer.render = window.__realRender;
        delete window.__realRender;
      }
      return true;
    }, paused);

  /** The panel names a chart from the country's display name, not its ISO. */
  const NAMES = { BR: "Brazil", MX: "Mexico" };

  /** Pose the camera on a country, then put the pointer on its centre pixel. */
  const hoverCountry = async (iso, lat, lng) => {
    // Park the pointer off the globe first. The camera can rotate the target
    // country under a stationary pointer, and that counts as a hover: the
    // prefetch would land before `requested` is cleared, and the next click
    // would look like it had no prefetch at all.
    await page.mouse.move(10, 500);
    await page.waitForTimeout(100);
    await page.evaluate(
      ([la, ln]) => window.__globe.pointOfView({ lat: la, lng: ln, altitude: 0.7 }, 0),
      [lat, lng]
    );
    await page.waitForTimeout(400);
    const pixel = await page.evaluate(
      ([la, ln]) => {
        const point = window.__globe.getScreenCoords(la, ln, 0);
        return point ? [Math.round(point.x), Math.round(point.y)] : null;
      },
      [lat, lng]
    );
    if (!pixel) return null;
    requested.length = 0;
    await page.mouse.move(pixel[0], pixel[1]);
    await page.waitForFunction(
      (want) =>
        new RegExp(`^${want}\\b`).test(document.querySelector("header p")?.textContent ?? ""),
      iso,
      { timeout: 5_000 }
    );
    // The header readout is visual chrome whose spans can be adjacent without
    // whitespace in `textContent`, so the display name comes from the gate's own
    // table rather than from parsing it.
    return { pixel, label: `${NAMES[iso]} chart` };
  };

  /**
   * Arm the same probe the dev gate uses, from inside the page. `commit` is the
   * DOM mutation, `rows` the first frame it could have been painted on.
   */
  const armClickProbe = (label) =>
    page.evaluate((wanted) => {
      window.__click = { rows: null, commit: null, skeleton: false };
      const ready = () => {
        const section = document.querySelector(`section[aria-label="${wanted}"]`);
        return !!section && section.querySelectorAll("ol li").length === 20;
      };
      document.addEventListener(
        "pointerup",
        () => {
          const started = performance.now();
          const seen = new MutationObserver(() => {
            if (document.querySelector('[aria-label="Loading chart"]')) {
              window.__click.skeleton = true;
            }
            if (window.__click.commit === null && ready()) {
              window.__click.commit = Math.round(performance.now() - started);
            }
          });
          seen.observe(document.body, { childList: true, subtree: true });
          const tick = () => {
            if (!ready()) {
              requestAnimationFrame(tick);
              return;
            }
            window.__click.rows = Math.round(performance.now() - started);
            seen.disconnect();
          };
          requestAnimationFrame(tick);
        },
        { once: true, capture: true }
      );
    }, label);

  const clickHovered = async ({ pixel, label }) => {
    if (!pixel || !label) return null;
    await armClickProbe(label);
    await page.mouse.click(pixel[0], pixel[1]);
    await page.waitForFunction(
      (wanted) => {
        const section = document.querySelector(`section[aria-label="${wanted}"]`);
        return !!section && section.querySelectorAll("ol li").length === 20;
      },
      label,
      { timeout: 10_000 }
    );
    return page.evaluate(() => window.__click);
  };

  const rendererPaused = await pauseRenderer(true);
  // A software frame already in flight when `render` was stubbed can still take
  // `frameMs` to finish; two frames guarantee the pause is in effect.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );

  // -- 1. Brazil: rest, prefetch, click. --------------------------------------
  const br = await hoverCountry("BR", -10, -52);
  await page.waitForTimeout(700);
  check(
    "hovering a charted country prefetches its chart",
    !!br && requested.length === 1 && requested[0] === "BR",
    br ? `${requested.length} request(s): ${requested.join(", ") || "none"}` : "no BR pixel"
  );
  const first = await clickHovered(br);
  check(
    "clicking the hovered country shows its chart with no loading state, no request, in under 100ms",
    !!first &&
      first.rows !== null &&
      first.rows < BUDGET_MS &&
      first.skeleton === false &&
      requested.length === 1 &&
      rendererPaused,
    first
      ? `${first.rows}ms painted (${first.commit}ms committed) at ${frameMs}ms/frame, skeleton ${first.skeleton}, ${requested.length} request(s) including the prefetch`
      : "no BR pixel"
  );

  // -- 2. Mexico: a second country, so the result is not a one-off. -----------
  // Let the flight to the first selection finish before posing the camera again.
  await page.waitForTimeout(700);
  const mx = await hoverCountry("MX", 23, -102);
  await page.waitForTimeout(700);
  check(
    "hovering a second charted country prefetches its chart",
    !!mx && requested.length === 1 && requested[0] === "MX",
    mx ? `${requested.length} request(s): ${requested.join(", ") || "none"}` : "no MX pixel"
  );
  const second = await clickHovered(mx);
  await pauseRenderer(false);
  check(
    "a hovered click on a second country renders in under 100ms",
    !!second &&
      second.rows !== null &&
      second.rows < BUDGET_MS &&
      second.skeleton === false &&
      requested.length === 1,
    second
      ? `${second.rows}ms painted (${second.commit}ms committed) at ${frameMs}ms/frame, skeleton ${second.skeleton}, ${requested.length} request(s) including the prefetch`
      : "no MX pixel"
  );
} finally {
  await browser?.close().catch(() => undefined);
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

// ------------------------------------------------------------------- report
const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? "✓" : "✗"} ${result.name}`);
  if (result.detail) console.log(`    ${result.detail}`);
}
console.log(`\n${results.length - failed.length}/${results.length} production latency checks passed`);
if (failed.length) process.exitCode = 1;
