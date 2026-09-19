// Голосовая сессия поверх LiveKit: голос, камера, демонстрация экрана, громкости.
import { Room, RoomEvent, Track, ConnectionQuality } from 'livekit-client';
import { SCREEN_QUALITIES, CAMERA_QUALITIES } from './settings.js';

export class VoiceSession extends EventTarget {
  constructor({ roomId, mic, settings }) {
    super();
    this.roomId = roomId;
    this.mic = mic;
    this.settings = settings;
    this.room = null;
    this.micPub = null;
    this.muted = false;
    this.deafened = false;
    this.audioBox = document.createElement('div');
    this.audioBox.hidden = true;
    document.body.append(this.audioBox);
    this.state = 'connecting';
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async connect({ url, token }) {
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      audioOutput: this.settings.outputDeviceId ? { deviceId: this.settings.outputDeviceId } : undefined,
      publishDefaults: {
        videoCodec: 'vp8',
        simulcast: true,
        dtx: true,
        red: true,
      },
    });
    this.room = room;

    room
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.dataset.identity = participant.identity;
          this.audioBox.append(el);
          this.applyVolume(participant);
          if (this.settings.outputDeviceId && el.setSinkId) el.setSinkId(this.settings.outputDeviceId).catch(() => {});
        }
        if (pub.source === Track.Source.ScreenShare) this.emit('stream-started', participant);
        this.emit('update');
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((el) => el.remove());
        this.emit('update');
      })
      .on(RoomEvent.ParticipantConnected, (p) => {
        this.emit('participant-joined', p);
        this.emit('update');
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        this.emit('participant-left', p);
        this.emit('update');
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => this.emit('speakers', speakers))
      .on(RoomEvent.TrackMuted, () => this.emit('update'))
      .on(RoomEvent.TrackUnmuted, () => this.emit('update'))
      .on(RoomEvent.LocalTrackPublished, () => this.emit('update'))
      .on(RoomEvent.LocalTrackUnpublished, () => this.emit('update'))
      .on(RoomEvent.ParticipantNameChanged, () => this.emit('update'))
      .on(RoomEvent.ParticipantMetadataChanged, () => this.emit('update'))
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => {
        if (p === room.localParticipant) this.emit('quality', q);
      })
      .on(RoomEvent.Reconnecting, () => this.setState('reconnecting'))
      .on(RoomEvent.Reconnected, () => this.setState('connected'))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.emit('playback', room.canPlaybackAudio))
      .on(RoomEvent.MediaDevicesError, (e) => this.emit('error', e))
      .on(RoomEvent.Disconnected, (reason) => {
        this.cleanup();
        this.setState('disconnected');
        this.emit('disconnected', reason);
      });

    await room.connect(url, token, { autoSubscribe: true });
    this.setState('connected');

    // публикуем обработанный микрофон
    await this.mic.start();
    await this.publishMic();
    if (!room.canPlaybackAudio) this.emit('playback', false);
    this.emit('update');
  }

  async publishMic() {
    this.micPub = await this.room.localParticipant.publishTrack(this.mic.track, {
      source: Track.Source.Microphone,
      name: 'microphone',
      audioPreset: { maxBitrate: this.settings.bitrate },
      dtx: true,
      red: true,
    });
    if (this.muted || this.deafened) await this.micPub.mute();
  }

  // смена битрейта требует перепубликации трека
  async republishMic() {
    if (!this.micPub?.track) return;
    await this.room.localParticipant.unpublishTrack(this.micPub.track, false);
    await this.publishMic();
    this.emit('update');
  }

  setState(s) {
    this.state = s;
    this.emit('state', s);
  }

  get quality() {
    return this.room?.localParticipant.connectionQuality ?? ConnectionQuality.Unknown;
  }

  async startAudio() {
    await this.room?.startAudio();
  }

  // ------------------------------------------------ микрофон / звук
  async setMuted(muted) {
    this.muted = muted;
    if (!this.micPub) return;
    if (muted || this.deafened) await this.micPub.mute();
    else await this.micPub.unmute();
    this.emit('update');
  }

  async setDeafened(deaf) {
    this.deafened = deaf;
    for (const p of this.room?.remoteParticipants.values() || []) this.applyVolume(p);
    await this.setMuted(this.muted);
  }

  userVolume(identity) {
    return this.settings.userVolumes[identity] ?? 1;
  }

  applyVolume(p) {
    const v = this.deafened ? 0 : this.userVolume(p.identity);
    const sv = this.deafened ? 0 : this.settings.userVolumes[`${p.identity}:stream`] ?? 1;
    try {
      p.setVolume(v, Track.Source.Microphone);
      p.setVolume(sv, Track.Source.ScreenShareAudio);
    } catch {}
  }

  refreshVolumes() {
    for (const p of this.room?.remoteParticipants.values() || []) this.applyVolume(p);
  }

  async setOutputDevice(deviceId) {
    if (!this.room) return;
    try {
      await this.room.switchActiveDevice('audiooutput', deviceId || 'default');
    } catch {}
    for (const el of this.audioBox.querySelectorAll('audio')) el.setSinkId?.(deviceId || '').catch(() => {});
  }

  // ------------------------------------------------ экран и камера
  get screenSharing() {
    return !!this.room?.localParticipant.isScreenShareEnabled;
  }
  get cameraOn() {
    return !!this.room?.localParticipant.isCameraEnabled;
  }

  async toggleScreenShare(qualityKey) {
    const lp = this.room.localParticipant;
    if (lp.isScreenShareEnabled) {
      await lp.setScreenShareEnabled(false);
      this.emit('update');
      return false;
    }
    const q = SCREEN_QUALITIES[qualityKey] || SCREEN_QUALITIES['1080p30'];
    try {
      await lp.setScreenShareEnabled(
        true,
        {
          audio: true, // звук вкладки/системы (Chrome/Edge)
          systemAudio: 'include',
          suppressLocalAudioPlayback: false,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          contentHint: q.hint,
          resolution: { width: q.width, height: q.height, frameRate: q.fps },
        },
        {
          screenShareEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps, priority: 'high' },
          degradationPreference: q.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
          audioPreset: { maxBitrate: 128000 },
          dtx: false,
          red: false,
        },
      );
    } catch (e) {
      if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') throw e;
    }
    this.emit('update');
    return lp.isScreenShareEnabled;
  }

  async toggleCamera() {
    const lp = this.room.localParticipant;
    if (lp.isCameraEnabled) {
      await lp.setCameraEnabled(false);
    } else {
      const q = CAMERA_QUALITIES[this.settings.cameraQuality] || CAMERA_QUALITIES['720p'];
      await lp.setCameraEnabled(
        true,
        {
          deviceId: this.settings.cameraDeviceId || undefined,
          resolution: { width: q.width, height: q.height, frameRate: q.fps },
        },
        { videoEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps }, simulcast: true },
      );
    }
    this.emit('update');
    return lp.isCameraEnabled;
  }

  // ------------------------------------------------ данные для отрисовки
  participants() {
    if (!this.room) return [];
    return [this.room.localParticipant, ...this.room.remoteParticipants.values()];
  }

  static meta(p) {
    try {
      return JSON.parse(p.metadata || '{}');
    } catch {
      return {};
    }
  }

  // список плиток: камера/аватар на каждого + отдельная плитка на каждую демонстрацию
  tiles() {
    const out = [];
    for (const p of this.participants()) {
      const isLocal = p === this.room.localParticipant;
      const meta = VoiceSession.meta(p);
      const base = {
        identity: p.identity,
        name: p.name || p.identity,
        color: meta.color || '#5865f2',
        isLocal,
        participant: p,
      };
      const cam = p.getTrackPublication(Track.Source.Camera);
      const micPub = p.getTrackPublication(Track.Source.Microphone);
      out.push({
        ...base,
        key: `${p.identity}:camera`,
        kind: 'camera',
        track: cam && !cam.isMuted && cam.track ? cam.track : null,
        muted: isLocal ? this.muted || this.deafened : !micPub || micPub.isMuted,
        speaking: p.isSpeaking,
      });
      const scr = p.getTrackPublication(Track.Source.ScreenShare);
      if (scr && (scr.track || !isLocal)) {
        out.push({
          ...base,
          key: `${p.identity}:screen`,
          kind: 'screen',
          track: scr.track || null,
          hasAudio: !!p.getTrackPublication(Track.Source.ScreenShareAudio),
        });
      }
    }
    return out;
  }

  cleanup() {
    this.audioBox.remove();
  }

  async disconnect() {
    try {
      await this.room?.disconnect(true);
    } catch {}
    this.cleanup();
  }
}
