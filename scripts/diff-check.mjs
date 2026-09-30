// Acceptance: per-country charts must actually differ (the "Dai Dai everywhere" guard).
// Usage: node --experimental-strip-types --no-warnings scripts/diff-check.mjs
import { fetchCountryCharts } from "../app/lib/analyticsCharts.ts";

const SAMPLE = ["US", "IN", "JP", "BR", "NG"];
const MAX_OVERLAP = 7; // global smashes legitimately repeat; copy-paste does not

const charts = {};
for (const cc of SAMPLE) {
  charts[cc] = await fetchCountryCharts(cc);
  const top = charts[cc].songs[0];
  console.log(
    `${cc}: week=${charts[cc].week.start}..${charts[cc].week.end} n=${charts[cc].songs.length} #1="${top.title}" (${top.artists}) prev=${top.previousRank}`
  );
}

let failed = 0;
for (let i = 0; i < SAMPLE.length; i++) {
  for (let j = i + 1; j < SAMPLE.length; j++) {
    const a = new Set(charts[SAMPLE[i]].songs.slice(0, 10).map((t) => t.videoId));
    const b = new Set(charts[SAMPLE[j]].songs.slice(0, 10).map((t) => t.videoId));
    const overlap = [...a].filter((v) => b.has(v)).length;
    const ok = overlap <= MAX_OVERLAP;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} overlap ${SAMPLE[i]}-${SAMPLE[j]}: ${overlap}/10`);
  }
}
// Metadata sanity.
for (const cc of SAMPLE) {
  const w = charts[cc].week;
  const ok = !!w.start && charts[cc].songs.length >= 10;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${cc} metadata (week + >=10 tracks)`);
}
if (failed) throw new Error(`${failed} diff checks failed`);
console.log("all diff checks passed");
