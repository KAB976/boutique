import React, { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api.js';
import { ErrorBox } from './ui.jsx';
import Setup from './pages/Setup.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import Settings from './pages/Settings.jsx';
import Stock from './pages/Stock.jsx';
import Users from './pages/Users.jsx';
import Audit from './pages/Audit.jsx';
import Backups from './pages/Backups.jsx';
import Account from './pages/Account.jsx';

const TABS = [
  { id: 'home', label: 'Accueil', perm: null, Page: Home },
  { id: 'stock', label: 'Stock', perm: 'stock.view', Page: Stock },
  { id: 'settings', label: 'Réglages', perm: 'settings.edit', Page: Settings },
  { id: 'users', label: 'Comptes', perm: 'users.manage', Page: Users },
  { id: 'audit', label: 'Journal', perm: 'audit.view', Page: Audit },
  { id: 'backups', label: 'Sauvegardes', perm: 'backup.manage', Page: Backups },
  { id: 'account', label: 'Mon compte', perm: null, Page: Account },
];

export default function App() {
  const [phase, setPhase] = useState('loading'); // loading | setup | login | app | error
  const [me, setMe] = useState(null);
  const [pub, setPub] = useState({ shop_name: '', logo: '' });
  const [tab, setTab] = useState('home');
  const [message, setMessage] = useState('');
  const [fatal, setFatal] = useState('');

  const toLogin = useCallback((msg = '') => {
    setToken(null); setMe(null); setMessage(msg); setPhase('login');
  }, []);

  useEffect(() => { setUnauthorizedHandler((msg) => toLogin(msg)); }, [toLogin]);

  const boot = useCallback(async () => {
    try {
      const [{ needsSetup }, p] = await Promise.all([api.get('/api/setup/status'), api.get('/api/public')]);
      setPub(p);
      if (needsSetup) { setPhase('setup'); return; }
      if (getToken()) {
        try { setMe(await api.get('/api/me')); setPhase('app'); return; } catch { /* session terminée */ }
      }
      setPhase('login');
    } catch (e) { setFatal(e.message); setPhase('error'); }
  }, []);
  useEffect(() => { boot(); }, [boot]);

  useEffect(() => { document.title = pub.shop_name ? `${pub.shop_name} · Boutique` : 'Boutique'; }, [pub.shop_name]);

  const onAuthed = (token, user) => { setToken(token); setMe(user); setTab('home'); setMessage(''); setPhase('app'); api.get('/api/public').then(setPub).catch(() => {}); };

  const logout = async () => { try { await api.post('/api/auth/logout'); } catch { /* déjà déconnecté */ } toLogin(); };

  if (phase === 'loading') return <div className="center muted">Chargement…</div>;
  if (phase === 'error') return (
    <div className="center"><div className="card narrow"><h1>Serveur injoignable</h1><ErrorBox error={fatal} /><button className="primary" onClick={() => { setPhase('loading'); boot(); }}>Réessayer</button></div></div>
  );
  if (phase === 'setup') return <Setup onDone={onAuthed} />;
  if (phase === 'login') return <Login pub={pub} message={message} onDone={onAuthed} />;

  const mustChange = me.mustChangePin;
  const tabs = TABS.filter((t) => !t.perm || me.permissions.includes(t.perm));
  const current = mustChange ? TABS.find((t) => t.id === 'account') : tabs.find((t) => t.id === tab) || tabs[0];
  const Page = current.Page;

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          {pub.logo ? <img src={pub.logo} alt="" /> : <span className="logo-fallback">🍽</span>}
          <strong>{pub.shop_name || 'Boutique'}</strong>
        </div>
        <div className="who"><span>{me.name}</span><span className="badge">{me.roleLabel}</span><button onClick={logout}>Se déconnecter</button></div>
      </header>
      {!mustChange && (
        <nav className="tabs" aria-label="Menu">
          {tabs.map((t) => <button key={t.id} className={t.id === current.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </nav>
      )}
      <main>
        <Page me={me} forced={mustChange} onPublicChange={() => api.get('/api/public').then(setPub)} onPinChanged={() => { setTab('account'); api.get('/api/me').then(setMe); }} onRelogin={toLogin} />
      </main>
    </div>
  );
}
