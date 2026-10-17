import { bad } from './errors.js';
import { intId } from './common.js';
import { createOrder, advanceOrder, cancelOrder, board, openTabs, orderView } from './orders.js';
import { createPush } from './push.js';
import { can } from './permissions.js';

const summary = (o, onlyKitchen = true) => o.lines.filter((l) => !onlyKitchen || l.kitchen).map((l) => `${l.qty} × ${l.name}${l.note ? ` (${l.note})` : ''}`).join(', ');

export function registerOrders({ api, ctx, auth, need, actorOf }) {
  ctx.push = ctx.push || createPush(ctx);
  const push = () => ctx.push;

  api.get('/orders/board', auth, need('orders.view'), (req, res) => res.json({ ...board(ctx.db, ctx.tz(), ctx.now()), can: { take: can(req.user.role, 'orders.take'), kitchen: can(req.user.role, 'orders.kitchen'), serve: can(req.user.role, 'orders.serve'), cancel_any: can(req.user.role, 'orders.cancel_any') } }));
  api.get('/orders/tabs', auth, need('orders.take'), (req, res) => res.json({ tabs: openTabs(ctx.db) }));

  api.post('/orders', auth, need('orders.take'), (req, res) => {
    const r = createOrder(ctx, actorOf(req.user), req.body);
    if (!r.duplicate && r.order.has_kitchen) {
      push().notify(push().usersWith('orders.kitchen').filter((id) => id !== req.user.id), {
        title: `🍽 Nouvelle commande · ${r.order.label}`, body: summary(r.order) || 'Voir l’écran Commandes', tag: `order-${r.order.id}`, kind: 'new', orderId: r.order.id, url: '/?tab=orders',
      });
    }
    res.status(r.duplicate ? 200 : 201).json(r);
  });

  const act = (action) => (req, res) => {
    const r = advanceOrder(ctx, actorOf(req.user), intId(req.params.id), action);
    if (r.changed && action === 'ready') {
      const o = r.order; const creator = o.user_id;
      const hasDevice = creator && ctx.db.prepare('SELECT 1 FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.user_id = ? AND u.active = 1').get(creator);
      // le serveur qui a pris la commande est prévenu ; s'il n'a aucun appareil abonné, toute la salle l'est
      const targets = hasDevice ? [creator] : push().usersWith('orders.serve');
      push().notify(targets.filter((id) => id !== req.user.id), {
        title: `✅ ${o.label} : commande prête`, body: 'À récupérer en cuisine et à servir.', tag: `order-${o.id}`, kind: 'ready', orderId: o.id, url: '/?tab=orders',
      });
    }
    res.json(r);
  };
  api.post('/orders/:id/prepare', auth, need('orders.view'), act('prepare'));
  api.post('/orders/:id/ready', auth, need('orders.view'), act('ready'));
  api.post('/orders/:id/unready', auth, need('orders.view'), act('unready'));
  api.post('/orders/:id/serve', auth, need('orders.view'), act('serve'));
  api.post('/orders/:id/cancel', auth, need('orders.view'), (req, res) => {
    const r = cancelOrder(ctx, actorOf(req.user), intId(req.params.id), req.body?.reason);
    if (r.changed && r.order.has_kitchen && ['sent', 'preparing', 'ready'].includes(r.was)) {
      push().notify(push().usersWith('orders.kitchen').filter((id) => id !== req.user.id), {
        title: `❌ ${r.order.label} : commande annulée`, body: summary(r.order) || '', tag: `order-${r.order.id}`, kind: 'cancel', orderId: r.order.id, url: '/?tab=orders',
      });
    }
    res.json(r);
  });
  api.get('/orders/:id', auth, need('orders.view'), (req, res) => { const o = orderView(ctx.db, intId(req.params.id)); if (!o) throw bad('Commande introuvable.'); res.json(o); });

  // ----- notifications du téléphone -----
  api.get('/push/key', auth, (req, res) => res.json({ publicKey: push().publicKey() }));
  api.get('/push/mine', auth, (req, res) => res.json({ devices: push().mine(req.user).map((d) => ({ id: d.id, device: d.device, created_at: d.created_at, last_ok_at: d.last_ok_at, last_error: d.last_error, endpoint: d.endpoint })) }));
  api.post('/push/subscribe', auth, (req, res) => { push().subscribe(req.user, req.body, ctx.now().toISOString()); res.status(201).json({ ok: true }); });
  api.post('/push/unsubscribe', auth, (req, res) => { push().unsubscribe(req.user, req.body?.endpoint); res.json({ ok: true }); });
  api.post('/push/test', auth, async (req, res) => {
    const r = await push().notify([req.user.id], { title: '🔔 Test de notification', body: 'Si vous voyez ceci, les notifications fonctionnent sur cet appareil.', tag: 'test', kind: 'test', url: '/' });
    res.json({ sent: r.sent });
  });
}
