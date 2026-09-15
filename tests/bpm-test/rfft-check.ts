import "./shims";
import { fft, fftRealMag } from "../../src/services/audio";

const N = 1024;
const x = new Float64Array(N);
for (let i = 0; i < N; i += 1) x[i] = Math.sin(2 * Math.PI * i * 13.7 / N) + 0.5 * Math.sin(2 * Math.PI * i * 41.3 / N) + Math.random() * 0.1;

// reference: full complex FFT
const re = new Float64Array(N); const im = new Float64Array(N);
for (let i = 0; i < N; i += 1) { re[i] = x[i]; im[i] = 0; }
fft(re, im);
const ref = new Float64Array(N / 2);
for (let k = 0; k < N / 2; k += 1) ref[k] = Math.hypot(re[k], im[k]);

// real-FFT magnitudes
const reH = new Float64Array(N / 2); const imH = new Float64Array(N / 2);
const mag = new Float64Array(N / 2);
fftRealMag(x, reH, imH, mag);

let maxErr = 0;
for (let k = 1; k < N / 2; k += 1) maxErr = Math.max(maxErr, Math.abs(mag[k] - ref[k]));
console.log(`max |mag error| = ${maxErr.toExponential(2)} ${maxErr < 1e-8 ? "OK" : "MISMATCH"}`);
