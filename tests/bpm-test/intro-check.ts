/**
 * End-to-end check: a 128 BPM track whose first 60% is a quiet intro
 * (ambient pad, no beat) and whose last 40% is the loud drop. The picker
 * should choose segments inside the drop; the even spread would waste two
 * of its four samples on the intro.
 */
import "./shims";
import { getState } from "../../src/services/store";
import { analyzeBpm } from "../../src/services/bpm";

const RATE = 44100;
function makeIntroTrackWav(bpm: number): ArrayBuffer {
  const seconds = 30;
  const n = RATE * seconds;
  const data = new Int16Array(n);
  const beatSec = 60 / bpm;
  const dropFrom = 18; // 60% intro (0–18 s), drop 18–30 s
  for (let beat = 0; beat * beatSec < seconds; beat += 1) {
    const start = Math.floor(beat * beatSec * RATE);
    const inDrop = beat * beatSec >= dropFrom;
    for (let i = 0; i < RATE * 0.05 && start + i < n; i += 1) {
      const env = Math.exp(-i / (RATE * 0.004));
      data[start + i] = Math.round((Math.random() * 2 - 1) * env * (inDrop ? 0.9 : 0.08) * 32767);
    }
  }
  const header = new ArrayBuffer(44);
  const h = new DataView(header);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < 4; i += 1) h.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); h.setUint32(4, 36 + data.length * 2, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, RATE, true); h.setUint32(28, RATE * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  writeStr(36, "data"); h.setUint32(40, data.length * 2, true);
  const out = new Uint8Array(44 + data.length * 2);
  out.set(new Uint8Array(header), 0);
  out.set(new Uint8Array(data.buffer), 44);
  return out.buffer;
}

// Waveform bars mirroring the quiet intro / loud drop (100 bars, 0.3 s each).
const bars = new Array(100).fill(0.05);
for (let b = 60; b < 100; b += 1) bars[b] = 1.0;

const segments = Array.from({ length: 10 }, (_, i) => ({ url: `intro-${i}`, duration: 3 }));
(getState() as any).api = {
  async hlsStream() { return { mime: "audio/mpeg", segments }; },
  async fetchSegment() { return new Blob([makeIntroTrackWav(128)], { type: "audio/wav" }); },
  async waveformSamples() { return bars; },
};
const analysis = await analyzeBpm({ id: 9, duration: 30000, permalink_url: "" } as any);
const ok = Math.abs(analysis.bpm - 128) < 2;
console.log(`${ok ? "PASS" : "FAIL"} — intro+drop track: ${analysis.bpm} BPM (raw ${analysis.rawBpm}, confidence ${analysis.confidence})`);
process.exit(ok ? 0 : 1);
