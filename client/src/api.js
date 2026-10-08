const KEY = 'boutique.token';
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export const getToken = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const setToken = (t) => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* navigation privée */ } };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || 'Erreur inattendue.');
    this.status = status;
    this.code = body?.error?.code;
    this.retryAfter = body?.error?.retryAfter;
  }
}

async function request(method, path, { body, raw, blob } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (raw) { payload = raw; headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, { error: { code: 'network', message: 'Pas de connexion au serveur. Vérifiez le réseau et réessayez.' } });
  }
  if (blob && res.ok) return res.blob();
  let data = null;
  try { data = await res.json(); } catch { /* corps vide */ }
  if (!res.ok) {
    if (res.status === 401 && ['unauthenticated', 'session_expired'].includes(data?.error?.code)) onUnauthorized(data.error.message);
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, body) => request('POST', p, { body }),
  put: (p, body) => request('PUT', p, { body }),
  patch: (p, body) => request('PATCH', p, { body }),
  upload: (p, file) => request('POST', p, { raw: file }),
  download: (p) => request('GET', p, { blob: true }),
};
