/**
 * Notifications de téléphone (Web Push) : elles arrivent même écran verrouillé et application fermée.
 * - Les clés d'identification du serveur (VAPID) sont créées automatiquement et rangées dans la base.
 * - Chaque appareil s'abonne lui-même (bouton « Activer les notifications »).
 * - L'envoi ne bloque jamais l'action en cours : s'il échoue, la commande reste enregistrée.
 */
import webpush from 'web-push';
import { bad } from './errors.js';
import { can, ROLES } from './permissions.js';

const subject = () => process.env.PUSH_SUBJECT || process.env.RENDER_EXTERNAL_URL || 'mailto:boutique@example.com';

export function vapidKeys(db) {
  const get = (k) => db.prepare('SELECT value FROM server_secrets WHERE key = ?').get(k)?.value;
  let pub = get('vapid_public'); let priv = get('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; priv = k.privateKey;
    db.prepare('INSERT OR REPLACE INTO server_secrets (key, value) VALUES (?, ?)').run('vapid_public', pub);
    db.prepare('INSERT OR REPLACE INTO server_secrets (key, value) VALUES (?, ?)').run('vapid_private', priv);
  }
  return { publicKey: pub, privateKey: priv };
}

/** Envoi réel ; remplaçable dans les tests. Renvoie { ok } ou { gone } ou { error }. */
export async function realSender(sub, payload, vapid, extra = {}) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload),
      { vapidDetails: { subject: subject(), publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 3600, urgency: 'high', timeout: 10_000, ...extra },
    );
    return { ok: true };
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) return { gone: true };
    return { error: `${e.statusCode ?? ''} ${String(e.body || e.message || e).slice(0, 160)}`.trim() };
  }
}

export function createPush(ctx, sender = realSender) {
  const pending = new Set();
  const api = {
    sender,
    publicKey: () => vapidKeys(ctx.db).publicKey,

    subscribe(user, body, ts) {
      const endpoint = body?.endpoint; const k = body?.keys;
      if (typeof endpoint !== 'string' || !/^https:\/\/[^\s]{8,1990}$/.test(endpoint)) throw bad('Abonnement de notification invalide.');
      if (typeof k?.p256dh !== 'string' || typeof k?.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100) throw bad('Abonnement de notification invalide.');
      const device = typeof body.device === 'string' ? body.device.slice(0, 80) : '';
      ctx.db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, last_error = NULL`)
        .run(user.id, endpoint, k.p256dh, k.auth, device, ts);
    },
    unsubscribe(user, endpoint) {
      if (typeof endpoint !== 'string') throw bad('Abonnement invalide.');
      ctx.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, user.id);
    },
    mine: (user) => ctx.db.prepare('SELECT id, endpoint, device, created_at, last_ok_at, last_error FROM push_subscriptions WHERE user_id = ? ORDER BY id').all(user.id),

    /** Utilisateurs actifs ayant ce droit, ou liste d'identifiants. */
    usersWith(perm) {
      return ctx.db.prepare('SELECT id, role FROM users WHERE active = 1').all().filter((u) => can(u.role, perm)).map((u) => u.id);
    },

    /** Envoie à tous les appareils de ces utilisateurs. Ne lève jamais d'erreur. */
    notify(userIds, payload) {
      const ids = [...new Set(userIds)].filter(Number.isInteger);
      if (!ids.length) return Promise.resolve({ sent: 0 });
      const subs = ctx.db.prepare(`SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.active = 1 AND s.user_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      const vapid = vapidKeys(ctx.db);
      const job = (async () => {
        let sent = 0;
        await Promise.all(subs.map(async (s) => {
          let r; try { r = await api.sender(s, payload, vapid); } catch (e) { r = { error: String(e.message || e).slice(0, 160) }; }
          try {
            if (r?.gone) ctx.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
            else if (r?.ok) { sent += 1; ctx.db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL WHERE id = ?').run(ctx.now().toISOString(), s.id); }
            else ctx.db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').run(r?.error || 'échec', s.id);
          } catch { /* base fermée pendant l'arrêt */ }
        }));
        return { sent };
      })().finally(() => pending.delete(job));
      pending.add(job);
      return job;
    },
    /** Attend la fin des envois en cours (tests, arrêt propre). */
    idle: () => Promise.all([...pending]),
  };
  return api;
}
export { ROLES };
