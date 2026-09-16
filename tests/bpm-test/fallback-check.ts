/**
 * Sanity test for the analyzers' whole-track fallback: when a track exposes
 * no HLS playlist (hlsStream → null), chroma and BPM must fall back to
 * windows sliced from the whole-track preview source (the same source
 * playback uses) instead of failing outright.
 */

import "./shims";
import { getState } from "../../src/services/store";
import { analyzeBpm } from "../../src/services/bpm";
import { analyzeChroma } from "../../src/services/chroma";
import { wholeTrackWindows } from "../../src/services/analysis-source";
import { makeWav } from "./entry-helpers";

const BPM = 128;
const wav = makeWav(BPM);

let previewCalls = 0;
(getState() as any).api = {
  async hlsStream() { return null; },
  async previewSource() {
    previewCalls += 1;
    return { blob: new Blob([wav], { type: "audio/wav" }), url: "http://x/full.mp3", kind: "full", complete: true };
  },
  async waveformSamples() { return []; },
};

const track = { id: 42, duration: 30000, permalink_url: "" } as any;

const windows = await wholeTrackWindows(track);
// The 30 s snippet is split into 4 non-overlapping windows covering it all.
const windowsOk = windows.length === 4
  && windows.every((w) => w.duration > 0 && w.samples.length > 0)
  && windows.every((w) => w.duration < 10);
console.log(`${windowsOk ? "PASS" : "FAIL"} — wholeTrackWindows: ${windows.length} window(s), `
  + windows.map((w) => w.duration.toFixed(1)).join("/") + " s");

const bpm = await analyzeBpm(track);
const bpmOk = Math.abs(bpm.bpm - BPM) < 2 || Math.abs(bpm.bpm - BPM * 2) < 2;
console.log(`${bpmOk ? "PASS" : "FAIL"} — fallback BPM: ${bpm.bpm} (raw ${bpm.rawBpm}, `
  + `${bpm.segmentsUsed} window(s), ${bpm.analyzedSec.toFixed(0)} s)`);

const cachedOk = previewCalls === 1;
await analyzeBpm(track); // must hit the whole-track cache — no second download
console.log(`${cachedOk ? "PASS" : "FAIL"} — whole-track cache: previewSource called ${previewCalls}×`);

const chroma = await analyzeChroma(track);
const chromaOk = Number.isFinite(chroma.correlation) && chroma.segmentsUsed > 0;
console.log(`${chromaOk ? "PASS" : "FAIL"} — fallback chroma: ${chroma.tonic}${chroma.mode === "minor" ? "m" : ""} `
  + `(r=${chroma.correlation.toFixed(2)}, ${chroma.chunks} chunk(s))`);

const failures = [windowsOk, bpmOk, cachedOk, chromaOk].filter((ok) => !ok).length;
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
