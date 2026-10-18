import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Modal } from './ui.jsx';

/* eslint-disable-next-line no-undef */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '?';

/** Vide le cache de l'application et recharge : à utiliser quand l'écran n'est pas à jour. */
export async function forceUpdate() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch { /* on recharge quand même */ }
  location.reload();
}

/** Version du serveur, relue toutes les minutes et quand on revient sur l'application. */
export function useServerVersion() {
  const [v, setV] = useState(null);
  useEffect(() => {
    let ok = true;
    const read = () => api.get('/api/public').then((p) => { if (ok) setV(p.version ?? null); }).catch(() => {});
    read();
    const t = setInterval(read, 60_000);
    const vis = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', vis);
    return () => { ok = false; clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, []);
  return v;
}

/** Pastille bien visible « Version x.y.z » ; orange si cette page n'a pas la même version que le serveur. */
export function VersionBadge({ server }) {
  const [open, setOpen] = useState(false);
  const diff = server && server !== APP_VERSION;
  return (
    <>
      <button type="button" className={`version-badge${diff ? ' diff' : ''}`} onClick={() => setOpen(true)} title="Cliquez pour les détails">
        {diff ? '⚠ ' : ''}Version {APP_VERSION}
      </button>
      {open && (
        <Modal title="Version de l'application" onClose={() => setOpen(false)}>
          <p className="version-big">Version {APP_VERSION}</p>
          <p>Cette page : <strong>{APP_VERSION}</strong><br />Serveur : <strong>{server ?? 'inconnu (pas de réseau ?)'}</strong></p>
          {diff
            ? <p className="alert warn">Les deux versions sont différentes. Appuyez sur « Mettre à jour » pour afficher la dernière version. Si le serveur affiche encore l'ancienne version, la mise en ligne (MISE-EN-LIGNE.bat) n'est pas terminée.</p>
            : <p className="muted">Tout est à jour.</p>}
          <div className="actions"><button onClick={() => setOpen(false)}>Fermer</button><button className="primary" onClick={forceUpdate}>Mettre à jour</button></div>
        </Modal>
      )}
    </>
  );
}

/** Bandeau en haut quand le serveur a une version plus récente que celle affichée. */
export function UpdateBanner({ server }) {
  if (!server || server === APP_VERSION) return null;
  return (
    <button type="button" className="banner update-banner" onClick={forceUpdate}>
      <span><strong>Une nouvelle version est disponible : {server}</strong> (vous avez la {APP_VERSION})</span><span className="link">Mettre à jour</span>
    </button>
  );
}
