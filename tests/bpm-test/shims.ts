/**
 * Node test shims for the in-browser analyzers: localStorage stub and an
 * OfflineAudioContext that parses the WAVs the test generates. Imported
 * first, so its side effects run before bpm.ts's module-load hydration.
 */

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => { mem[k] = String(v); },
  removeItem: (k: string) => { delete mem[k]; },
};

export function parseWav(buffer: ArrayBuffer): AudioBuffer {
  const view = new DataView(buffer);
  const readStr = (off: number) => String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  let off = 12;
  let sampleRate = 44100;
  let channels = 1;
  let samples: Float32Array = new Float32Array(0);
  while (off + 8 <= buffer.byteLength) {
    const id = readStr(off);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(off + 10, true);
      sampleRate = view.getUint32(off + 12, true);
    } else if (id === "data") {
      const bytes = new Int16Array(buffer, off + 8, size / 2);
      samples = new Float32Array(bytes.length / channels);
      for (let i = 0; i < samples.length; i += 1) samples[i] = bytes[i * channels] / 32768;
    }
    off += 8 + size + (size % 2);
  }
  return {
    length: samples.length, sampleRate, numberOfChannels: channels, duration: samples.length / sampleRate,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

class OfflineAudioContextShim {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> { return Promise.resolve(parseWav(data)); }
}
(globalThis as any).OfflineAudioContext = OfflineAudioContextShim;

// Minimal document: waveform.ts registers a stylesheet-reload listener at
// module load; nothing else touches the DOM in the analyzer paths under test.
(globalThis as any).document = {
  addEventListener: () => {},
  querySelectorAll: () => [],
};
