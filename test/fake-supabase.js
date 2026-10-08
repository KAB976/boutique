import http from 'node:http';

/** Imitation minimale de Supabase Storage, pour tester la copie en ligne sans réseau. */
export async function fakeSupabase(key = 'cle-secrete') {
  const objects = new Map(); // "bucket/chemin" -> Buffer
  const buckets = new Set();
  const state = { fail: 0, calls: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
      state.calls.push(`${req.method} ${req.url}`);
      if (req.headers.apikey !== key || (req.headers.authorization && req.headers.authorization !== `Bearer ${key}`)) return send(401, { message: 'bad key' });
      if (state.fail > 0 && req.method !== 'GET') { state.fail -= 1; return send(503, { message: 'indisponible' }); }
      const url = decodeURIComponent(req.url.split('?')[0]);
      let m;
      if (req.method === 'POST' && url === '/storage/v1/bucket') {
        const { id } = JSON.parse(body);
        if (buckets.has(id)) return send(409, { message: 'exists' });
        buckets.add(id); return send(200, { name: id });
      }
      if (req.method === 'POST' && (m = /^\/storage\/v1\/object\/list\/([^/]+)$/.exec(url))) {
        const { prefix } = JSON.parse(body);
        const pre = `${m[1]}/${prefix}/`;
        return send(200, [...objects.keys()].filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map((k) => ({ name: k.slice(pre.length) })).sort((a, b) => (a.name < b.name ? -1 : 1)));
      }
      if (req.method === 'GET' && (m = /^\/storage\/v1\/object\/authenticated\/(.+)$/.exec(url))) {
        return objects.has(m[1]) ? send(200, objects.get(m[1])) : send(404, { message: 'not found' });
      }
      if (req.method === 'POST' && (m = /^\/storage\/v1\/object\/([^/]+\/.+)$/.exec(url))) {
        if (objects.has(m[1])) return send(400, { message: 'The resource already exists' });
        objects.set(m[1], body); return send(200, { Key: m[1] });
      }
      if (req.method === 'DELETE' && (m = /^\/storage\/v1\/object\/([^/]+)$/.exec(url))) {
        for (const p of JSON.parse(body).prefixes) objects.delete(`${m[1]}/${p}`);
        return send(200, []);
      }
      return send(404, { message: `inconnu ${req.method} ${url}` });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, key, objects, buckets, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
