// Pure gate for the camera framing rules.
//
// The bug this covers is arithmetic, not wiring: the old focus altitude was
// derived from the selected country's angular span and clamped between a
// "minimum" and "maximum" screen radius. For a microstate the span resolved to
// the smallest radius, which is the *farthest* camera — selecting Singapore flew
// outward. That cannot be caught reliably by a browser test on every country, so
// the rule lives in `app/lib/focus.ts` and is swept here across viewports and
// sheet heights. The browser gate proves the wiring on the named countries.
//
// Usage: node scripts/focus-check.mjs

const {
  altitudeForScreenRadius,
  focusAltitude,
  worldAltitude,
  resolveFocus,
  HEADER_CLEARANCE,
  PANEL_WIDTH,
  GUTTER,
} = await import("../app/lib/focus.ts");

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
}

const EPS = 1e-9;
const WIDTHS = [320, 360, 375, 414, 768, 1023, 1024, 1280, 1440, 1920, 2560];
const HEIGHTS = [480, 568, 667, 768, 844, 900, 1080, 1440];
const SHEETS = [0, 60, 120, 240, 360, 405, 480, 600, 800];

const layouts = [];
for (const width of WIDTHS) {
  for (const height of HEIGHTS) {
    for (const sheetPx of SHEETS) {
      layouts.push({ width, height, isWide: width >= 1024, sheetPx });
    }
  }
}

// ---------------------------------------------------------------- geometry
{
  const small = altitudeForScreenRadius(900, 100);
  const large = altitudeForScreenRadius(900, 500);
  check(
    "a bigger globe on screen means a smaller altitude",
    large < small && small > 0 && large > 0,
    `100px -> ${small.toFixed(3)}, 500px -> ${large.toFixed(3)}`
  );

  // Invert the projection the module solves: screen radius for an altitude.
  const focal = (h) => h / (2 * Math.tan((50 / 2) * (Math.PI / 180)));
  const radiusOf = (h, altitude) => focal(h) * Math.tan(Math.asin(1 / (1 + altitude)));
  const roundTrip = radiusOf(900, altitudeForScreenRadius(900, 320));
  check(
    "the altitude formula round-trips through the sphere projection",
    Math.abs(roundTrip - 320) < 0.01,
    `asked 320px, drew ${roundTrip.toFixed(3)}px`
  );
}

// ------------------------------------------------------------- comfortable
{
  // The plan's one comfortable framing: on a wide 1440x900 stage the globe's
  // radius is 54% of the stage height, capped by the free width beside the rail.
  const width = 1440;
  const height = 900;
  const layout = { width, height, isWide: true, sheetPx: 0 };
  const altitude = focusAltitude(layout);
  const focal = height / (2 * Math.tan((50 / 2) * (Math.PI / 180)));
  const radius = focal * Math.tan(Math.asin(1 / (1 + altitude)));
  const expected = Math.min((width - (PANEL_WIDTH + GUTTER)) * 0.6, height * 0.54);
  check(
    "a wide focus frames the globe at one comfortable size",
    Math.abs(radius - expected) < 0.5 && Math.abs(radius / height - 0.54) < 0.01,
    `radius ${radius.toFixed(1)}px = ${((radius / height) * 100).toFixed(1)}% of the stage height`
  );

  const world = worldAltitude(layout);
  const worldRadius = focal * Math.tan(Math.asin(1 / (1 + world)));
  check(
    "a wide world view shows the whole globe with room around it",
    worldRadius < height / 2 && worldRadius > height * 0.4,
    `radius ${worldRadius.toFixed(1)}px in a ${height}px stage`
  );
}

// ------------------------------------------------------- focus vs world view
{
  let finite = true;
  let ordered = true;
  let narrowEqual = true;
  let worst = null;
  for (const layout of layouts) {
    const focus = focusAltitude(layout);
    const world = worldAltitude(layout);
    if (!Number.isFinite(focus) || !Number.isFinite(world)) {
      finite = false;
      worst ??= layout;
    }
    if (layout.isWide) {
      if (!(world >= focus - EPS)) {
        ordered = false;
        worst ??= layout;
      }
    } else if (Math.abs(world - focus) > EPS) {
      narrowEqual = false;
      worst ??= layout;
    }
  }
  check(
    "every altitude is finite across 320–2560px and 0–800px sheets",
    finite,
    finite ? `${layouts.length} layouts` : `first bad layout ${JSON.stringify(worst)}`
  );
  check(
    "world view is never closer than a country focus",
    ordered,
    ordered ? "wide layouts" : `first bad layout ${JSON.stringify(worst)}`
  );
  check(
    "narrow focus and world view are the same framing",
    narrowEqual,
    narrowEqual ? "the globe already shares the screen with the sheet" : `first bad layout ${JSON.stringify(worst)}`
  );
  check(
    "a focus is strictly closer than world view on wide layouts",
    layouts
      .filter((l) => l.isWide)
      .every((l) => worldAltitude(l) > focusAltitude(l) + 1e-6),
    "no country framing can be farther than the whole globe"
  );
  check(
    "an unmeasured stage falls back to a finite altitude",
    focusAltitude({ width: 0, height: 0, isWide: false, sheetPx: 0 }) === 2.5 &&
      worldAltitude({ width: 0, height: 0, isWide: true, sheetPx: 0 }) === 2.5,
    "2.5 before the first layout measurement"
  );
  check(
    "the header clearance is part of the narrow clear band",
    HEADER_CLEARANCE > 0 &&
      worldAltitude({ width: 390, height: 844, isWide: false, sheetPx: 405 }) !==
        worldAltitude({ width: 390, height: 844, isWide: false, sheetPx: 0 }),
    `header ${HEADER_CLEARANCE}px`
  );
}

// -------------------------------------------------------------- transitions
{
  const wanted = 1.4;
  check(
    "selecting from farther away moves to the comfortable framing",
    resolveFocus(2.8, wanted, "select") === wanted,
    `2.8 -> ${resolveFocus(2.8, wanted, "select")}`
  );
  check(
    "selecting from closer stays exactly where the user put the camera",
    resolveFocus(0.4, wanted, "select") === 0.4,
    `0.4 -> ${resolveFocus(0.4, wanted, "select")}`
  );
  check(
    "a recentre never zooms out either",
    resolveFocus(0.4, wanted, "recentre") === 0.4,
    `0.4 -> ${resolveFocus(0.4, wanted, "recentre")}`
  );

  let monotonic = true;
  for (let current = 0.05; current < wanted; current += 0.01) {
    for (const kind of ["select", "recentre"]) {
      if (resolveFocus(current, wanted, kind) > current + EPS) monotonic = false;
    }
  }
  check(
    "from any closer start, a selection never increases the distance",
    monotonic,
    `${wanted} target, 0.05 steps`
  );

  check(
    "world view overrides the clamp, even from a very close camera",
    resolveFocus(0.15, 1.8, "world") === 1.8 && resolveFocus(0.15, 1.8, "layout") === 1.8,
    `world 0.15 -> ${resolveFocus(0.15, 1.8, "world")}`
  );

  const invalidCurrents = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, undefined];
  check(
    "an unreadable camera altitude uses the requested framing",
    invalidCurrents.every((current) => resolveFocus(current, wanted, "select") === wanted),
    invalidCurrents.map(String).join(", ")
  );
  check(
    "an unreadable target keeps a valid camera where it is",
    resolveFocus(0.7, Number.NaN, "world") === 0.7 &&
      resolveFocus(Number.NaN, Number.NaN, "select") === 2.5,
    "falls back rather than flying to NaN"
  );
}

// -------------------------------------------------------------------- report
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? "ok  " : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} focus checks passed`);
if (failed.length > 0) {
  process.exitCode = 1;
}
