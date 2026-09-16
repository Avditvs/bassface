/** Shared test helpers for the bpm-test suite. */

/** Build a WAV (44.1 kHz mono) of exponential-decay noise clicks at `bpm`. */
export function makeWav(bpm: number, seconds = 30): ArrayBuffer {
  const rate = 44100;
  const n = rate * seconds;
  const data = new Int16Array(n);
  const beatSec = 60 / bpm;
  for (let beat = 0; beat * beatSec < seconds; beat += 1) {
    const start = Math.floor(beat * beatSec * rate);
    for (let i = 0; i < rate * 0.05 && start + i < n; i += 1) {
      const env = Math.exp(-i / (rate * 0.004));
      data[start + i] = Math.round((Math.random() * 2 - 1) * env * 0.9 * 32767);
    }
  }
  const header = new ArrayBuffer(44);
  const h = new DataView(header);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < 4; i += 1) h.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); h.setUint32(4, 36 + data.length * 2, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  writeStr(36, "data"); h.setUint32(40, data.length * 2, true);
  const out = new Uint8Array(44 + data.length * 2);
  out.set(new Uint8Array(header), 0);
  out.set(new Uint8Array(data.buffer), 44);
  return out.buffer;
}
