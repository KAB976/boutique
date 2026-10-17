import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { deployToRender } from '../scripts/render-deploy.mjs';

async function fakeRender({ existing = false, failBuild = false, never = false } = {}) {
  const calls = []; const services = existing ? [{ service: { id: 'srv-1', name: 'boutique', serviceDetails: { url: 'https://boutique-abc.onrender.com' } } }] : [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      const send = (c, d) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (req.headers.authorization !== 'Bearer rnd_ok') return send(401, { message: 'Unauthorized' });
      if (req.method === 'GET' && req.url.startsWith('/owners')) return send(200, [{ owner: { id: 'tea-123', name: 'Karim' }, cursor: 'x' }]);
      if (req.method === 'GET' && req.url.startsWith('/services?')) return send(200, services);
      if (req.method === 'POST' && req.url === '/services') {
        services.push({ service: { id: 'srv-1', name: body.name, serviceDetails: { url: 'https://boutique-abc.onrender.com' } } });
        return send(201, { service: services.at(-1).service, deployId: 'dep-1' });
      }
      if (req.method === 'GET' && req.url === '/services/srv-1') return send(200, { id: 'srv-1', name: 'boutique', serviceDetails: { url: 'https://boutique-abc.onrender.com' } });
      if (req.method === 'PUT' && req.url === '/services/srv-1/env-vars') return send(200, body);
      if (req.method === 'POST' && req.url === '/services/srv-1/deploys') return send(201, { id: 'dep-2', status: 'created' });
      if (req.method === 'GET' && req.url.startsWith('/services/srv-1/deploys')) {
        polls += 1;
        const status = never ? 'build_in_progress' : failBuild ? (polls > 1 ? 'build_failed' : 'build_in_progress') : polls > 2 ? 'live' : 'build_in_progress';
        return req.url.includes('/deploys/') ? send(200, { id: req.url.split('/').pop(), status }) : send(200, [{ deploy: { id: 'dep-1', status } }]);
      }
      return send(404, { message: 'inconnu' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const opts = (fr, extra = {}) => ({ apiKey: 'rnd_ok', repoUrl: 'https://github.com/karim/boutique', env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' }, base: fr.base, sleep: async () => {}, log: () => {}, ...extra });

test('Render : création du service avec les bons réglages, puis attente de « live »', async () => {
  const fr = await fakeRender();
  try {
    const r = await deployToRender(opts(fr));
    assert.equal(r.url, 'https://boutique-abc.onrender.com');
    const post = fr.calls.find((c) => c.method === 'POST');
    assert.equal(post.body.type, 'web_service');
    assert.equal(post.body.ownerId, 'tea-123');
    assert.equal(post.body.repo, 'https://github.com/karim/boutique');
    assert.equal(post.body.serviceDetails.plan, 'free');
    assert.equal(post.body.serviceDetails.healthCheckPath, '/api/public');
    assert.equal(post.body.serviceDetails.envSpecificDetails.startCommand, 'npm start');
    assert.match(post.body.serviceDetails.envSpecificDetails.buildCommand, /npm run build/);
    assert.deepEqual(post.body.envVars.map((e) => e.key).sort(), ['SUPABASE_SERVICE_KEY', 'SUPABASE_URL']);
  } finally { await fr.close(); }
});

test('Render : service déjà présent = réutilisé, jamais créé deux fois', async () => {
  const fr = await fakeRender({ existing: true });
  try {
    await deployToRender(opts(fr, { env: { NODE_VERSION: '22.22.0', SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k' } }));
    assert.equal(fr.calls.filter((c) => c.method === 'POST' && c.url === '/services').length, 0);
    // réglages remplacés (version de Node corrigée) puis nouveau déploiement, suivi par son identifiant
    const put = fr.calls.find((c) => c.method === 'PUT');
    assert.ok(put.body.some((e) => e.key === 'NODE_VERSION' && e.value === '22.22.0'));
    assert.ok(fr.calls.some((c) => c.method === 'POST' && c.url === '/services/srv-1/deploys'));
    assert.ok(fr.calls.some((c) => c.url === '/services/srv-1/deploys/dep-2'));
  } finally { await fr.close(); }
});

test('Render : mauvaise clé, build en échec, attente trop longue = messages clairs', async () => {
  let fr = await fakeRender();
  try {
    await assert.rejects(() => deployToRender(opts(fr, { apiKey: 'mauvaise' })), /401/);
  } finally { await fr.close(); }
  fr = await fakeRender({ failBuild: true });
  try {
    await assert.rejects(() => deployToRender(opts(fr)), /échoué \(build_failed\).*Logs/s);
  } finally { await fr.close(); }
  fr = await fakeRender({ never: true });
  try {
    await assert.rejects(() => deployToRender(opts(fr, { maxWaitMs: 50, sleep: () => new Promise((r) => setTimeout(r, 20)) })), /plus de 20 minutes/);
  } finally { await fr.close(); }
});

test('Render : mise à jour = redéploiement sans toucher aux variables, puis vérification de la version en ligne', async () => {
  const { redeployRender } = await import('../scripts/render-deploy.mjs');
  const fr = await fakeRender({ existing: true });
  const live = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ version: liveVersion })); });
  let liveVersion = '0.9.0';
  await new Promise((r) => live.listen(0, '127.0.0.1', r));
  const liveUrl = `http://127.0.0.1:${live.address().port}`;
  try {
    // le faux Render renvoie l'adresse du faux site
    const fetchFn = (u, o) => fetch(u.replace('https://boutique-abc.onrender.com', liveUrl), o);
    const base = { apiKey: 'rnd_ok', serviceId: 'srv-1', base: fr.base, sleep: async () => {}, log: () => {}, fetchFn };
    await assert.rejects(redeployRender({ ...base, expectVersion: '1.0.0' }), /0\.9\.0/); // ancienne version encore affichée
    liveVersion = '1.0.0';
    const r = await redeployRender({ ...base, expectVersion: '1.0.0' });
    assert.equal(r.version, '1.0.0');
    assert.ok(!fr.calls.some((c) => c.method === 'PUT'), 'les variables ne sont pas touchées');
    assert.ok(fr.calls.some((c) => c.method === 'POST' && c.url === '/services/srv-1/deploys'));
    await assert.rejects(redeployRender({ ...base, apiKey: 'mauvaise', expectVersion: '1.0.0' }), /401/);
  } finally { await fr.close(); live.closeAllConnections?.(); live.close(); }
});
