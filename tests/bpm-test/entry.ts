/**
 * Sanity test for services/bpm.ts: analyzeBpm on synthesized click tracks at
 * several tempos (the real bundled module, run in Node with shims).
 */

import "./shims";
import { getState } from "../../src/services/store";
import { analyzeBpm, pickIntenseSegments } from "../../src/services/bpm";
import { makeWav } from "./entry-helpers";

const CASES = [128, 90, 174, 120, 75];
let failures = 0;
for (const bpm of CASES) {
  const wav = makeWav(bpm);
  const segments = Array.from({ length: 10 }, (_, i) => ({ url: `${bpm}-seg${i}`, duration: 3 }));
  (getState() as any).api = {
    fetches: 0,
    async hlsStream() { return { mime: "audio/mpeg", segments }; },
    async fetchSegment(url: string) { this.fetches += 1; return new Blob([wav], { type: "audio/wav" }); },
    // No waveform bars: the picker must fall back to the even spread.
    async waveformSamples() { return []; },
  };
  const track = { id: 1, duration: 30000, permalink_url: "" } as any;
  let analysis = await analyzeBpm(track);
  let t0 = performance.now();
  analysis = await analyzeBpm(track);
  const ms = performance.now() - t0;
  const msPerSec = ms / (4 * 30); // 4 segments × 30 s of audio
  // Accept the estimated value within 2 BPM, or the octave fold when the
  // expected tempo lies below the display range (75 → 150 is correct).
  const ok = Math.abs(analysis.bpm - bpm) < 2
    || (bpm < 90 && Math.abs(analysis.bpm - bpm * 2) < 2);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} — expected ${bpm}: got ${analysis.bpm} (raw ${analysis.rawBpm}, ` +
    `confidence ${analysis.confidence}) — cached re-run ${ms.toFixed(0)} ms for 120 s of audio (${msPerSec.toFixed(1)} ms/s)`);
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);

// --- unit checks for the intensity-guided segment picker ---
const segs10 = Array.from({ length: 10 }, (_, i) => ({ url: `p${i}`, duration: 3 }));
const track = { id: 7, duration: 30000, permalink_url: "" } as any;

// 100 bars over 30 s; intense zone = 9–15 s (segments 3–4), plus a decoy
// loud blip in the leading 5% that must be ignored.
const bars = new Array(100).fill(0.01);
for (let b = 30; b < 50; b += 1) bars[b] = 1.0;
bars[1] = 1.0; // decoy in the ignored intro edge
(getState() as any).api = { async waveformSamples() { return bars; } };

const picks = await pickIntenseSegments(track, segs10);
// Segments 3–4 cover the 9–15 s intense zone; quiet parts (0.01 vs peak 1.0,
// under the 10% floor) and the intro decoy must not appear.
const allIntense = picks.length === 2 && picks[0] === 3 && picks[1] === 4;
console.log(`${allIntense ? "PASS" : "FAIL"} — picks ${JSON.stringify(picks)} (expected exactly [3, 4], the 9–15 s intense zone)`);

// No bars at all → even-spread fallback (fresh track id: bars are cached
// per track in runtime.waveforms).
(getState() as any).api = { async waveformSamples() { return []; } };
const fallback = await pickIntenseSegments({ id: 8, duration: 30000, permalink_url: "" } as any, segs10);
const spread = JSON.stringify(fallback) === JSON.stringify([2, 4, 6, 8]);
console.log(`${spread ? "PASS" : "FAIL"} — without bars falls back to the even spread: ${JSON.stringify(fallback)}`);
process.exit(allIntense && spread ? 0 : 1);
