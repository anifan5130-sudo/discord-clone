// Набор иконок (inline SVG, линейный стиль).
const svg = (body, { fill = false } = {}) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>'),
  micOff: svg(
    '<path d="M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M9 9v2a3 3 0 0 0 4.6 2.5"/><path d="M5 11a7 7 0 0 0 11.3 5.5"/><path d="M19 11a7 7 0 0 1-.6 2.8"/><path d="M12 18v3"/><path d="M3 3l18 18"/>',
  ),
  headphones: svg('<path d="M3 17v-4a9 9 0 0 1 18 0v4"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/>'),
  headphonesOff: svg(
    '<path d="M3 17v-4a9 9 0 0 1 14.5-7.1"/><path d="M20.3 9.5A9 9 0 0 1 21 13v4"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/><path d="M3 3l18 18"/>',
  ),
  gear: svg(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  ),
  screen: svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M9 10.5l3-3 3 3M12 7.5V14"/>'),
  screenOff: svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M9 8l6 6M15 8l-6 6"/>'),
  camera: svg('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>'),
  cameraOff: svg('<path d="M16 16v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1"/><path d="M9.5 5H14a2 2 0 0 1 2 2v3.5l1 1L22 7v10"/><path d="M2 2l20 20"/>'),
  hangup: svg(
    '<path d="M3.6 14.9l-1-1.7a1.5 1.5 0 0 1 .3-1.9C5.2 9.3 8.5 8 12 8s6.8 1.3 9.1 3.3a1.5 1.5 0 0 1 .3 1.9l-1 1.7a1.5 1.5 0 0 1-1.9.6l-2.4-1a1.5 1.5 0 0 1-.9-1.3l-.1-1.6a12 12 0 0 0-6.2 0l-.1 1.6a1.5 1.5 0 0 1-.9 1.3l-2.4 1a1.5 1.5 0 0 1-1.9-.6z"/>',
  ),
  speaker: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.8 7L3 21l2-5.3A8 8 0 1 1 21 12z"/>'),
  users: svg('<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  send: svg('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>'),
  maximize: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  signal: svg('<path d="M4 20v-3M9 20v-7M14 20v-11M19 20V4"/>'),
  wave: svg('<path d="M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h0"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>'),
  volume: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
};
