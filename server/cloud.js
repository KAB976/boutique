import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Copie continue de la base vers Supabase Storage (gratuit), pour héberger l'application sur un
 * serveur gratuit dont le disque s'efface à chaque redémarrage.
 *
 * Principe :
 *  - au démarrage, la dernière copie en ligne est rapatriée AVANT d'ouvrir la base ;
 *  - après chaque écriture (POST/PUT/PATCH/DELETE réussi), une copie cohérente de la base est envoyée,
 *    sous un NOUVEAU nom (db/000123.db) : jamais d'écrasement, donc pas de contenu périmé en cache ;
 *  - envoyer sans écraser sert de garde-fou : si une autre instance a déjà écrit le numéro suivant
 *    (deux serveurs en même temps), l'envoi est refusé et l'alerte est visible dans l'application ;
 *  - une copie par jour est conservée 30 jours (daily/AAAA-MM-JJ.db), les 20 dernières copies courantes aussi.
 */

const pad = (n) => String(n).padStart(10, '0');
const KEEP_RECENT = 20;
const KEEP_DAILY_DAYS = 30;

export function cloudConfig(env = process.env) {
  const url = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url && !key) return null;
  if (!url || !key) throw new Error('Configuration en ligne incomplète : SUPABASE_URL et SUPABASE_SERVICE_KEY sont tous deux nécessaires.');
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) throw new Error('SUPABASE_URL doit commencer par https://');
  return { url, key, bucket: (env.SUPABASE_BUCKET || 'boutique-data').trim() };
}

class Remote {
  constructor(cfg, fetchFn) { this.cfg = cfg; this.f = fetchFn; }
  // Anciennes clés (service_role, JWT « eyJ… ») : Authorization + apikey. Nouvelles clés secrètes (sb_secret_…) : apikey seul.
  headers(extra = {}) { return { ...(this.cfg.key.startsWith('eyJ') ? { authorization: `Bearer ${this.cfg.key}` } : {}), apikey: this.cfg.key, ...extra }; }
  base(p) { return `${this.cfg.url}/storage/v1/${p}`; }
  async call(method, p, { body, headers, expect = [200] } = {}) {
    let res;
    try { res = await this.f(this.base(p), { method, headers: this.headers(headers), body, signal: AbortSignal.timeout(60_000) }); }
    catch (e) { const err = new Error(`Supabase injoignable (${e.cause?.code || e.message}).`); err.network = true; throw err; }
    if (!expect.includes(res.status)) {
      let msg = ''; try { msg = (await res.text()).slice(0, 200); } catch { /* vide */ }
      const err = new Error(`Supabase a répondu ${res.status} : ${msg}`); err.status = res.status; err.body = msg; throw err;
    }
    return res;
  }
  async ensureBucket() {
    try {
      await this.call('POST', 'bucket', { body: JSON.stringify({ id: this.cfg.bucket, name: this.cfg.bucket, public: false }), headers: { 'content-type': 'application/json' }, expect: [200, 201] });
    } catch (e) {
      if (e.network) throw e;
      // déjà existant (400/409) : normal. Les autres erreurs apparaîtront à la première lecture/écriture.
      if (![400, 409].includes(e.status)) throw e;
    }
  }
  async list(prefix) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const res = await this.call('POST', `object/list/${this.cfg.bucket}`, {
        body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }), headers: { 'content-type': 'application/json' },
      });
      const page = await res.json();
      out.push(...page.filter((o) => o.name && !o.name.endsWith('/')).map((o) => o.name));
      if (page.length < 1000) break;
    }
    return out;
  }
  async put(name, buf) {
    return this.call('POST', `object/${this.cfg.bucket}/${name}`, { body: buf, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'max-age=3600' }, expect: [200, 201] });
  }
  async get(name) {
    const res = await this.call('GET', `object/authenticated/${this.cfg.bucket}/${name}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async remove(names) {
    if (!names.length) return;
    await this.call('DELETE', `object/${this.cfg.bucket}`, { body: JSON.stringify({ prefixes: names.map((n) => `${n}`) }), headers: { 'content-type': 'application/json' } });
  }
}

const seqOf = (name) => { const m = /^(?:db\/)?(\d{10})\.db$/.exec(name); return m ? Number(m[1]) : null; };
async function latestSeq(remote) {
  const names = await remote.list('db');
  const seqs = names.map(seqOf).filter((n) => n != null);
  return seqs.length ? Math.max(...seqs) : 0;
}

/** À appeler au démarrage, avant d'ouvrir la base. Retourne le numéro de la copie rapatriée (0 = rien en ligne). */
export async function restoreFromCloud(cfg, dataDir, { fetchFn = fetch, log = console } = {}) {
  const remote = new Remote(cfg, fetchFn);
  await remote.ensureBucket();
  const seq = await latestSeq(remote);
  if (!seq) { log.log('Copie en ligne : aucune donnée pour l\'instant (première utilisation).'); return 0; }
  const buf = await remote.get(`db/${pad(seq)}.db`);
  if (buf.length < 100 || buf.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('La copie en ligne est illisible : démarrage annulé pour ne rien abîmer.');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'boutique.db');
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.avant-restauration`);
  for (const ext of ['-wal', '-shm']) fs.rmSync(file + ext, { force: true });
  fs.writeFileSync(file, buf);
  log.log(`Copie en ligne rapatriée (n° ${seq}, ${(buf.length / 1024).toFixed(0)} ko).`);
  return seq;
}

export class CloudSync {
  constructor(cfg, { seq = 0, fetchFn = fetch, debounceMs = 4000, retryBaseMs = 4000, log = console, now = () => new Date() } = {}) {
    this.retryBase = retryBaseMs; this.cfg = cfg; this.remote = new Remote(cfg, fetchFn); this.seq = seq; this.debounceMs = debounceMs; this.log = log; this.now = now;
    this.ctx = null; this.timer = null; this.running = null; this.dirty = false; this.retryMs = 0;
    this.state = { enabled: true, lastOkAt: null, lastError: null, conflict: false, pending: false, seq };
  }
  attach(ctx) { this.ctx = ctx; }
  status() { return { ...this.state, pending: this.dirty || Boolean(this.running) }; }

  /** À appeler après chaque écriture réussie. */
  onWrite() {
    if (this.state.conflict) return;
    this.dirty = true;
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.retryMs || this.debounceMs);
    this.timer.unref?.();
  }

  /** Envoie tout de suite ce qui n'est pas encore parti (arrêt du serveur, test). */
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.running) { await this.running; }
    if (!this.dirty || this.state.conflict || !this.ctx) return;
    this.running = this.upload().finally(() => { this.running = null; });
    await this.running;
  }

  snapshot() {
    const tmp = path.join(os.tmpdir(), `boutique-snap-${process.pid}-${Date.now()}.db`);
    try {
      this.ctx.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      return fs.readFileSync(tmp);
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  async upload() {
    this.dirty = false; // les écritures qui arrivent pendant l'envoi remettront le drapeau
    try {
      const buf = this.snapshot();
      const next = this.seq + 1;
      try {
        await this.remote.put(`db/${pad(next)}.db`, buf);
      } catch (e) {
        if (e.status === 400 || e.status === 409) {
          // le nom existe déjà : une autre copie du serveur a écrit avant nous
          const real = await latestSeq(this.remote).catch(() => null);
          if (real != null && real >= next) {
            this.state.conflict = true;
            this.state.lastError = 'Une autre copie de l\'application écrit en même temps. Les envois en ligne sont suspendus pour ne rien écraser : redémarrez l\'application.';
            this.log.error(this.state.lastError);
            return;
          }
        }
        throw e;
      }
      this.seq = next; this.state.seq = next;
      this.state.lastOkAt = this.now().toISOString(); this.state.lastError = null; this.retryMs = 0;
      await this.housekeeping(buf).catch((e) => this.log.error('Ménage en ligne :', e.message));
    } catch (e) {
      this.dirty = true;
      this.state.lastError = `Copie en ligne impossible : ${e.message}`;
      this.log.error(this.state.lastError);
      this.retryMs = Math.min(60_000, (this.retryMs || this.retryBase) * 2);
      if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.retryMs); this.timer.unref?.(); }
    }
    if (this.dirty && !this.timer && !this.state.lastError) this.onWrite();
  }

  async housekeeping(buf) {
    const today = this.now().toISOString().slice(0, 10);
    const dailies = await this.remote.list('daily');
    if (!dailies.includes(`${today}.db`)) await this.remote.put(`daily/${today}.db`, buf).catch(() => {});
    const old = dailies.filter((n) => /^\d{4}-\d{2}-\d{2}\.db$/.test(n) && n.slice(0, 10) < new Date(this.now().getTime() - KEEP_DAILY_DAYS * 86400000).toISOString().slice(0, 10)).map((n) => `daily/${n}`);
    const recent = (await this.remote.list('db')).map(seqOf).filter((n) => n != null).sort((a, b) => a - b);
    const drop = recent.slice(0, Math.max(0, recent.length - KEEP_RECENT)).map((n) => `db/${pad(n)}.db`);
    await this.remote.remove([...old, ...drop]);
  }

  /** Photos : un fichier par photo, nommé d'après son empreinte (jamais modifié). Déjà présent = rien à refaire. */
  async putPhoto(name, buf) {
    if (!/^[0-9a-f]{64}\.jpg$/.test(name)) throw new Error('nom de photo invalide');
    try { await this.remote.put(`photos/${name}`, buf); }
    catch (e) { if (!([400, 409].includes(e.status) && /exist|duplicate/i.test(e.body || ''))) throw e; }
  }
  async getPhoto(name) {
    if (!/^[0-9a-f]{64}\.jpg$/.test(name)) throw new Error('nom de photo invalide');
    return this.remote.get(`photos/${name}`);
  }

  /** Vérification de connexion (écriture + lecture d'un petit fichier). */
  async selfTest() {
    await this.remote.ensureBucket();
    const name = `test/${Date.now()}.txt`;
    await this.remote.put(name, Buffer.from('ok'));
    const back = await this.remote.get(name);
    await this.remote.remove([name]);
    if (back.toString() !== 'ok') throw new Error('Lecture différente de l\'écriture.');
    return true;
  }
}
