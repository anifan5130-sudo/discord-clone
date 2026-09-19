// Работа с LiveKit без внешних зависимостей: JWT (HS256), проверка вебхуков, Twirp API.
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now - 30) return null;
    if (payload.nbf && payload.nbf > now + 30) return null;
    return payload;
  } catch {
    return null;
  }
}

export class LiveKit {
  constructor({ apiKey, apiSecret, internalUrl }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.internalUrl = internalUrl.replace(/\/$/, '');
  }

  // Токен доступа участника к конкретной комнате
  participantToken({ identity, name, room, metadata, ttl = 6 * 3600 }) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt(
      {
        iss: this.apiKey,
        sub: identity,
        name,
        metadata,
        nbf: now - 10,
        exp: now + ttl,
        jti: crypto.randomUUID(),
        video: {
          room,
          roomJoin: true,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
          canUpdateOwnMetadata: false,
        },
      },
      this.apiSecret,
    );
  }

  adminToken(room) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt(
      {
        iss: this.apiKey,
        nbf: now - 10,
        exp: now + 600,
        video: { roomAdmin: true, roomList: true, roomCreate: true, ...(room ? { room } : {}) },
      },
      this.apiSecret,
    );
  }

  // Проверка подписи вебхука: заголовок Authorization = JWT с claim sha256 = base64(sha256(body))
  verifyWebhook(rawBody, authHeader) {
    const token = String(authHeader || '').replace(/^Bearer\s+/i, '');
    const claims = verifyJwt(token, this.apiSecret);
    if (!claims || claims.iss !== this.apiKey) return false;
    const hash = crypto.createHash('sha256').update(rawBody).digest('base64');
    return claims.sha256 === hash;
  }

  async twirp(method, body, room) {
    const res = await fetch(`${this.internalUrl}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.adminToken(room)}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`LiveKit ${method}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async listRooms() {
    const r = await this.twirp('ListRooms', {});
    return r.rooms || [];
  }

  async listParticipants(room) {
    const r = await this.twirp('ListParticipants', { room }, room);
    return r.participants || [];
  }

  async deleteRoom(room) {
    return this.twirp('DeleteRoom', { room }, room);
  }

  async removeParticipant(room, identity) {
    return this.twirp('RemoveParticipant', { room, identity }, room);
  }
}
