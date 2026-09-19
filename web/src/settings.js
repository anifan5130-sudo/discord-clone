// Локальные настройки пользователя (хранятся в браузере).
const KEY = 'voxa.settings.v1';

export const defaults = {
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  inputVolume: 1,
  noiseMode: 'rnnoise', // rnnoise | browser | off
  echoCancellation: true,
  autoGainControl: true,
  gateEnabled: true,
  gateThreshold: -55,
  bitrate: 128000,
  pttEnabled: false,
  pttKey: 'Backquote',
  pttReleaseMs: 200,
  screenQuality: '1080p30',
  cameraQuality: '720p',
  userVolumes: {},
  sounds: true,
  chatOpen: true,
};

function load() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

export const settings = load();

export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {}
}

export const SCREEN_QUALITIES = {
  '720p30': { label: '720p · 30 FPS', width: 1280, height: 720, fps: 30, bitrate: 2_500_000, hint: 'detail' },
  '1080p30': { label: '1080p · 30 FPS', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000, hint: 'detail' },
  '1080p60': { label: '1080p · 60 FPS (игры)', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000, hint: 'motion' },
  '1440p60': { label: '1440p · 60 FPS (игры)', width: 2560, height: 1440, fps: 60, bitrate: 12_000_000, hint: 'motion' },
};

export const CAMERA_QUALITIES = {
  '360p': { label: '360p', width: 640, height: 360, fps: 30, bitrate: 600_000 },
  '720p': { label: '720p', width: 1280, height: 720, fps: 30, bitrate: 1_700_000 },
  '1080p': { label: '1080p', width: 1920, height: 1080, fps: 30, bitrate: 3_000_000 },
};

export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Mouse')) return `Мышь ${code.slice(5)}`;
  const names = {
    Backquote: '` (Ё)', Space: 'Пробел', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt', AltRight: 'Right Alt',
    CapsLock: 'Caps Lock', Tab: 'Tab',
  };
  return names[code] || code;
}
