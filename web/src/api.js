// Обёртка над HTTP API и потоком событий сервера.
let token = localStorage.getItem('voxa.token') || '';

export function getToken() {
  return token;
}
export function setToken(t) {
  token = t || '';
  try {
    if (token) localStorage.setItem('voxa.token', token);
    else localStorage.removeItem('voxa.token');
  } catch {}
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new ApiError(res.status, data.error || `Ошибка ${res.status}`);
  return data;
}

// Поток событий с автопереподключением
export function connectEvents(handlers, onAuthError) {
  let es;
  let closed = false;
  const open = () => {
    es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    for (const [name, fn] of Object.entries(handlers)) {
      es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
    }
    es.onopen = () => handlers.__open?.();
    es.onerror = async () => {
      handlers.__error?.();
      if (es.readyState === EventSource.CLOSED && !closed) {
        try {
          await api('GET', '/me');
          setTimeout(open, 2000);
        } catch (e) {
          if (e.status === 401) onAuthError();
          else setTimeout(open, 3000);
        }
      }
    };
  };
  open();
  return () => {
    closed = true;
    es?.close();
  };
}
