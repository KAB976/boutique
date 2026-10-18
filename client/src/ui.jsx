import React, { useEffect, useRef, useState } from 'react';

export function Modal({ title, onClose, children, wide }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose; // toujours la dernière version, sans relancer l'effet
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    // le focus n'est donné qu'UNE fois, à l'ouverture (sinon il revenait sur le premier champ à chaque rafraîchissement de la page)
    if (!ref.current?.contains(document.activeElement)) ref.current?.querySelector('input,select,button.primary')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head"><h2>{title}</h2><button className="icon" onClick={onClose} aria-label="Fermer">✕</button></div>
        {children}
      </div>
    </div>
  );
}

export const Field = ({ label, hint, children }) => (
  <label className="field"><span className="label">{label}</span>{children}{hint && <span className="hint">{hint}</span>}</label>
);

export const ErrorBox = ({ error }) => (error ? <div className="alert error" role="alert">{error}</div> : null);
export const Notice = ({ children, tone = 'info' }) => (children ? <div className={`alert ${tone}`}>{children}</div> : null);

/** Clavier numérique : 4 à 8 chiffres, utilisable au doigt ou au clavier. */
export function PinPad({ value, onChange, onSubmit, disabled, submitLabel = 'Valider' }) {
  const press = (d) => { if (!disabled && value.length < 8) onChange(value + d); };
  useEffect(() => {
    const onKey = (e) => {
      if (disabled) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') onChange(value.slice(0, -1));
      else if (e.key === 'Enter' && value.length >= 4) onSubmit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="pinpad">
      <div className="dots" aria-label={`${value.length} chiffres saisis`}>
        {Array.from({ length: Math.max(4, value.length) }, (_, i) => <span key={i} className={i < value.length ? 'on' : ''} />)}
      </div>
      <div className="keys">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => <button key={d} type="button" disabled={disabled} onClick={() => press(String(d))}>{d}</button>)}
        <button type="button" className="muted" disabled={disabled || !value} onClick={() => onChange(value.slice(0, -1))} aria-label="Effacer">⌫</button>
        <button type="button" disabled={disabled} onClick={() => press('0')}>0</button>
        <button type="button" className="primary" disabled={disabled || value.length < 4} onClick={onSubmit}>{submitLabel}</button>
      </div>
    </div>
  );
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn) => {
    setBusy(true); setError('');
    try { return await fn(); } catch (e) { setError(e.message); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

export const fmtDate = (iso, tz) => {
  try {
    return new Date(iso).toLocaleString('fr-FR', { timeZone: tz || undefined, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return iso; }
};
export const fmtSize = (n) => (n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(1)} ko` : `${(n / 1048576).toFixed(1)} Mo`);

const nf = (d) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
export const money = (x, d = 2) => (x == null ? '—' : `${nf(d).format(x)} €`);
/** Coût par unité de base → texte lisible : par kg, par litre ou par pièce. */
export const perUnit = (x, family) => {
  if (x == null) return '—';
  if (family === 'count') return `${money(x, x < 0.1 ? 3 : 2)} / pièce`;
  return `${money(x * 1000)} / ${family === 'mass' ? 'kg' : 'l'}`;
};
export const fmtDay = (iso) => { try { return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return iso; } };
export const FAMILY_FR = { mass: 'Poids (g, kg)', volume: 'Volume (ml, l)', count: 'À la pièce' };
export const TYPE_FR = { receipt: 'Réception', loss: 'Perte', inventory: 'Inventaire', price_fix: 'Prix complété', consume: 'Consommation', production: 'Production', adjust: 'Ajustement' };

/**
 * Unité proposée par défaut pour saisir une quantité de stock : celle dans laquelle le stock s'affiche (kg, l, pièces…),
 * jamais « mg » ou « ml » (on saisirait 2,5 en croyant des kilos). Avec des conditionnements (paquets…), le niveau d'achat habituel.
 */
export function defaultStockUnit(it, { packs = true } = {}) {
  if (!it) return '';
  if (packs && it.packs?.length) return `pack:${Math.min(it.purchase_depth, it.packs.length - 1)}`;
  const units = it.units ?? [];
  const tail = String(it.stockText ?? '').trim().split(/\s+/).pop().toLowerCase();
  const byTail = it.stock > 0 ? units.find((u) => u.label.toLowerCase() === tail || `${u.label.toLowerCase()}s` === tail) : null;
  if (byTail) return byTail.code;
  const pref = { mass: ['kg', 'g'], volume: ['l', 'ml'], count: ['piece'] }[it.family] ?? [];
  return pref.find((c) => units.some((u) => u.code === c)) ?? units[0]?.code ?? '';
}
