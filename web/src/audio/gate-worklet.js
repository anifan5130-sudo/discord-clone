// AudioWorklet: шумовой гейт (порог чувствительности) + push-to-talk + измеритель уровня.
// Работает в аудиопотоке, поэтому не тормозит, даже когда вкладка в фоне.
class VoxaGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = -55; // дБFS
    this.gateEnabled = true;
    this.ptt = false; // режим рации
    this.pttPressed = false;
    this.gain = 0;
    this.holdBlocks = 0;
    this.blocks = 0;
    this.peak = -100;
    this.holdTime = 0.35; // сек держим гейт открытым после окончания речи
    this.attack = 1 - Math.exp(-1 / (sampleRate * 0.003));
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.06));
    this.port.onmessage = (e) => Object.assign(this, e.data);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output.length) return true;
    const src = input[0];
    const dst = output[0];
    const n = src.length;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += src[i] * src[i];
    const db = 20 * Math.log10(Math.sqrt(sum / n) + 1e-10);

    let target;
    if (this.ptt) {
      target = this.pttPressed ? 1 : 0;
    } else if (!this.gateEnabled) {
      target = 1;
    } else if (db > this.threshold) {
      this.holdBlocks = Math.ceil((this.holdTime * sampleRate) / n);
      target = 1;
    } else if (this.holdBlocks > 0) {
      this.holdBlocks--;
      target = 1;
    } else {
      target = 0;
    }

    const coef = target > this.gain ? this.attack : this.release;
    let g = this.gain;
    for (let i = 0; i < n; i++) {
      g += (target - g) * coef;
      dst[i] = src[i] * g;
    }
    this.gain = g;
    for (let ch = 1; ch < output.length; ch++) output[ch].set(dst);

    this.peak = Math.max(db, this.peak - 1.5);
    if (++this.blocks % 8 === 0) {
      this.port.postMessage({ level: this.peak, open: this.gain > 0.5 });
    }
    return true;
  }
}

registerProcessor('voxa-gate', VoxaGate);
