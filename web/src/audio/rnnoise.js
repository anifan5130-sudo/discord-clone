// Шумоподавление на нейросети RNNoise (WebAssembly внутри AudioWorklet).
// Убирает клавиатуру, вентиляторы, шум улицы и т.п. — примерно как Krisp в Discord.
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

let wasmPromise = null;
const readyContexts = new WeakSet();

export async function createRnnoiseNode(ctx) {
  if (ctx.sampleRate !== 48000) throw new Error('RNNoise требует 48 кГц');
  wasmPromise ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  const wasmBinary = await wasmPromise;
  if (!readyContexts.has(ctx)) {
    await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
    readyContexts.add(ctx);
  }
  return new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
}
