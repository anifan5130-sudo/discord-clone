// Короткие звуки интерфейса, синтезированные на лету (без файлов).
let ctx;
function tone(freqs, { dur = 0.09, gap = 0.07, type = 'sine', vol = 0.12 } = {}) {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      const s = t0 + i * gap;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(vol, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
      o.connect(g).connect(ctx.destination);
      o.start(s);
      o.stop(s + dur + 0.02);
    });
  } catch {}
}

export const sounds = {
  enabled: true,
  play(name) {
    if (!this.enabled) return;
    const map = {
      join: () => tone([660, 880]),
      leave: () => tone([740, 520]),
      selfJoin: () => tone([523, 659, 784], { gap: 0.06 }),
      disconnect: () => tone([600, 450, 300], { gap: 0.06 }),
      mute: () => tone([520, 390], { dur: 0.07, gap: 0.05, vol: 0.09 }),
      unmute: () => tone([390, 520], { dur: 0.07, gap: 0.05, vol: 0.09 }),
      message: () => tone([988], { dur: 0.08, vol: 0.06, type: 'triangle' }),
      stream: () => tone([440, 660, 880], { gap: 0.05, vol: 0.08, type: 'triangle' }),
    };
    map[name]?.();
  },
};
