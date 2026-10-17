import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ErrorBox, Notice } from '../ui.jsx';
import { pushState, enablePush, disablePush, testPush, soundOn, setSoundOn, playSound, unlockAudio, onAudioChange } from '../alerts.js';
import { useAudioReady } from '../board.js';

const TEXT = {
  unsupported: 'Ce navigateur ne peut pas recevoir de notifications. Le son fonctionne quand l’application est ouverte à l’écran.',
  denied: 'Les notifications sont bloquées pour ce site. Autorisez-les dans les réglages du navigateur (cadenas près de l’adresse), puis revenez ici.',
};

/** Carte « Alertes de cet appareil » : son + notifications du téléphone (même écran verrouillé). */
export default function NotifyCard({ compact = false }) {
  const [st, setSt] = useState('…');
  const [on, setOn] = useState(soundOn());
  const [msg, setMsg] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState(null);
  const ready = useAudioReady();
  const refresh = useCallback(async () => {
    setSt(await pushState());
    api.get('/api/push/mine').then((r) => setDevices(r.devices)).catch(() => {});
  }, []);
  useEffect(() => { refresh(); return onAudioChange(() => setOn(soundOn())); }, [refresh]);

  const enable = async () => { setBusy(true); setErr(''); setMsg(''); const r = await enablePush(); setBusy(false); if (r.error) setErr(r.error); else setMsg('Notifications activées sur cet appareil.'); refresh(); };
  const disable = async () => { setBusy(true); await disablePush(); setBusy(false); setMsg('Notifications désactivées sur cet appareil.'); refresh(); };
  const test = async () => {
    setBusy(true); setErr(''); setMsg('');
    try { const r = await testPush(); setMsg(r.sent > 0 ? 'Notification envoyée : elle doit apparaître dans quelques secondes (même écran verrouillé).' : 'Aucun appareil prêt à recevoir. Activez d’abord les notifications.'); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const toggleSound = () => { unlockAudio(); const v = !on; setSoundOn(v); setOn(v); if (v) setTimeout(() => playSound('ready'), 150); };

  return (
    <section className={compact ? 'notify compact' : 'card'}>
      <h2>🔔 Alertes de cet appareil</h2>
      <ErrorBox error={err} />
      {msg && <Notice tone="ok">{msg}</Notice>}
      <div className="notify-row">
        <div>
          <strong>Son dans l’application</strong>
          <p className="muted small">Sonne quand une commande arrive en cuisine ou qu’une commande est prête, tant que l’application est ouverte.</p>
          {on && !ready && <p className="small neg">Le navigateur bloque le son tant que vous n’avez pas touché l’écran : touchez « Tester le son ».</p>}
        </div>
        <div className="notify-actions">
          <button onClick={toggleSound}>{on ? '🔔 Son activé' : '🔕 Son coupé'}</button>
          <button onClick={() => { unlockAudio(); setTimeout(() => playSound('new'), 150); setTimeout(() => playSound('ready'), 1600); }}>Tester le son</button>
        </div>
      </div>
      <div className="notify-row">
        <div>
          <strong>Notifications du téléphone</strong>
          <p className="muted small">Arrivent même si l’écran est verrouillé ou l’application fermée, avec le son du téléphone.</p>
          {st === 'ios-install' && <Notice tone="warn">Sur iPhone / iPad, il faut d’abord installer l’application : dans Safari, touchez le bouton Partager puis « Sur l’écran d’accueil », et ouvrez l’application depuis cette icône. Ensuite revenez ici.</Notice>}
          {TEXT[st] && <Notice tone="warn">{TEXT[st]}</Notice>}
          {st === 'on' && <p className="small pos-amount">✓ Activées sur cet appareil.</p>}
        </div>
        <div className="notify-actions">
          {st === 'off' && <button className="primary" onClick={enable} disabled={busy}>Activer les notifications</button>}
          {st === 'on' && <><button onClick={test} disabled={busy}>Envoyer un test</button><button onClick={disable} disabled={busy}>Désactiver</button></>}
        </div>
      </div>
      {!compact && devices && devices.length > 0 && (
        <p className="muted small">Appareils prévenus pour votre compte : {devices.map((d) => d.device || 'Appareil').join(', ')}{devices.some((d) => d.last_error) ? ' — ⚠ un appareil a signalé une erreur d’envoi.' : '.'}</p>
      )}
      {!compact && <p className="muted small">Conseil : laissez le téléphone de la cuisine branché, l’application ouverte sur « Commandes » et l’écran allumé : c’est le plus fiable. Les autres téléphones peuvent rester verrouillés.</p>}
    </section>
  );
}
