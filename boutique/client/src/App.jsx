import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api.js';
import { ErrorBox } from './ui.jsx';
import Setup from './pages/Setup.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import Settings from './pages/Settings.jsx';
import Categories from './pages/Categories.jsx';
import Stock from './pages/Stock.jsx';
import Recipes from './pages/Recipes.jsx';
import Users from './pages/Users.jsx';
import Audit from './pages/Audit.jsx';
import Backups from './pages/Backups.jsx';
import Account from './pages/Account.jsx';
import Pos from './pages/Pos.jsx';
import Sales from './pages/Sales.jsx';
import Kitchen from './pages/Kitchen.jsx';
import Products from './pages/Products.jsx';
import Customers from './pages/Customers.jsx';
import Suppliers from './pages/Suppliers.jsx';
import Catering from './pages/Catering.jsx';
import Promotions from './pages/Promotions.jsx';
import Management from './pages/Management.jsx';
import CashCheck from './pages/CashCheck.jsx';
import Orders from './pages/Orders.jsx';
import { cache } from './offline.js';
import { startBoard, stopBoard, useBoard, pendingAlerts } from './board.js';
import { resyncPush, detachPush } from './alerts.js';
import { resetShift, loadShift } from './shift.js';
import { setShopTz } from './money.js';

const TABS = [
  { id: 'home', label: 'Accueil', perm: null, Page: Home },
  { id: 'pos', label: 'Caisse', perm: 'pos.sell', Page: Pos },
  { id: 'orders', label: 'Commandes', perm: 'orders.view', Page: Orders },
  { id: 'sales', label: 'Ventes et clôture', perm: 'sales.view_own', Page: Sales },
  { id: 'cashcheck', label: 'Vérif. caisses', perm: 'cash.review', Page: CashCheck },
  { id: 'kitchen', label: 'Cuisine', perm: 'production.do', Page: Kitchen },
  { id: 'recipes', label: 'Recettes', perm: 'recipes.view', Page: Recipes },
  { id: 'stock', label: 'Stock', perm: 'stock.view', Page: Stock },
  { id: 'products', label: 'Articles', perm: 'products.edit', Page: Products },
  { id: 'categories', label: 'Catégories', perm: 'categories.edit', Page: Categories },
  { id: 'catering', label: 'Traiteur', perm: 'catering.view', Page: Catering },
  { id: 'customers', label: 'Clients', perm: 'customers.view', Page: Customers },
  { id: 'suppliers', label: 'Fournisseurs', perm: 'purchasing.manage', Page: Suppliers },
  { id: 'promotions', label: 'Promotions', perm: 'promotions.manage', Page: Promotions },
  { id: 'management', label: 'Résultats', perm: 'stats.view', Page: Management },
  { id: 'settings', label: 'Réglages', perm: 'settings.edit', Page: Settings },
  { id: 'users', label: 'Comptes', perm: 'users.manage', Page: Users },
  { id: 'audit', label: 'Journal', perm: 'audit.view', Page: Audit },
  { id: 'backups', label: 'Sauvegardes', perm: 'backup.manage', Page: Backups },
  { id: 'account', label: 'Mon compte', perm: null, Page: Account },
];

/** Menus : comme dans Office, une barre de menus en haut et, dessous, les pages du menu choisi. */
const GROUPS = [
  { id: 'g-home', label: 'Accueil', tabs: ['home'] },
  { id: 'g-sell', label: 'Vente', tabs: ['pos', 'orders', 'sales', 'cashcheck'] },
  { id: 'g-kitchen', label: 'Cuisine et stock', tabs: ['kitchen', 'recipes', 'stock'] },
  { id: 'g-catalog', label: 'Catalogue', tabs: ['products', 'categories', 'promotions'] },
  { id: 'g-people', label: 'Clients et achats', tabs: ['customers', 'catering', 'suppliers'] },
  { id: 'g-mgmt', label: 'Gestion', tabs: ['management'] },
  { id: 'g-admin', label: 'Administration', tabs: ['settings', 'users', 'audit', 'backups'] },
];

const firstTab = (u) => (u.role === 'cashier' ? 'pos' : u.role === 'cook' || u.role === 'waiter' ? 'orders' : 'home');

function AlertBar({ me, tab, go }) {
  const b = useBoard();
  const a = pendingAlerts(b.data);
  if (tab === 'orders') return null;
  const items = [];
  if (a.newOrders.length) items.push(<button key="n" className="banner alert-new" onClick={() => go('orders')}><span><strong>🍽 {a.newOrders.length} nouvelle{a.newOrders.length > 1 ? 's' : ''} commande{a.newOrders.length > 1 ? 's' : ''}</strong> : {a.newOrders.slice(0, 3).map((o) => o.label).join(', ')}</span><span className="link">Voir</span></button>);
  if (a.ready.length) items.push(<button key="r" className="banner alert-ready" onClick={() => go('orders')}><span><strong>✅ {a.ready.map((o) => o.label).slice(0, 4).join(', ')}{a.ready.length > 4 ? '…' : ''}</strong> {a.ready.length > 1 ? 'sont prêtes' : 'est prête'} : à servir</span><span className="link">Voir</span></button>);
  return items.length ? <div className="alert-bar">{items}</div> : null;
}

export default function App() {
  const boardNow = useBoard();
  const lastInGroup = useRef({});
  const [phase, setPhase] = useState('loading'); // loading | setup | login | app | error
  const [me, setMe] = useState(null);
  const [pub, setPub] = useState({ shop_name: '', logo: '' });
  const [tab, setTab] = useState('home');
  const [message, setMessage] = useState('');
  const [fatal, setFatal] = useState('');
  const [away, setAway] = useState(false); // appareil sans réseau : on ouvre la caisse avec ce qui est en mémoire

  const toLogin = useCallback((msg = '') => {
    setToken(null); setMe(null); setMessage(msg); setPhase('login');
  }, []);

  useEffect(() => { setUnauthorizedHandler((msg) => toLogin(msg)); }, [toLogin]);

  const boot = useCallback(async () => {
    try {
      const [{ needsSetup }, p] = await Promise.all([api.get('/api/setup/status'), api.get('/api/public')]);
      setPub(p); cache.set('pub', p); setShopTz(p.timezone);
      if (needsSetup) { setPhase('setup'); return; }
      if (getToken()) {
        try { const m = await api.get('/api/me'); cache.set('me', m); setMe(m); setTab((t) => (t === 'home' ? firstTab(m) : t)); setAway(false); setPhase('app'); return; } catch (e) { if (e.code === 'network') throw e; /* session terminée */ }
      }
      setPhase('login');
    } catch (e) {
      const saved = cache.get('me');
      if (e.code === 'network' && getToken() && saved) { // pas de réseau : la caisse reste utilisable
        const p = cache.get('pub'); if (p) { setPub(p); setShopTz(p.timezone); }
        setMe(saved); setAway(true); setTab('pos'); setPhase('app'); return;
      }
      setFatal(e.message); setPhase('error');
    }
  }, []);
  useEffect(() => { boot(); }, [boot]);

  useEffect(() => {
    if (phase === 'app' && me && !away) { startBoard(me); resyncPush(); return () => stopBoard(); }
    stopBoard(); return undefined;
  }, [phase, me, away]);
  useEffect(() => {
    const open = (e) => { try { const t = new URL(e.detail, location.origin).searchParams.get('tab'); if (t) setTab(t); } catch { /* adresse invalide */ } };
    window.addEventListener('boutique:open', open);
    const t0 = new URLSearchParams(location.search).get('tab'); if (t0) setTab(t0);
    return () => window.removeEventListener('boutique:open', open);
  }, []);

  useEffect(() => { document.title = pub.shop_name ? `${pub.shop_name} · Boutique` : 'Boutique'; }, [pub.shop_name]);

  const onAuthed = (token, user) => { setToken(token); setMe(user); cache.set('me', user); setTab(firstTab(user)); setMessage(''); setPhase('app'); api.get('/api/public').then((p) => { setPub(p); cache.set('pub', p); setShopTz(p.timezone); }).catch(() => {}); };

  const logout = async () => {
    try { const st = await api.get('/api/shift/current'); if (st.mine && !window.confirm(`Votre quart ${st.shift.number} est encore ouvert. Si vous partez maintenant, personne d'autre ne pourra encaisser avant que vous (ou le gérant) le fermiez.\n\nSe déconnecter quand même ?`)) return; } catch { /* hors-ligne */ }
    resetShift(); await detachPush(); stopBoard(); try { await api.post('/api/auth/logout'); } catch { /* déjà déconnecté */ } cache.del('me'); toLogin(); };

  if (phase === 'loading') return <div className="center muted">Chargement…</div>;
  if (phase === 'error') return (
    <div className="center"><div className="card narrow"><h1>Serveur injoignable</h1><ErrorBox error={fatal} /><button className="primary" onClick={() => { setPhase('loading'); boot(); }}>Réessayer</button></div></div>
  );
  if (phase === 'setup') return <Setup onDone={onAuthed} />;
  if (phase === 'login') return <Login pub={pub} message={message} onDone={onAuthed} />;

  const mustChange = me.mustChangePin;
  const badge = (() => { const a = pendingAlerts(boardNow.data); return a.newOrders.length + a.ready.length; })();
  const tabs = TABS.filter((t) => (!t.perm || me.permissions.includes(t.perm)) && (!away || t.id === 'pos' || t.id === 'account'));
  const current = mustChange ? TABS.find((t) => t.id === 'account') : tabs.find((t) => t.id === tab) || tabs[0];
  const Page = current.Page;
  const visible = new Set(tabs.map((t) => t.id));
  const groups = GROUPS.map((g) => ({ ...g, pages: g.tabs.filter((id) => visible.has(id)).map((id) => TABS.find((t) => t.id === id)) })).filter((g) => g.pages.length);
  const group = groups.find((g) => g.pages.some((t) => t.id === current.id));
  const openGroup = (g) => { const last = lastInGroup.current[g.id]; setTab(g.pages.some((t) => t.id === last) ? last : g.pages[0].id); };
  if (group) lastInGroup.current[group.id] = current.id;

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          {pub.logo ? <img src={pub.logo} alt="" /> : <span className="logo-fallback">🍽</span>}
          <strong>{pub.shop_name || 'Boutique'}</strong>
        </div>
        <div className="who"><span>{me.name}</span><span className="badge">{me.roleLabel}</span>{!mustChange && <button className={current.id === 'account' ? 'active' : ''} onClick={() => setTab('account')}>Mon compte</button>}<button onClick={logout}>Se déconnecter</button></div>
      </header>
      {away && <div className="banner off" style={{ margin: '0 0 8px' }}><span><strong>Pas de réseau.</strong> Seule la caisse est disponible ; les ventes partiront dès le retour du réseau.</span><button onClick={() => { setPhase('loading'); boot(); }}>Réessayer</button></div>}
      {!mustChange && !away && <AlertBar me={me} tab={current.id} go={setTab} />}
      {!mustChange && (
        <div className="menu">
          <nav className="menubar" aria-label="Menu">
            {groups.map((g) => <button key={g.id} className={group?.id === g.id ? 'active' : ''} onClick={() => openGroup(g)}>{g.label}{g.pages.some((t) => t.id === 'orders') && badge > 0 ? <span className="count">{badge}</span> : null}</button>)}
          </nav>
          {group && group.pages.length > 1 && (
            <nav className="ribbon" aria-label={`Pages du menu ${group.label}`}>
              {group.pages.map((t) => <button key={t.id} className={t.id === current.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}{t.id === 'orders' && badge > 0 ? <span className="count">{badge}</span> : null}</button>)}
            </nav>
          )}
        </div>
      )}
      <main>
        <Page me={me} go={setTab} forced={mustChange} onPublicChange={() => api.get('/api/public').then(setPub)} onPinChanged={() => { setTab('account'); api.get('/api/me').then(setMe); }} onRelogin={toLogin} />
      </main>
    </div>
  );
}
