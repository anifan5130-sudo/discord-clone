import { icons } from './icons.js';
import { api, connectEvents, getToken, setToken } from './api.js';
import { settings, saveSettings, SCREEN_QUALITIES, CAMERA_QUALITIES, keyLabel } from './settings.js';
import { sounds } from './sounds.js';
import { MicPipeline } from './audio/mic.js';
import { VoiceSession } from './voice.js';

// ============================================================ утилиты DOM
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function setIcon(el, name) {
  if (!el || el.dataset.iconNow === name) return;
  el.dataset.iconNow = name;
  el.innerHTML = icons[name] || '';
}
function hydrateIcons(root = document) {
  for (const el of $$('[data-icon]', root)) setIcon(el, el.dataset.icon);
}

function avatar(name, color, cls = '') {
  return h('div', { class: `avatar ${cls}`, style: `background:${color}` }, (name || '?').trim().charAt(0));
}

function toast(text, isError = false) {
  const t = h('div', { class: `toast${isError ? ' err' : ''}` }, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), isError ? 5000 : 3000);
}

let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderRooms();
    renderStage();
    renderControls();
  });
}

// ============================================================ состояние
const state = {
  info: { name: 'Voxa', passwordRequired: false },
  me: null,
  rooms: [],
  online: [],
  selectedRoomId: null,
  messages: new Map(),
  hasMore: new Map(),
  unread: new Map(),
  voice: null,
  voiceRoomId: null,
  joining: false,
  muted: false,
  deafened: false,
  speaking: new Set(),
  focusKey: null,
  settingsOpen: false,
};

const mic = new MicPipeline(settings);
sounds.enabled = settings.sounds;

const roomById = (id) => state.rooms.find((r) => r.id === id);
const selectedRoom = () => roomById(state.selectedRoomId);
const canManage = (room) => room && (state.me?.isAdmin || room.ownerId === state.me?.id);

// ============================================================ вход
async function boot() {
  hydrateIcons();
  try {
    state.info = await api('GET', '/info');
  } catch {}
  document.title = state.info.name;
  $('#server-name').textContent = state.info.name;
  $('#login-title').textContent = `Добро пожаловать в ${state.info.name}!`;

  if (getToken()) {
    try {
      const { user } = await api('GET', '/me');
      state.me = user;
      return enterApp();
    } catch (e) {
      if (e.status === 401) setToken('');
    }
  }
  showLogin();
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-pass-field span').textContent = state.info.passwordRequired ? 'Пароль сервера' : 'Пароль (необязательно)';
  $('#login-name').value = localStorage.getItem('voxa.lastName') || '';
  $('#login-name').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#login-name').value.trim();
  const password = $('#login-pass').value;
  $('#login-error').textContent = '';
  try {
    const { token, user } = await api('POST', '/login', { name, password });
    setToken(token);
    localStorage.setItem('voxa.lastName', name);
    state.me = user;
    enterApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

let stopEvents = null;
function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  renderMe();
  fillQualitySelect($('#sc-screen-quality'), SCREEN_QUALITIES, settings.screenQuality);
  stopEvents?.();
  stopEvents = connectEvents(
    {
      rooms: (rooms) => {
        const before = selectedRoom();
        state.rooms = rooms;
        const after = selectedRoom();
        // доступ к закрытой комнате только что открылся — подгружаем чат
        if (after && before && !before.access && after.access) loadMessages(after.id);
        if (after && before && before.access && !after.access) renderLockedChat(after);
        if (!after) {
          const saved = Number(localStorage.getItem('voxa.room'));
          selectRoom(roomById(saved) ? saved : rooms[0]?.id ?? null);
        } else scheduleRender();
      },
      online: (users) => {
        state.online = users;
        renderMembers();
      },
      message: onMessage,
      message_deleted: ({ id, roomId }) => {
        const list = state.messages.get(roomId);
        if (!list) return;
        const i = list.findIndex((m) => m.id === id);
        if (i >= 0) list.splice(i, 1);
        if (roomId === state.selectedRoomId) renderMessages(false);
      },
      room_deleted: ({ id }) => {
        state.messages.delete(id);
        state.unread.delete(id);
        if (state.voiceRoomId === id) {
          leaveVoice();
          toast('Комната удалена');
        }
      },
      __open: () => $('#conn-dot').classList.add('ok'),
      __error: () => $('#conn-dot').classList.remove('ok'),
    },
    () => logout(),
  );
}

async function logout() {
  await leaveVoice();
  try {
    await api('POST', '/logout');
  } catch {}
  setToken('');
  location.reload();
}

// ============================================================ комнаты (сайдбар)
function selectRoom(id) {
  state.selectedRoomId = id;
  if (id == null) return scheduleRender();
  state.unread.delete(id);
  localStorage.setItem('voxa.room', String(id));
  const room = roomById(id);
  if (room && !room.access) renderLockedChat(room);
  else if (!state.messages.has(id)) loadMessages(id);
  else renderMessages(true);
  renderHeader();
  scheduleRender();
}

function liveInfo(identity) {
  // для комнаты, где мы сейчас в голосе, берём живые данные из LiveKit
  if (!state.voice) return null;
  const tile = state.voice.tiles().find((t) => t.identity === identity && t.kind === 'camera');
  return tile || null;
}

function renderRooms() {
  const list = $('#room-list');
  const frag = document.createDocumentFragment();
  for (const room of state.rooms) {
    const unread = state.unread.get(room.id) || 0;
    const count = room.participants.length;
    const item = h(
      'div',
      {
        class: `room-item${room.id === state.selectedRoomId ? ' selected' : ''}`,
        title: room.topic || room.name,
        onclick: () => selectRoom(room.id),
        ondblclick: () => joinVoice(room.id),
      },
      h('span', { html: icons.speaker }),
      h('span', { class: 'name' }, room.name),
      room.locked ? h('span', { class: 'lock', html: icons.lock, title: 'С паролем' }) : null,
      room.userLimit ? h('span', { class: 'meta' }, `${count}/${room.userLimit}`) : null,
      unread ? h('span', { class: 'badge' }, unread > 99 ? '99+' : unread) : null,
    );
    frag.append(item);

    if (count) {
      const people = h('div', { class: 'room-people' });
      for (const p of room.participants) {
        const identity = String(p.id);
        const live = state.voiceRoomId === room.id ? liveInfo(identity) : null;
        const speaking = state.voiceRoomId === room.id && state.speaking.has(identity);
        people.append(
          h(
            'div',
            {
              class: 'person',
              oncontextmenu: (e) => {
                e.preventDefault();
                if (identity !== String(state.me.id)) volumePopover(e.clientX, e.clientY, identity, p.name);
              },
            },
            h('div', { class: `avatar xs${speaking ? ' speaking' : ''}`, style: `background:${p.color}`, dataset: { speakId: identity } }, p.name.charAt(0)),
            h('span', { class: 'name' }, p.name),
            p.screen ? h('span', { class: 'live-badge' }, 'В ЭФИРЕ') : null,
            p.camera ? h('span', { html: icons.camera }) : null,
            live?.muted ? h('span', { html: icons.micOff, title: 'Микрофон выключен' }) : null,
          ),
        );
      }
      frag.append(people);
    }
  }
  list.replaceChildren(frag);
}

function renderHeader() {
  const room = selectedRoom();
  $('#room-title').textContent = room?.name || '—';
  $('#room-topic').textContent = room?.topic || '';
  $('#btn-room-settings').hidden = !canManage(room);
  $('#composer-input').placeholder = room ? `Написать в «${room.name}»` : 'Выберите комнату';
  renderComposerState();
}

function renderMembers() {
  $('#members-title').textContent = `В сети — ${state.online.length}`;
  $('#member-list').replaceChildren(
    ...state.online.map((u) => h('div', { class: 'member' }, avatar(u.name, u.color, 'sm'), h('span', { class: 'name' }, u.name))),
  );
}

function renderMe() {
  const me = state.me;
  $('#me-name').textContent = me.name;
  $('#me-avatar').replaceWith(Object.assign(avatar(me.name, me.color, 'sm'), { id: 'me-avatar' }));
  renderControls();
}

// ============================================================ сцена (голос/видео)
const tileEls = new Map();

function renderStage() {
  const room = selectedRoom();
  const body = $('#room-body');
  const inHere = !!state.voice && state.voiceRoomId === state.selectedRoomId;
  body.classList.toggle('idle', !inHere);
  body.classList.toggle('in-voice', inHere);
  body.classList.toggle('chat-hidden', inHere && !settings.chatOpen);
  $('#btn-toggle-chat').classList.toggle('toggled', !inHere || settings.chatOpen);
  $('#stage-idle').hidden = inHere;
  $('#grid').hidden = !inHere;
  $('#stage-controls').hidden = !inHere;
  renderHeader();

  if (!inHere) {
    clearTiles();
    const people = room?.participants || [];
    $('#idle-avatars').replaceChildren(...people.slice(0, 12).map((p) => avatar(p.name, p.color)));
    $('#idle-title').textContent = !room
      ? 'Нет комнат — создайте первую'
      : people.length
        ? `Сейчас в комнате: ${people.length}`
        : 'В комнате пока никого';
    $('#idle-sub').textContent = people.length
      ? people.map((p) => p.name).slice(0, 6).join(', ') + (people.length > 6 ? '…' : '')
      : 'Заходи — остальные подтянутся';
    const btn = $('#btn-join');
    btn.hidden = !room;
    btn.disabled = state.joining;
    btn.textContent = state.joining ? 'Подключение…' : state.voice ? 'Перейти в эту комнату' : 'Присоединиться';
    return;
  }
  renderGrid();
}

function clearTiles() {
  for (const t of tileEls.values()) {
    t.track?.detach(t.video);
    t.el.remove();
  }
  tileEls.clear();
}

function renderGrid() {
  const grid = $('#grid');
  const tiles = state.voice.tiles();
  const keys = new Set(tiles.map((t) => t.key));
  for (const [k, t] of tileEls) {
    if (!keys.has(k)) {
      t.track?.detach(t.video);
      t.el.remove();
      tileEls.delete(k);
    }
  }
  if (state.focusKey && !keys.has(state.focusKey)) state.focusKey = null;

  for (const t of tiles) updateTile(t);

  const focused = state.focusKey;
  grid.classList.toggle('focus', !!focused);
  if (focused) {
    const strip = h('div', { class: 'strip' });
    for (const t of tiles) if (t.key !== focused) strip.append(tileEls.get(t.key).el);
    tileEls.get(focused).el.classList.add('focused');
    grid.replaceChildren(tileEls.get(focused).el, ...(strip.children.length ? [strip] : []));
  } else {
    for (const t of tileEls.values()) t.el.classList.remove('focused');
    const n = tiles.length;
    grid.style.setProperty('--cols', n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);
    grid.replaceChildren(...tiles.map((t) => tileEls.get(t.key).el));
  }
}

function updateTile(t) {
  let rec = tileEls.get(t.key);
  if (!rec) {
    const video = h('video', { autoplay: true, playsinline: true });
    video.muted = true; // звук идёт отдельными <audio>
    const label = h('div', { class: 'tile-label' });
    const actions = h('div', { class: 'tile-actions' });
    const el = h('div', {
      class: `tile ${t.kind}${t.isLocal ? ' local' : ''}`,
      dataset: { speakId: t.kind === 'camera' ? t.identity : '' },
      onclick: () => {
        state.focusKey = state.focusKey === t.key ? null : t.key;
        renderGrid();
      },
      ondblclick: (e) => {
        e.stopPropagation();
        fullscreen(el);
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        if (!t.isLocal) volumePopover(e.clientX, e.clientY, t.kind === 'screen' ? `${t.identity}:stream` : t.identity, t.name, t.kind === 'screen');
      },
    });
    const fsBtn = h('button', { class: 'icon-btn', title: 'Во весь экран', html: icons.maximize, onclick: (e) => (e.stopPropagation(), fullscreen(el)) });
    actions.append(fsBtn);
    if (t.kind === 'screen' && !t.isLocal) {
      actions.prepend(
        h('button', {
          class: 'icon-btn',
          title: 'Громкость трансляции',
          html: icons.volume,
          onclick: (e) => {
            e.stopPropagation();
            volumePopover(e.clientX, e.clientY, `${t.identity}:stream`, t.name, true);
          },
        }),
      );
    }
    el.append(video, label, actions);
    rec = { el, video, label, track: null, center: null };
    tileEls.set(t.key, rec);
  }

  // видео
  if (t.track !== rec.track) {
    rec.track?.detach(rec.video);
    rec.track = t.track;
    if (t.track) t.track.attach(rec.video);
  }
  rec.video.hidden = !t.track;

  // заглушка без видео
  const centerKey = t.track ? 'none' : t.kind === 'screen' ? 'wait' : `av:${t.name}:${t.color}`;
  if (rec.center?.key !== centerKey) {
    rec.center?.el.remove();
    let el = null;
    if (!t.track) el = t.kind === 'screen' ? h('div', { class: 'waiting' }, 'Подключение к трансляции…') : avatar(t.name, t.color);
    if (el) rec.el.insertBefore(el, rec.label);
    rec.center = { key: centerKey, el };
  }

  // подпись
  const title = t.kind === 'screen' ? (t.isLocal ? 'Ваш экран' : `Экран: ${t.name}`) : t.isLocal ? `${t.name} (вы)` : t.name;
  const labelKey = `${title}|${t.muted}`;
  if (rec.label.dataset.key !== labelKey) {
    rec.label.dataset.key = labelKey;
    rec.label.replaceChildren(t.muted ? h('i', { html: icons.micOff }) : '', h('span', {}, title));
  }
  rec.el.classList.toggle('speaking', t.kind === 'camera' && state.speaking.has(t.identity));
}

function fullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().catch(() => {});
}

function updateSpeaking() {
  for (const el of $$('[data-speak-id]')) {
    const id = el.dataset.speakId;
    if (!id) continue;
    el.classList.toggle('speaking', state.speaking.has(id));
  }
}

// ============================================================ кнопки управления
function renderControls() {
  const v = state.voice;
  const muted = state.muted || state.deafened;
  for (const id of ['#btn-mute', '#sc-mute']) {
    const b = $(id);
    setIcon(b, muted ? 'micOff' : 'mic');
    b.title = muted ? 'Включить микрофон (Ctrl+Shift+M)' : 'Выключить микрофон (Ctrl+Shift+M)';
  }
  $('#btn-mute').classList.toggle('active-red', muted);
  $('#sc-mute').classList.toggle('off', muted);
  for (const id of ['#btn-deafen', '#sc-deafen']) {
    const b = $(id);
    setIcon(b, state.deafened ? 'headphonesOff' : 'headphones');
    b.title = state.deafened ? 'Включить звук (Ctrl+Shift+D)' : 'Выключить звук (Ctrl+Shift+D)';
  }
  $('#btn-deafen').classList.toggle('active-red', state.deafened);
  $('#sc-deafen').classList.toggle('off', state.deafened);

  const cam = !!v?.cameraOn;
  const scr = !!v?.screenSharing;
  setIcon($('#sc-camera'), cam ? 'camera' : 'cameraOff');
  $('#sc-camera').classList.toggle('on', cam);
  $('#vp-camera').classList.toggle('on', cam);
  setIcon($('#sc-screen'), scr ? 'screenOff' : 'screen');
  $('#sc-screen').classList.toggle('on', scr);
  $('#sc-screen').title = scr ? 'Остановить демонстрацию' : 'Демонстрация экрана';
  $('#vp-screen').classList.toggle('on', scr);

  $('#voice-panel').hidden = !v;
  if (v) {
    const room = roomById(state.voiceRoomId);
    $('#voice-room-name').textContent = room?.name || '';
    const st = $('#voice-state');
    const labels = { connecting: 'Подключение…', connected: 'Голос подключён', reconnecting: 'Переподключение…' };
    st.querySelector('b').textContent = labels[v.state] || 'Голос';
    st.classList.toggle('warn', v.state !== 'connected');
  }
  $('#me-status').textContent = settings.pttEnabled
    ? `Рация: ${keyLabel(settings.pttKey)}`
    : v
      ? 'В голосе'
      : 'В сети';
}

// ============================================================ вход в голос
async function joinVoice(roomId) {
  if (state.joining) return;
  if (state.voice && state.voiceRoomId === roomId) return selectRoom(roomId);
  const room = roomById(roomId);
  if (!room) return;
  let password;
  if (room.locked && !room.access) {
    password = await askPassword();
    if (password == null) return;
  }
  state.joining = true;
  selectRoom(roomId);
  let session = null;
  try {
    const creds = await api('POST', `/rooms/${roomId}/join`, { password });
    if (state.voice) await leaveVoice(true);
    // сначала микрофон — так ошибка доступа не оставит «висящее» подключение
    await mic.start();
    session = new VoiceSession({ roomId, mic, settings });
    session.muted = state.muted;
    session.deafened = state.deafened;
    wireSession(session);
    state.voice = session;
    state.voiceRoomId = roomId;
    await session.connect(creds);
    sounds.play('selfJoin');
  } catch (e) {
    console.error(e);
    if (session) {
      await session.disconnect();
      if (state.voice === session) {
        state.voice = null;
        state.voiceRoomId = null;
      }
    }
    if (!state.voice && !state.settingsOpen) mic.stop();
    toast(describeError(e), true);
  } finally {
    state.joining = false;
    scheduleRender();
  }
}

function describeError(e) {
  if (e?.name === 'NotAllowedError') return 'Нет доступа к микрофону — разрешите его в настройках браузера';
  if (e?.name === 'NotFoundError') return 'Микрофон не найден';
  if (e?.name === 'NotReadableError') return 'Микрофон занят другим приложением';
  if (!window.isSecureContext) return 'Голос работает только по HTTPS';
  return e?.message || 'Не удалось подключиться';
}

function wireSession(s) {
  s.addEventListener('update', scheduleRender);
  s.addEventListener('state', scheduleRender);
  s.addEventListener('speakers', (e) => {
    state.speaking = new Set(e.detail.map((p) => p.identity));
    updateSpeaking();
  });
  s.addEventListener('participant-joined', () => sounds.play('join'));
  s.addEventListener('participant-left', () => sounds.play('leave'));
  s.addEventListener('stream-started', (e) => {
    sounds.play('stream');
    if (!state.focusKey) state.focusKey = `${e.detail.identity}:screen`;
  });
  s.addEventListener('playback', (e) => ($('#btn-playback').hidden = e.detail));
  s.addEventListener('quality', (e) => ($('#voice-state').title = `Качество связи: ${e.detail}`));
  s.addEventListener('error', (e) => toast(describeError(e.detail), true));
  s.addEventListener('disconnected', () => {
    if (state.voice !== s) return;
    state.voice = null;
    state.voiceRoomId = null;
    state.focusKey = null;
    state.speaking.clear();
    if (!state.settingsOpen) mic.stop();
    sounds.play('disconnect');
    toast('Соединение с голосовой комнатой потеряно', true);
    scheduleRender();
  });
}

async function leaveVoice(silent = false) {
  const s = state.voice;
  if (!s) return;
  state.voice = null;
  state.voiceRoomId = null;
  state.focusKey = null;
  state.speaking.clear();
  clearTiles();
  await s.disconnect();
  if (!state.settingsOpen) await mic.stop();
  $('#btn-playback').hidden = true;
  if (!silent) sounds.play('disconnect');
  scheduleRender();
}

async function toggleMute() {
  if (state.deafened) {
    state.deafened = false;
    state.muted = false;
    await state.voice?.setDeafened(false);
  } else {
    state.muted = !state.muted;
  }
  await state.voice?.setMuted(state.muted);
  sounds.play(state.muted ? 'mute' : 'unmute');
  renderControls();
  scheduleRender();
}

async function toggleDeafen() {
  state.deafened = !state.deafened;
  await state.voice?.setDeafened(state.deafened);
  sounds.play(state.deafened ? 'mute' : 'unmute');
  renderControls();
  scheduleRender();
}

async function toggleScreen() {
  if (!state.voice) return;
  try {
    const on = await state.voice.toggleScreenShare(settings.screenQuality);
    if (on) state.focusKey = `${state.me.id}:screen`;
  } catch (e) {
    toast(`Не удалось начать демонстрацию: ${e.message}`, true);
  }
  scheduleRender();
}

async function toggleCamera() {
  if (!state.voice) return;
  try {
    await state.voice.toggleCamera();
  } catch (e) {
    toast(e?.name === 'NotAllowedError' ? 'Нет доступа к камере' : `Камера: ${e.message}`, true);
  }
  scheduleRender();
}

$('#btn-join').addEventListener('click', () => joinVoice(state.selectedRoomId));
$('#btn-mute').addEventListener('click', toggleMute);
$('#sc-mute').addEventListener('click', toggleMute);
$('#btn-deafen').addEventListener('click', toggleDeafen);
$('#sc-deafen').addEventListener('click', toggleDeafen);
$('#sc-screen').addEventListener('click', toggleScreen);
$('#vp-screen').addEventListener('click', toggleScreen);
$('#sc-camera').addEventListener('click', toggleCamera);
$('#vp-camera').addEventListener('click', toggleCamera);
$('#sc-leave').addEventListener('click', () => leaveVoice());
$('#vp-leave').addEventListener('click', () => leaveVoice());
$('#voice-room-name').addEventListener('click', () => selectRoom(state.voiceRoomId));
$('#btn-playback').addEventListener('click', async () => {
  await state.voice?.startAudio();
  $('#btn-playback').hidden = true;
});
$('#btn-toggle-chat').addEventListener('click', () => {
  saveSettings({ chatOpen: !settings.chatOpen });
  scheduleRender();
});
$('#sc-screen-quality').addEventListener('change', (e) => {
  saveSettings({ screenQuality: e.target.value });
  if (state.voice?.screenSharing) toast('Новое качество применится при следующем запуске демонстрации');
});

// ============================================================ рация и горячие клавиши
let pttTimer = null;
let pttHeld = false;
function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'range' && a.type !== 'checkbox' && a.type !== 'radio'));
}
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|CapsLock|Mouse|F\d)/;

function pttDown(code) {
  if (!settings.pttEnabled || code !== settings.pttKey || capturingKey) return false;
  clearTimeout(pttTimer);
  if (!pttHeld) {
    pttHeld = true;
    mic.setPttPressed(true);
    $('#me-avatar').classList.add('speaking');
  }
  return true;
}
function pttUp(code) {
  if (!settings.pttEnabled || code !== settings.pttKey) return;
  clearTimeout(pttTimer);
  pttTimer = setTimeout(() => {
    pttHeld = false;
    mic.setPttPressed(false);
    $('#me-avatar').classList.remove('speaking');
  }, settings.pttReleaseMs);
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyM') {
    e.preventDefault();
    return toggleMute();
  }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    return toggleDeafen();
  }
  if (e.code === 'Escape') closePopover();
  if (e.repeat) return;
  if (isTyping() && !MODIFIER_CODES.test(e.code)) return;
  if (pttDown(e.code) && !isTyping()) e.preventDefault();
});
window.addEventListener('keyup', (e) => pttUp(e.code));
window.addEventListener('mousedown', (e) => {
  if (e.button >= 3) pttDown(`Mouse${e.button + 1}`);
});
window.addEventListener('mouseup', (e) => {
  if (e.button >= 3) pttUp(`Mouse${e.button + 1}`);
});
window.addEventListener('blur', () => {
  if (pttHeld) pttUp(settings.pttKey);
});

// индикатор «я говорю» по данным гейта — мгновенно, без сервера
mic.addEventListener('open', (e) => {
  if (settings.pttEnabled) return;
  $('#me-avatar')?.classList.toggle('speaking', e.detail && !!state.voice && !state.muted && !state.deafened);
});

// ============================================================ громкость участника
function volumePopover(x, y, key, name, isStream = false) {
  const pop = $('#popover');
  const current = settings.userVolumes[key] ?? 1;
  const val = h('b', {}, `${Math.round(current * 100)}%`);
  const range = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: current });
  range.addEventListener('input', () => {
    const v = Number(range.value);
    val.textContent = `${Math.round(v * 100)}%`;
    settings.userVolumes[key] = v;
    saveSettings();
    state.voice?.refreshVolumes();
  });
  pop.replaceChildren(
    h('h4', {}, isStream ? `Трансляция: ${name}` : name),
    h('label', { class: 'field' }, h('span', {}, 'Громкость ', val), range),
  );
  pop.hidden = false;
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  pop.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  setTimeout(() => document.addEventListener('mousedown', outsidePopover), 0);
}
function outsidePopover(e) {
  if (!$('#popover').contains(e.target)) closePopover();
}
function closePopover() {
  $('#popover').hidden = true;
  document.removeEventListener('mousedown', outsidePopover);
}

// ============================================================ чат
async function loadMessages(roomId, older = false) {
  const list = state.messages.get(roomId) || [];
  const before = older && list.length ? list[0].id : '';
  try {
    const { messages } = await api('GET', `/rooms/${roomId}/messages${before ? `?before=${before}` : ''}`);
    const cur = state.messages.get(roomId) || [];
    const ids = new Set(cur.map((m) => m.id));
    const merged = older ? [...messages, ...cur] : [...messages.filter((m) => !ids.has(m.id)), ...cur];
    merged.sort((a, b) => a.id - b.id);
    state.messages.set(roomId, merged);
    state.hasMore.set(roomId, messages.length === 50);
    if (roomId === state.selectedRoomId) renderMessages(!older, older);
  } catch (e) {
    toast(e.message, true);
  }
}

function onMessage(msg) {
  const list = state.messages.get(msg.roomId);
  if (list && !list.some((m) => m.id === msg.id)) list.push(msg);
  const mine = msg.userId === state.me.id;
  if (msg.roomId === state.selectedRoomId) {
    renderMessages(mine || nearBottom());
    if (!mine && document.hidden) sounds.play('message');
  } else if (!mine) {
    state.unread.set(msg.roomId, (state.unread.get(msg.roomId) || 0) + 1);
    sounds.play('message');
    scheduleRender();
  }
}

function nearBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

function renderLockedChat(room) {
  $('#messages').replaceChildren(
    h(
      'div',
      { class: 'chat-empty' },
      h('div', { html: icons.lock, style: 'display:grid;place-items:center;margin-bottom:8px' }),
      `Комната «${room.name}» закрыта паролем.`,
      h('br'),
      h('button', {
        class: 'btn btn-primary',
        style: 'margin-top:12px',
        onclick: async () => {
          const password = await askPassword();
          if (password == null) return;
          try {
            await api('POST', `/rooms/${room.id}/unlock`, { password });
          } catch (e) {
            toast(e.message, true);
          }
        },
      }, 'Ввести пароль'),
    ),
  );
  renderComposerState();
}

function renderComposerState() {
  const room = selectedRoom();
  const ok = !!room && room.access;
  $('#composer-input').disabled = !ok;
  $('#composer').style.opacity = ok ? 1 : 0.5;
}

function renderMessages(scrollToBottom = false, keepOffset = false) {
  renderComposerState();
  const box = $('#messages');
  const room = selectedRoom();
  const list = state.messages.get(state.selectedRoomId) || [];
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  const frag = document.createDocumentFragment();

  if (!list.length) {
    frag.append(h('div', { class: 'chat-empty' }, room ? `Это начало комнаты «${room.name}». Напишите что-нибудь!` : ''));
  }
  let prev = null;
  for (const m of list) {
    const newDay = !prev || fmtDay(prev.ts) !== fmtDay(m.ts);
    if (newDay) frag.append(h('div', { class: 'day-sep' }, fmtDay(m.ts)));
    const head = newDay || prev.userId !== m.userId || m.ts - prev.ts > 7 * 60_000;
    const canDelete = m.userId === state.me.id || canManage(room);
    frag.append(
      h(
        'div',
        { class: `msg${head ? ' head' : ''}` },
        head ? avatar(m.name, m.color) : null,
        head ? h('div', { class: 'who' }, h('b', { style: `color:${m.color}` }, m.name), h('time', {}, fmtTime(m.ts))) : null,
        h('div', { class: 'text', title: head ? '' : fmtTime(m.ts) }, linkify(m.text)),
        canDelete
          ? h('button', {
              class: 'icon-btn del',
              title: 'Удалить',
              html: icons.trash,
              onclick: async () => {
                if (!confirm('Удалить сообщение?')) return;
                try {
                  await api('DELETE', `/messages/${m.id}`);
                } catch (e) {
                  toast(e.message, true);
                }
              },
            })
          : null,
      ),
    );
    prev = m;
  }
  box.replaceChildren(frag);
  if (keepOffset) box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  else if (scrollToBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop;
}

$('#messages').addEventListener('scroll', () => {
  const box = $('#messages');
  const id = state.selectedRoomId;
  if (box.scrollTop < 60 && state.hasMore.get(id) && !box.dataset.loading) {
    box.dataset.loading = '1';
    loadMessages(id, true).finally(() => delete box.dataset.loading);
  }
});

const input = $('#composer-input');
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !state.selectedRoomId) return;
  input.value = '';
  autosize();
  try {
    await api('POST', `/rooms/${state.selectedRoomId}/messages`, { text });
  } catch (err) {
    input.value = text;
    autosize();
    toast(err.message, true);
  }
});

// ============================================================ модальные окна
function openModal(id) {
  $(id).hidden = false;
}
function closeModal(id) {
  $(id).hidden = true;
}
for (const m of $$('.modal-backdrop')) {
  m.addEventListener('mousedown', (e) => {
    if (e.target === m) m.querySelector('[data-close]')?.click();
  });
  for (const b of $$('[data-close]', m)) b.addEventListener('click', () => (m.id === 'modal-settings' ? closeSettings() : closeModal(`#${m.id}`)));
}
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || capturingKey) return;
  const open = $$('.modal-backdrop').find((m) => !m.hidden);
  open?.querySelector('[data-close]')?.click();
});

let passwordResolve = null;
function askPassword() {
  const form = $('#password-form');
  form.reset();
  $('#password-error').textContent = '';
  openModal('#modal-password');
  form.password.focus();
  return new Promise((resolve) => (passwordResolve = resolve));
}
$('#password-form').addEventListener('submit', (e) => {
  e.preventDefault();
  closeModal('#modal-password');
  passwordResolve?.(e.target.password.value);
  passwordResolve = null;
});
$('#modal-password [data-close]').addEventListener('click', () => {
  passwordResolve?.(null);
  passwordResolve = null;
});

let editingRoom = null;
function openRoomModal(room = null) {
  editingRoom = room;
  const f = $('#room-form');
  f.reset();
  $('#room-form-error').textContent = '';
  $('#room-form-title').textContent = room ? 'Настройки комнаты' : 'Создать комнату';
  $('#room-form-submit').textContent = room ? 'Сохранить' : 'Создать';
  $('#room-delete').hidden = !room;
  f.password.placeholder = room?.locked ? 'Пусто — оставить как есть, «-» — убрать пароль' : '';
  if (room) {
    f.name.value = room.name;
    f.topic.value = room.topic || '';
    f.userLimit.value = room.userLimit || 0;
  }
  openModal('#modal-room');
  f.name.focus();
}
$('#add-room').addEventListener('click', () => openRoomModal());
$('#btn-room-settings').addEventListener('click', () => openRoomModal(selectedRoom()));
$('#room-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value, topic: f.topic.value, userLimit: Number(f.userLimit.value) || 0 };
  const pw = f.password.value;
  try {
    if (editingRoom) {
      if (pw === '-') body.password = '';
      else if (pw) body.password = pw;
      await api('PATCH', `/rooms/${editingRoom.id}`, body);
    } else {
      if (pw) body.password = pw;
      const { id } = await api('POST', '/rooms', body);
      setTimeout(() => selectRoom(id), 200);
    }
    closeModal('#modal-room');
  } catch (err) {
    $('#room-form-error').textContent = err.message;
  }
});
$('#room-delete').addEventListener('click', async () => {
  if (!editingRoom || !confirm(`Удалить комнату «${editingRoom.name}» вместе с историей чата?`)) return;
  try {
    await api('DELETE', `/rooms/${editingRoom.id}`);
    closeModal('#modal-room');
    state.selectedRoomId = null;
  } catch (err) {
    $('#room-form-error').textContent = err.message;
  }
});

// ============================================================ настройки
function fillQualitySelect(sel, table, value) {
  sel.replaceChildren(...Object.entries(table).map(([k, q]) => h('option', { value: k }, q.label)));
  sel.value = value;
}

async function fillDevices() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {}
  const fill = (sel, kind, value, defLabel) => {
    const opts = devices.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
    sel.replaceChildren(
      h('option', { value: '' }, defLabel),
      ...opts.map((d, i) => h('option', { value: d.deviceId }, d.label || `Устройство ${i + 1}`)),
    );
    sel.value = opts.some((d) => d.deviceId === value) ? value : '';
  };
  fill($('#set-input'), 'audioinput', settings.inputDeviceId, 'По умолчанию');
  fill($('#set-output'), 'audiooutput', settings.outputDeviceId, 'По умолчанию');
  fill($('#set-camera'), 'videoinput', settings.cameraDeviceId, 'По умолчанию');
  $('#set-output').disabled = !('setSinkId' in HTMLMediaElement.prototype);
}

const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 90) / 90) * 100));
function onLevel(e) {
  const fill = $('#meter-fill');
  fill.style.width = `${dbToPct(e.detail.level)}%`;
  fill.classList.toggle('open', e.detail.open);
}

function syncSettingsForm() {
  $('#set-input-vol').value = settings.inputVolume;
  $('#set-input-vol-val').textContent = `${Math.round(settings.inputVolume * 100)}%`;
  for (const r of $$('input[name=noise]')) r.checked = r.value === settings.noiseMode;
  $('#set-ec').checked = settings.echoCancellation;
  $('#set-agc').checked = settings.autoGainControl;
  $('#set-gate').checked = settings.gateEnabled;
  $('#set-gate-threshold').value = settings.gateThreshold;
  $('#set-gate-threshold').disabled = !settings.gateEnabled;
  $('#set-gate-val').textContent = `${settings.gateThreshold} дБ`;
  $('#meter-mark').style.left = `${dbToPct(settings.gateThreshold)}%`;
  $('#meter-mark').hidden = !settings.gateEnabled || settings.pttEnabled;
  $('#set-ptt').checked = settings.pttEnabled;
  $('#ptt-opts').style.opacity = settings.pttEnabled ? 1 : 0.5;
  $('#set-ptt-key').textContent = keyLabel(settings.pttKey);
  $('#set-ptt-delay').value = settings.pttReleaseMs;
  $('#set-ptt-delay-val').textContent = `${settings.pttReleaseMs} мс`;
  $('#set-bitrate').value = String(settings.bitrate);
  $('#set-sounds').checked = settings.sounds;
  fillQualitySelect($('#set-camera-quality'), CAMERA_QUALITIES, settings.cameraQuality);
  fillQualitySelect($('#set-screen-quality'), SCREEN_QUALITIES, settings.screenQuality);
  $('#set-name').value = state.me.name;
  renderColors(state.me.color);
}

let pickedColor = null;
function renderColors(current) {
  pickedColor = current;
  const colors = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#3ba55d', '#faa61a', '#00b0f4', '#9b59b6', '#e67e22'];
  $('#set-colors').replaceChildren(
    ...colors.map((c) =>
      h('button', {
        type: 'button',
        class: c === current ? 'sel' : '',
        style: `background:${c}`,
        onclick: () => renderColors(c),
      }),
    ),
  );
}

async function openSettings() {
  state.settingsOpen = true;
  syncSettingsForm();
  openModal('#modal-settings');
  mic.addEventListener('level', onLevel);
  try {
    await mic.start();
  } catch (e) {
    toast(describeError(e), true);
  }
  fillDevices();
}

function closeSettings() {
  state.settingsOpen = false;
  closeModal('#modal-settings');
  mic.removeEventListener('level', onLevel);
  mic.setMonitor(false);
  $('#btn-mic-test').textContent = 'Послушать себя';
  if (!state.voice) mic.stop();
}

async function applyMic(patch) {
  saveSettings(patch);
  try {
    await mic.update(patch);
  } catch (e) {
    toast(describeError(e), true);
  }
  syncSettingsForm();
  renderControls();
}

mic.addEventListener('source', (e) => {
  const names = { rnnoise: 'нейросетевое (RNNoise)', browser: 'стандартное браузерное', off: 'выключено' };
  $('#noise-active').textContent = `Сейчас работает: ${names[e.detail.mode]}${e.detail.label ? ` · ${e.detail.label}` : ''}`;
});

$('#btn-settings').addEventListener('click', openSettings);
for (const b of $$('.settings-nav [data-tab]')) {
  b.addEventListener('click', () => {
    $$('.settings-nav [data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
  });
}
$('#set-input').addEventListener('change', (e) => applyMic({ inputDeviceId: e.target.value }));
$('#set-output').addEventListener('change', (e) => {
  saveSettings({ outputDeviceId: e.target.value });
  state.voice?.setOutputDevice(e.target.value);
});
$('#set-input-vol').addEventListener('input', (e) => applyMic({ inputVolume: Number(e.target.value) }));
for (const r of $$('input[name=noise]')) r.addEventListener('change', () => applyMic({ noiseMode: r.value }));
$('#set-ec').addEventListener('change', (e) => applyMic({ echoCancellation: e.target.checked }));
$('#set-agc').addEventListener('change', (e) => applyMic({ autoGainControl: e.target.checked }));
$('#set-gate').addEventListener('change', (e) => applyMic({ gateEnabled: e.target.checked }));
$('#set-gate-threshold').addEventListener('input', (e) => applyMic({ gateThreshold: Number(e.target.value) }));
$('#set-ptt').addEventListener('change', (e) => applyMic({ pttEnabled: e.target.checked }));
$('#set-ptt-delay').addEventListener('input', (e) => {
  saveSettings({ pttReleaseMs: Number(e.target.value) });
  syncSettingsForm();
});
$('#set-bitrate').addEventListener('change', async (e) => {
  saveSettings({ bitrate: Number(e.target.value) });
  if (state.voice) {
    try {
      await state.voice.republishMic();
      toast('Битрейт обновлён');
    } catch (err) {
      toast(err.message, true);
    }
  }
});
$('#set-sounds').addEventListener('change', (e) => {
  saveSettings({ sounds: e.target.checked });
  sounds.enabled = e.target.checked;
});
$('#set-camera').addEventListener('change', (e) => {
  saveSettings({ cameraDeviceId: e.target.value });
  if (state.voice?.cameraOn) state.voice.room.switchActiveDevice('videoinput', e.target.value || 'default').catch(() => {});
});
$('#set-camera-quality').addEventListener('change', (e) => saveSettings({ cameraQuality: e.target.value }));
$('#set-screen-quality').addEventListener('change', (e) => {
  saveSettings({ screenQuality: e.target.value });
  $('#sc-screen-quality').value = e.target.value;
});
$('#btn-mic-test').addEventListener('click', (e) => {
  const on = !mic.monitorNode;
  mic.setMonitor(on);
  e.target.textContent = on ? 'Остановить проверку' : 'Послушать себя';
});

let capturingKey = false;
$('#set-ptt-key').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  capturingKey = true;
  btn.textContent = 'Нажмите клавишу…';
  const finish = (code) => {
    capturingKey = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouse, true);
    if (code) saveSettings({ pttKey: code });
    syncSettingsForm();
    renderControls();
  };
  const onKey = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    finish(ev.code === 'Escape' ? null : ev.code);
  };
  const onMouse = (ev) => {
    if (ev.button >= 3) {
      ev.preventDefault();
      finish(`Mouse${ev.button + 1}`);
    }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onMouse, true);
});

$('#btn-save-profile').addEventListener('click', async () => {
  $('#profile-error').textContent = '';
  try {
    const { user } = await api('PATCH', '/me', { name: $('#set-name').value, color: pickedColor });
    state.me = user;
    renderMe();
    toast('Профиль сохранён. В голосе новое имя появится после переподключения.');
  } catch (e) {
    $('#profile-error').textContent = e.message;
  }
});
$('#btn-logout').addEventListener('click', logout);

navigator.mediaDevices?.addEventListener?.('devicechange', () => state.settingsOpen && fillDevices());
window.addEventListener('beforeunload', () => state.voice?.room?.disconnect());

boot();
