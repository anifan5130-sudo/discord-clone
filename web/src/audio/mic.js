// Цепочка обработки микрофона:
// микрофон → [RNNoise] → гейт/PTT (AudioWorklet) → громкость → MediaStreamDestination → LiveKit
// Опубликованный трек остаётся тем же при смене устройства или режима шумодава —
// переподключаться к комнате не нужно.
import { createRnnoiseNode } from './rnnoise.js';

const gateUrl = new URL('./gate-worklet.js', import.meta.url);

export class MicPipeline extends EventTarget {
  constructor(settings) {
    super();
    this.settings = { ...settings };
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.denoiser = null;
    this.activeNoiseMode = null;
    this.level = -100;
    this.open = false;
    this.monitorNode = null;
  }

  get running() {
    return !!this.ctx;
  }

  get track() {
    return this.dest?.stream.getAudioTracks()[0] || null;
  }

  async start() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    await this.ctx.audioWorklet.addModule(gateUrl);
    this.gate = new AudioWorkletNode(this.ctx, 'voxa-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
    });
    this.gate.port.onmessage = (e) => {
      this.level = e.data.level;
      if (this.open !== e.data.open) {
        this.open = e.data.open;
        this.dispatchEvent(new CustomEvent('open', { detail: this.open }));
      }
      this.dispatchEvent(new CustomEvent('level', { detail: e.data }));
    };
    this.volume = this.ctx.createGain();
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = 1;
    this.gate.connect(this.volume).connect(this.dest);
    this.applyGateSettings();
    this.volume.gain.value = this.settings.inputVolume ?? 1;
    await this.setupSource();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
  }

  async setupSource() {
    const s = this.settings;
    let mode = s.noiseMode;
    if (mode === 'rnnoise' && this.ctx.sampleRate !== 48000) mode = 'browser';

    const constraints = {
      audio: {
        deviceId: s.inputDeviceId ? { exact: s.inputDeviceId } : undefined,
        echoCancellation: s.echoCancellation,
        autoGainControl: s.autoGainControl,
        noiseSuppression: mode === 'browser',
        channelCount: 1,
        sampleRate: 48000,
        latency: 0.01,
      },
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // выбранное устройство пропало — пробуем устройство по умолчанию
      if (s.inputDeviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        delete constraints.audio.deviceId;
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } else throw e;
    }

    this.teardownSource();
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      // микрофон отключили физически — переключаемся на другой
      if (this.stream === stream) {
        this.settings.inputDeviceId = '';
        this.setupSource().catch((err) => this.dispatchEvent(new CustomEvent('error', { detail: err })));
      }
    });

    try {
      this.source = this.ctx.createMediaStreamSource(stream);
    } catch (e) {
      // Firefox не умеет соединять потоки с разной частотой дискретизации
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }

    let head = this.source;
    if (mode === 'rnnoise') {
      try {
        this.denoiser = await createRnnoiseNode(this.ctx);
        this.source.connect(this.denoiser);
        head = this.denoiser;
      } catch (e) {
        console.warn('RNNoise недоступен, используем встроенный шумодав браузера', e);
        mode = 'browser';
        try {
          await track.applyConstraints({ ...constraints.audio, noiseSuppression: true, deviceId: undefined });
        } catch {}
      }
    }
    head.connect(this.gate);
    this.activeNoiseMode = mode;
    this.dispatchEvent(new CustomEvent('source', { detail: { mode, label: track.label } }));
  }

  teardownSource() {
    try {
      this.source?.disconnect();
    } catch {}
    try {
      this.denoiser?.disconnect();
      this.denoiser?.destroy?.();
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = this.denoiser = this.stream = null;
  }

  applyGateSettings() {
    const s = this.settings;
    this.gate?.port.postMessage({
      gateEnabled: !!s.gateEnabled,
      threshold: Number(s.gateThreshold),
      ptt: !!s.pttEnabled,
    });
  }

  setPttPressed(pressed) {
    this.gate?.port.postMessage({ pttPressed: pressed });
  }

  async update(patch) {
    const prev = this.settings;
    this.settings = { ...prev, ...patch };
    if (!this.ctx) return;
    this.applyGateSettings();
    this.volume.gain.setTargetAtTime(this.settings.inputVolume ?? 1, this.ctx.currentTime, 0.02);
    const needsNewSource = ['inputDeviceId', 'noiseMode', 'echoCancellation', 'autoGainControl'].some(
      (k) => k in patch && patch[k] !== prev[k],
    );
    if (needsNewSource) await this.setupSource();
  }

  // Прослушивание себя в настройках («Проверка микрофона»)
  setMonitor(on) {
    if (!this.ctx) return;
    if (on && !this.monitorNode) {
      this.monitorNode = this.ctx.createGain();
      this.volume.connect(this.monitorNode).connect(this.ctx.destination);
    } else if (!on && this.monitorNode) {
      this.volume.disconnect(this.monitorNode);
      this.monitorNode.disconnect();
      this.monitorNode = null;
    }
  }

  async stop() {
    this.setMonitor(false);
    this.teardownSource();
    const ctx = this.ctx;
    this.ctx = null;
    this.level = -100;
    await ctx?.close().catch(() => {});
  }
}
