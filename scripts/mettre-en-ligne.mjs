/**
 * Mise en ligne automatique : GitHub (coffre du programme) + Render (serveur gratuit) + vérification Supabase.
 * Usage : MISE-EN-LIGNE.bat   (ou : node scripts/mettre-en-ligne.mjs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { CloudSync, cloudConfig } from '../server/cloud.js';
import { deployToRender, redeployRender } from './render-deploy.mjs';


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const MARK = path.join(root, '.mise-en-ligne.json');
const say = (...a) => console.log(...a);
const title = (t) => say(`\n=== ${t} ===`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(`${q} `)).trim();
const has = (cmd, args = ['--version']) => { try { execFileSync(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32' }); return true; } catch { return false; } };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const stop = (msg) => { say(`\n✗ ${msg}\n`); rl.close(); process.exit(1); };

async function ensureTool(cmd, wingetId, label) {
  if (has(cmd)) return;
  say(`${label} n'est pas installé : je l'installe (Windows peut demander une autorisation, répondez Oui)…`);
  if (process.platform === 'win32' && has('winget')) {
    run('winget', ['install', '--id', wingetId, '-e', '--accept-package-agreements', '--accept-source-agreements']);
    stop(`${label} vient d'être installé. FERMEZ cette fenêtre noire, rouvrez-en une et relancez MISE-EN-LIGNE.bat (Windows doit relire ses réglages).`);
  }
  stop(`Installez ${label} (https://${cmd === 'git' ? 'git-scm.com' : 'cli.github.com'}) puis relancez MISE-EN-LIGNE.bat.`);
}

async function main() {
  say('MISE EN LIGNE DE BOUTIQUE (gratuit : GitHub + Render + Supabase)');
  say(`\n>>> VERSION À ENVOYER : ${VERSION}   (dossier : ${root})\n`);
  if (Number(process.versions.node.split('.')[0]) < 22) stop('Node.js 22 ou plus récent est nécessaire (https://nodejs.org, version LTS).');

  await ensureTool('git', 'Git.Git', 'Git');
  await ensureTool('gh', 'GitHub.cli', 'GitHub CLI');

  // ---------- GitHub ----------
  title('1/3  GitHub');
  if (spawnSync('gh', ['auth', 'status'], { shell: process.platform === 'win32', stdio: 'ignore' }).status !== 0) {
    const TOK_FILE = path.join(root, '.jeton-github.txt');
    const okTok = (t) => spawnSync('gh', ['api', 'user', '--jq', '.login'], { shell: process.platform === 'win32', stdio: 'ignore', env: { ...process.env, GH_TOKEN: t } }).status === 0;
    let saved = '';
    try { saved = fs.readFileSync(TOK_FILE, 'utf8').trim(); } catch { /* pas encore de jeton enregistré */ }
    if (saved && okTok(saved)) { say('Jeton GitHub enregistré trouvé : connexion automatique.'); process.env.GH_TOKEN = saved; }
    else {
      if (saved) say('Le jeton enregistré n\'est plus valable (expiré). Il faut en coller un nouveau.\n');
      say('Connexion à GitHub : collez ici votre jeton GitHub (il commence par ghp_), puis Entrée.');
      say('  Pas de jeton ? Ouvrez https://github.com/settings/tokens/new  → Note : boutique → Expiration : 90 jours → cochez seulement « repo » → Generate token → copiez-le.');
      say('  (Clic droit dans cette fenêtre pour coller. Il sera retenu sur CET ordinateur : vous ne le redemanderez plus avant son expiration.)\n');
      const tok = await ask('Jeton GitHub :');
      if (tok) {
        if (!okTok(tok)) stop('Ce jeton est refusé par GitHub (mal copié, expiré, ou la case « repo » n\'est pas cochée). Relancez et recommencez avec un nouveau jeton.');
        process.env.GH_TOKEN = tok;
        // Sécurité : le fichier est ignoré par git, il ne part donc JAMAIS sur GitHub.
        const ign = spawnSync('git', ['check-ignore', '-q', '.jeton-github.txt'], { shell: process.platform === 'win32' }).status === 0;
        if (ign) { try { fs.writeFileSync(TOK_FILE, tok + '\n'); say('Jeton retenu sur cet ordinateur (fichier .jeton-github.txt).'); } catch { /* tant pis */ } }
      } else {
        say('\nConnexion par navigateur : un code va s\'afficher, le navigateur s\'ouvre, collez le code et validez.\n');
        const r = run('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web']);
        if (r.status !== 0) stop('La connexion à GitHub a échoué. Relancez MISE-EN-LIGNE.bat.');
      }
    }
  }
  run('gh', ['auth', 'setup-git']);
  const user = out('gh', ['api', 'user', '--jq', '.login']);
  say(`Connecté à GitHub comme « ${user} ».`);

  if (!fs.existsSync(path.join(root, '.git'))) { run('git', ['init', '-b', 'main']); }
  const cfg = (k, v) => { if (spawnSync('git', ['config', k], { shell: process.platform === 'win32' }).stdout.toString().trim() === '') run('git', ['config', k, v]); };
  cfg('user.name', user); cfg('user.email', `${user}@users.noreply.github.com`);
  run('git', ['add', '-A']);
  const dirty = spawnSync('git', ['diff', '--cached', '--quiet'], { shell: process.platform === 'win32' }).status !== 0;
  if (dirty) run('git', ['commit', '-m', 'Boutique']);
  const hasRemote = spawnSync('git', ['remote', 'get-url', 'origin'], { shell: process.platform === 'win32', stdio: 'ignore' }).status === 0;
  const repoUrl = `https://github.com/${user}/boutique`;
  if (!hasRemote) {
    say('Création du dépôt « boutique » sur GitHub…');
    // Public : Render peut alors le lire sans autre autorisation. Il ne contient ni données ni clés.
    const r = run('gh', ['repo', 'create', 'boutique', '--public', '--source=.', '--remote=origin', '--push']);
    if (r.status !== 0) stop('Impossible de créer le dépôt GitHub (un dépôt « boutique » existe peut-être déjà sur votre compte : supprimez-le sur github.com ou renommez-le, puis relancez).');
  } else {
    let r = run('git', ['push', '-u', 'origin', 'main']);
    if (r.status !== 0) {
      // Le plus souvent : des fichiers ont été ajoutés à la main sur github.com. Ce dépôt ne contient que le programme : on le remplace par celui de ce dossier.
      say('GitHub a refusé l\'envoi normal (le dépôt a été modifié à la main). Je le remplace par le contenu de ce dossier…');
      r = run('git', ['push', '-u', '--force', 'origin', 'main']);
      if (r.status !== 0) stop('L\'envoi vers GitHub a échoué.');
    }
  }
  say('Programme envoyé sur GitHub.');
  // Contrôle : la version qui est sur GitHub est-elle bien celle de ce dossier ?
  try {
    const raw = out('gh', ['api', `repos/${user}/boutique/contents/package.json`, '--jq', '.content']);
    const onGithub = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')).version;
    if (onGithub !== VERSION) stop(`GitHub contient la version ${onGithub} au lieu de ${VERSION}. Rien n'a été mis en ligne. Dites-le-moi.`);
    say(`✓ GitHub contient bien la version ${onGithub}.`);
  } catch (e) { if (String(e.message).includes('GitHub contient')) throw e; say('(Contrôle de la version sur GitHub impossible, on continue.)'); }

  // ---------- mise à jour d'une installation existante ----------
  if (fs.existsSync(MARK)) {
    const m = JSON.parse(fs.readFileSync(MARK, 'utf8'));
    title('Mise à jour sur Render');
    say('Render se met à jour tout seul après l\'envoi sur GitHub : la clé API Render n\'est pas nécessaire.');
    say('Si vous l\'avez, collez-la pour lancer la mise à jour tout de suite ; sinon appuyez sur Entrée.\n');
    const apiKey = await ask('Clé API Render (facultatif) :');
    try {
      if (apiKey) {
        const r = await redeployRender({ apiKey, serviceId: m.serviceId, expectVersion: VERSION, log: say });
        say(`\n✓ TERMINÉ. Version ${r.version} en ligne :\n\n    ${r.url}\n`);
      } else {
        say(`\nJ'attends que ${m.url} passe en version ${VERSION} (3 à 8 minutes, ne fermez pas la fenêtre)…`);
        const t0 = Date.now(); let seen = null;
        while (Date.now() - t0 < 12 * 60 * 1000) {
          await new Promise((ok) => setTimeout(ok, 15000));
          try { const j = await (await fetch(`${m.url}/api/public`, { signal: AbortSignal.timeout(20000) })).json(); if (j.version !== seen) { seen = j.version; say(`  version actuellement en ligne : ${seen}`); } if (j.version === VERSION) break; } catch { say('  (le serveur redémarre…)'); }
        }
        if (seen !== VERSION) stop(`Après 12 minutes, la version en ligne est ${seen ?? 'inconnue'} au lieu de ${VERSION}. Ouvrez https://dashboard.render.com, votre service, onglet Events, et regardez si le déploiement est en erreur. Dites-moi ce que vous voyez.`);
        say(`\n✓ TERMINÉ. Version ${seen} en ligne :\n\n    ${m.url}\n`);
      }
      say('Sur le téléphone / la tablette : fermez puis rouvrez l\'application (ou F5 sur PC).');
    } catch (e) { stop(e.message); }
    rl.close(); return;
  }

  // ---------- Supabase ----------
  title('2/3  Supabase (vos données)');
  say('Dans le tableau de bord Supabase (https://supabase.com/dashboard) : ouvrez un projet,');
  say('puis Project Settings (engrenage) > API. Copiez « Project URL » et la clé « service_role » (Reveal)');
  say('ou la clé « secret » (sb_secret_…). Cette clé est un mot de passe maître : ne la partagez avec personne.\n');
  let sbCfg;
  for (;;) {
    const url = await ask('Project URL (https://xxxx.supabase.co) :');
    const key = await ask('Clé secrète :');
    try { sbCfg = cloudConfig({ SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key }); } catch (e) { say(`✗ ${e.message}`); continue; }
    say('Vérification de la connexion à Supabase…');
    try { await new CloudSync(sbCfg).selfTest(); say('✓ Supabase répond et accepte la clé.'); break; }
    catch (e) { say(`✗ ${e.message}\n  Vérifiez l'adresse et la clé (sans espace), puis recommencez.\n`); }
  }

  // ---------- Render ----------
  title('3/3  Render (le serveur)');
  say('Créez un compte gratuit sur https://render.com si ce n\'est pas fait (bouton Get Started).');
  say('Puis : en haut à droite, votre nom > Account Settings > API Keys > Create API Key. Copiez la clé.\n');
  const apiKey = await ask('Clé API Render :');
  let result;
  try {
    result = await deployToRender({
      apiKey, repoUrl,
      env: { NODE_VERSION: '22.22.0', TRUST_PROXY: '1', SUPABASE_URL: sbCfg.url, SUPABASE_SERVICE_KEY: sbCfg.key },
      log: say,
    });
  } catch (e) { stop(`${e.message}\n  (Si Render demande une carte bancaire ou refuse l'offre gratuite, dites-le-moi.)`); }

  fs.writeFileSync(MARK, JSON.stringify({ url: result.url, serviceId: result.serviceId, repo: repoUrl }, null, 2));
  fs.writeFileSync(path.join(root, 'ADRESSE-BOUTIQUE.txt'), `Votre application : ${result.url}\r\n`);
  say(`\n✓ TERMINÉ. Votre application est en ligne :\n\n    ${result.url}\n`);
  say('Ouvrez cette adresse sur le PC, la tablette ou le téléphone. (La première ouverture peut prendre 1 minute.)');
  say('Elle est aussi enregistrée dans ADRESSE-BOUTIQUE.txt.');
  if (process.platform === 'win32') run('cmd', ['/c', 'start', '', result.url]);
  rl.close();
}

main().catch((e) => stop(e.message));
