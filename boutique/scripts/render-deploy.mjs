/**
 * Création (ou retrouvaille) du service Render par l'API officielle, puis attente de la mise en ligne.
 * Séparé du script interactif pour pouvoir être testé avec un faux Render.
 */
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export async function deployToRender({ apiKey, repoUrl, env, name = 'boutique', region = 'frankfurt', base = 'https://api.render.com/v1', fetchFn = fetch, sleep = sleepReal, log = console.log, maxWaitMs = 20 * 60_000 }) {
  const call = async (method, p, body) => {
    const res = await fetchFn(`${base}${p}`, {
      method, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* texte brut */ }
    if (!res.ok) {
      const e = new Error(`Render a répondu ${res.status}${data?.message ? ` : ${data.message}` : text ? ` : ${text.slice(0, 200)}` : ''}`);
      e.status = res.status; throw e;
    }
    return data;
  };

  const owners = await call('GET', '/owners?limit=20');
  const owner = (owners || []).map((o) => o.owner || o).find((o) => o?.id);
  if (!owner) throw new Error('Aucun espace de travail trouvé dans ce compte Render.');

  const existing = ((await call('GET', `/services?name=${encodeURIComponent(name)}&ownerId=${owner.id}&limit=20`)) || []).map((s) => s.service || s).find((s) => s?.name === name);
  let service = existing;
  let deployId = null;
  if (existing) {
    log(`Le service « ${name} » existe déjà sur Render : je le réutilise et je mets ses réglages à jour.`);
    if (!existing.id) throw new Error('Render n\'a pas renvoyé d\'identifiant de service.');
    // Remplace toutes les variables (version de Node, clés Supabase…) puis relance un déploiement propre.
    await call('PUT', `/services/${existing.id}/env-vars`, Object.entries(env).map(([key, value]) => ({ key, value })));
    const d = await call('POST', `/services/${existing.id}/deploys`, { clearCache: 'clear' });
    deployId = (d?.deploy || d)?.id || null;
  } else {
    log('Création du service sur Render…');
    const created = await call('POST', '/services', {
      type: 'web_service', name, ownerId: owner.id, repo: repoUrl, branch: 'main', autoDeploy: 'yes',
      envVars: Object.entries(env).map(([key, value]) => ({ key, value })),
      serviceDetails: {
        runtime: 'node', plan: 'free', region, healthCheckPath: '/api/public',
        envSpecificDetails: { buildCommand: 'npm install --include=dev && npm run build', startCommand: 'npm start' },
      },
    });
    service = created.service || created;
    deployId = created.deployId || null;
  }
  if (!service?.id) throw new Error('Render n\'a pas renvoyé d\'identifiant de service.');

  const url = service.serviceDetails?.url || service.url;
  const started = Date.now();
  let last = '';
  while (Date.now() - started < maxWaitMs) {
    let d;
    if (deployId) d = await call('GET', `/services/${service.id}/deploys/${deployId}`);
    else { const deploys = (await call('GET', `/services/${service.id}/deploys?limit=1`)) || []; d = deploys[0]?.deploy || deploys[0]; }
    d = d?.deploy || d;
    const st = d?.status || 'en attente';
    if (st !== last) { log(`  état du déploiement : ${st}`); last = st; }
    if (st === 'live') return { url: url || (await call('GET', `/services/${service.id}`))?.serviceDetails?.url, serviceId: service.id };
    if (['build_failed', 'update_failed', 'canceled', 'pre_deploy_failed'].includes(st)) {
      throw new Error(`Le déploiement a échoué (${st}). Ouvrez https://dashboard.render.com, service « ${name} », onglet « Logs », et envoyez-moi les dernières lignes.`);
    }
    await sleep(10_000);
  }
  throw new Error('Le déploiement prend plus de 20 minutes. Regardez l\'avancement sur https://dashboard.render.com');
}

/**
 * Mise à jour d'un service existant : relance un déploiement SANS toucher aux variables (clés Supabase conservées),
 * attend qu'il soit en ligne, puis vérifie que la version en ligne est bien la bonne.
 */
export async function redeployRender({ apiKey, serviceId, expectVersion, base = 'https://api.render.com/v1', fetchFn = fetch, sleep = sleepReal, log = console.log, maxWaitMs = 20 * 60_000 }) {
  const call = async (method, p, body) => {
    const res = await fetchFn(`${base}${p}`, {
      method, headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* texte brut */ }
    if (!res.ok) { const e = new Error(`Render a répondu ${res.status}${data?.message ? ` : ${data.message}` : ''}`); e.status = res.status; throw e; }
    return data;
  };
  const svc = await call('GET', `/services/${serviceId}`);
  const url = svc?.serviceDetails?.url || svc?.url;
  const d = await call('POST', `/services/${serviceId}/deploys`, { clearCache: 'clear' });
  const deployId = (d?.deploy || d)?.id;
  if (!deployId) throw new Error('Render n\'a pas démarré le déploiement.');
  log('Déploiement lancé sur Render. Compter 3 à 6 minutes.');
  const started = Date.now(); let last = '';
  while (Date.now() - started < maxWaitMs) {
    const x = await call('GET', `/services/${serviceId}/deploys/${deployId}`);
    const st = (x?.deploy || x)?.status || 'en attente';
    if (st !== last) { log(`  état du déploiement : ${st}`); last = st; }
    if (st === 'live') break;
    if (['build_failed', 'update_failed', 'canceled', 'pre_deploy_failed'].includes(st)) {
      throw new Error(`Le déploiement a échoué (${st}). Ouvrez https://dashboard.render.com, votre service, onglet « Logs », et envoyez-moi les dernières lignes.`);
    }
    await sleep(10_000);
    if (Date.now() - started >= maxWaitMs) throw new Error('Le déploiement prend plus de 20 minutes. Regardez https://dashboard.render.com');
  }
  // Vérification : la version en ligne est-elle la bonne ? (le serveur peut mettre un instant à répondre)
  let seen = null;
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetchFn(`${url}/api/public`, { headers: { accept: 'application/json' } });
      if (r.ok) { seen = (await r.json()).version ?? null; if (seen === expectVersion) return { url, version: seen }; }
    } catch { /* pas encore prêt */ }
    await sleep(5_000);
  }
  throw new Error(`Le service est en ligne mais affiche la version « ${seen ?? 'inconnue'} » au lieu de « ${expectVersion} ». Dites-le-moi.`);
}
