// Deterministic check for the hover prefetch rules.
//
// The browser gate can prove that a hover warms a chart and a click is instant,
// but it cannot cheaply prove the negative half: that a pointer sweeping the
// globe issues nothing, that leaving aborts, that a retry ignores the cache. Those
// are timing and ownership rules, so they live in `app/lib/chartPrefetch.ts` with
// an injectable clock and are swept here in milliseconds.
//
// Usage: node scripts/chart-prefetch-check.mjs

const { createChartPrefetcher, HOVER_PREFETCH_MS } = await import(
  "../app/lib/chartPrefetch.ts"
);

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const payload = (iso) => ({
  charted: true,
  country: iso,
  week: null,
  source: "live",
  fetchedAt: "2026-10-24T12:00:00.000Z",
  songs: [],
  videos: [],
});

const CHARTED = ["US", "BR", "MX", "AR", "CL"];

/**
 * A prefetcher with a hand-cranked clock.
 *
 * `load` never settles on its own: the test decides when a request lands, so
 * "what was in flight when the pointer moved" is exact rather than a race
 * against a real timer.
 */
function harness({ cached = [] } = {}) {
  const calls = [];
  const store = new Map(cached.map((iso) => [iso, payload(iso)]));
  const timers = new Map();
  let nextTimer = 1;
  let nextCall = 0;

  const source = {
    charted: (iso) => CHARTED.includes(iso),
    peek: (iso) => store.get(iso) ?? null,
    load: (iso, signal, refresh) => {
      const call = { id: ++nextCall, iso, signal, refresh };
      call.promise = new Promise((resolve, reject) => {
        call.resolve = resolve;
        call.reject = reject;
      });
      calls.push(call);
      return call.promise;
    },
  };

  const prefetcher = createChartPrefetcher({
    source,
    schedule: (run) => {
      const id = nextTimer++;
      timers.set(id, run);
      return id;
    },
    clear: (id) => timers.delete(id),
  });

  return {
    prefetcher,
    calls,
    store,
    source,
    /** How many timed waits are armed right now. */
    armed: () => timers.size,
    /** Fire every armed wait, as if the debounce elapsed. */
    tick() {
      const due = [...timers.values()];
      timers.clear();
      for (const run of due) run();
    },
    /** A callback that is still armed, for proving a cancelled one cannot fire. */
    due: () => [...timers.values()],
    settle(iso, value = payload(iso)) {
      store.set(iso, value);
      const call = calls.filter((c) => c.iso === iso).at(-1);
      call.resolve(value);
      return call;
    },
    fail(iso, error = new Error("upstream down")) {
      const call = calls.filter((c) => c.iso === iso).at(-1);
      call.reject(error);
      return call;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// 1. A resting pointer warms a charted country, and only then.
// ---------------------------------------------------------------------------
{
  const h = harness();
  h.prefetcher.hover("BR");
  check(
    "a hover arms a single wait without requesting anything",
    h.armed() === 1 && h.calls.length === 0,
    `${h.armed()} armed, ${h.calls.length} request(s)`
  );
  h.prefetcher.hover("BR");
  check(
    "the same hover does not arm a second wait",
    h.armed() === 1 && h.calls.length === 0,
    `${h.armed()} armed`
  );
  h.tick();
  check(
    "the wait prefetches the hovered country",
    h.calls.length === 1 && h.calls[0].iso === "BR" && h.calls[0].refresh === false,
    h.calls.map((c) => `${c.iso}${c.refresh ? " (refresh)" : ""}`).join(", ")
  );
}

// ---------------------------------------------------------------------------
// 2. Movement — including movement within one country — restarts the wait.
//    Crossing Russia must not warm Russia. The hover value does not change when
//    the pointer moves inside a country, which is why the hook forwards every
//    pointermove as a restart.
// ---------------------------------------------------------------------------
{
  const h = harness();
  h.prefetcher.hover("BR");
  const stale = h.due()[0];
  h.prefetcher.hover("BR", { restart: true });
  // A scheduler that cannot cancel (or a callback already in the event queue)
  // must not turn the superseded wait into a request.
  stale();
  check(
    "a superseded wait cannot fire after the pointer moves on",
    h.calls.length === 0 && h.armed() === 1,
    `${h.calls.length} request(s), ${h.armed()} armed`
  );
  h.tick();
  check(
    "the restarted wait still prefetches once the pointer settles",
    h.calls.length === 1 && h.calls[0].iso === "BR",
    h.calls.map((c) => c.iso).join(", ")
  );

  const sweeping = harness();
  sweeping.prefetcher.hover("BR");
  sweeping.prefetcher.hover("MX");
  sweeping.prefetcher.hover("AR");
  check(
    "sweeping across countries leaves only the last one armed",
    sweeping.armed() === 1 && sweeping.calls.length === 0,
    `${sweeping.armed()} armed`
  );
  sweeping.tick();
  check(
    "a sweep prefetches nothing but where the pointer stopped",
    sweeping.calls.length === 1 && sweeping.calls[0].iso === "AR",
    sweeping.calls.map((c) => c.iso).join(", ")
  );

  const away = harness();
  away.prefetcher.hover("BR");
  away.prefetcher.hover(null);
  away.tick();
  check(
    "leaving before the wait is up issues nothing",
    away.calls.length === 0 && away.armed() === 0,
    `${away.calls.length} request(s), ${away.armed()} armed`
  );
}

// ---------------------------------------------------------------------------
// 3. Uncharted countries and warm countries are never fetched.
// ---------------------------------------------------------------------------
{
  const h = harness();
  h.prefetcher.hover("AD");
  check(
    "an uncharted country does not even arm a wait",
    h.armed() === 0 && h.calls.length === 0,
    `${h.armed()} armed`
  );

  const warm = harness({ cached: ["BR"] });
  warm.prefetcher.hover("BR");
  warm.tick();
  check(
    "a country already in the browser cache is not fetched again",
    warm.calls.length === 0,
    `${warm.calls.length} request(s)`
  );

  // The selected country's own load is in flight when the pointer happens to be
  // over it: the prefetch joins nothing and starts nothing.
  const busy = harness();
  busy.prefetcher.load("US");
  busy.prefetcher.hover("US");
  busy.tick();
  check(
    "hovering the country the panel is already loading costs no second request",
    busy.calls.length === 1 && busy.calls[0].iso === "US",
    `${busy.calls.length} request(s)`
  );
}

// ---------------------------------------------------------------------------
// 4. Leaving aborts an in-flight prefetch; adopting it makes it load-bearing.
// ---------------------------------------------------------------------------
{
  const h = harness();
  h.prefetcher.hover("BR");
  h.tick();
  const call = h.calls[0];
  h.prefetcher.hover(null);
  check(
    "moving away aborts the prefetch in flight",
    call.signal.aborted,
    call.signal.aborted ? "signal aborted" : "signal still live"
  );

  const adopted = harness();
  adopted.prefetcher.hover("BR");
  adopted.tick();
  const answer = adopted.prefetcher.load("BR");
  const inFlight = "pending" in answer ? answer.pending : null;
  adopted.prefetcher.hover(null);
  check(
    "the panel adopts the prefetch instead of issuing a second request",
    adopted.calls.length === 1 && !!inFlight,
    `${adopted.calls.length} request(s), ${inFlight ? "joined" : "not joined"}`
  );
  check(
    "a hover that ends after the panel adopted the request cannot abort it",
    !adopted.calls[0].signal.aborted,
    adopted.calls[0].signal.aborted ? "aborted" : "still live"
  );
  adopted.settle("BR");
  await inFlight;
  await flush();
  const after = adopted.prefetcher.load("BR");
  check(
    "the adopted answer becomes the panel's cache hit",
    "cached" in after && after.cached.country === "BR" && adopted.calls.length === 1,
    "cached payload, no second request"
  );
}

// ---------------------------------------------------------------------------
// 5. Retry bypasses both the cache and any prefetch.
// ---------------------------------------------------------------------------
{
  const h = harness({ cached: ["BR"] });
  h.prefetcher.hover("BR");
  // A cached hover does not arm; force a flight for the concurrency case.
  h.prefetcher.load("MX");
  h.tick();
  const retrying = h.prefetcher.refresh("BR");
  const calls = h.calls.map((c) => `${c.iso}${c.refresh ? " (refresh)" : ""}`);
  check(
    "retry ignores the cached country and does not join a flight",
    h.calls.length === 2 &&
      h.calls[1].iso === "BR" &&
      h.calls[1].refresh === true &&
      h.calls[1].signal !== h.calls[0].signal,
    calls.join(", ")
  );
  h.prefetcher.hover(null);
  check(
    "a retry is not owned by the pointer, so leaving cannot abort it",
    !h.calls[1].signal.aborted,
    h.calls[1].signal.aborted ? "aborted" : "still live"
  );
  h.settle("BR");
  await retrying;
}

// ---------------------------------------------------------------------------
// 6. A failed prefetch is silent, and does not poison the country.
// ---------------------------------------------------------------------------
{
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(String(error));
  process.on("unhandledRejection", onUnhandled);

  const h = harness();
  h.prefetcher.hover("BR");
  h.tick();
  h.fail("BR");
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off("unhandledRejection", onUnhandled);
  check(
    "a failed prefetch does not surface as an unhandled rejection",
    unhandled.length === 0,
    unhandled.slice(0, 1).join(" | ")
  );

  h.prefetcher.hover(null);
  h.prefetcher.hover("BR");
  h.tick();
  check(
    "a failed prefetch leaves the country free to be tried again",
    h.calls.length === 2 && h.calls[1].iso === "BR",
    `${h.calls.length} request(s)`
  );
}

// ---------------------------------------------------------------------------
// 7. The debounce is short enough to beat a click, long enough to skip a sweep.
// ---------------------------------------------------------------------------
check(
  "the hover debounce is short enough to pre-empt a click",
  HOVER_PREFETCH_MS >= 100 && HOVER_PREFETCH_MS <= 250,
  `${HOVER_PREFETCH_MS}ms`
);

const failed = results.filter((r) => !r.pass);
console.log("");
console.log(`${results.length - failed.length}/${results.length} prefetch checks passed`);
process.exit(failed.length ? 1 : 0);
