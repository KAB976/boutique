import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

export const OWNER_PIN = '2468';

/** Application isolée (dossier temporaire, horloge pilotable, serveur sur un port libre). */
export async function boot({ start = '2026-10-07T08:00:00Z', dir } = {}) {
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'boutique-test-'));
  const clock = { t: new Date(start) };
  const ctx = createApp({ dataDir, now: () => new Date(clock.t) });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, { token, body, raw, headers = {} } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (raw) { payload = raw; h['content-type'] = 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }

  const api = {
    get: (u, o) => call('GET', u, o),
    post: (u, body, o = {}) => call('POST', u, { ...o, body }),
    put: (u, body, o = {}) => call('PUT', u, { ...o, body }),
    patch: (u, body, o = {}) => call('PATCH', u, { ...o, body }),
    delete: (u, o = {}) => call('DELETE', u, o),
  };

  async function setup(shopName = 'Chez Test') {
    const r = await api.post('/api/setup', { shopName, ownerName: 'Karim', pin: OWNER_PIN });
    return r.data.token;
  }
  async function addUser(ownerToken, name, role, pin) {
    const r = await api.post('/api/users', { name, role, pin }, { token: ownerToken });
    if (r.status !== 201) throw new Error(`addUser ${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  }
  async function login(userId, pin) {
    const r = await api.post('/api/auth/login', { userId, pin });
    return r;
  }
  /** Crée un utilisateur et le connecte (le PIN provisoire doit être changé ; on le fait). */
  async function staff(ownerToken, name, role, pin = '1357') {
    const u = await addUser(ownerToken, name, role, '9753');
    const l = await login(u.id, '9753');
    const ch = await api.post('/api/me/pin', { currentPin: '9753', newPin: pin }, { token: l.data.token });
    if (ch.status !== 200) throw new Error(`pin change ${name}: ${JSON.stringify(ch.data)}`);
    return { id: u.id, token: l.data.token, pin };
  }
  const close = async () => { await new Promise((r) => server.close(r)); try { ctx.db.close(); } catch { /* ok */ } };
  return { ctx, clock, api, base, setup, addUser, login, staff, close, dataDir };
}
