import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { cloudConfig, restoreFromCloud, CloudSync } from './cloud.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const port = Number(process.env.PORT) || 3000;

// Mode « en ligne » : si SUPABASE_URL et SUPABASE_SERVICE_KEY sont fournis, la base est rapatriée au
// démarrage puis copiée après chaque modification (voir server/cloud.js).
let cloud = null;
try {
  const cfg = cloudConfig();
  if (cfg) {
    const seq = await restoreFromCloud(cfg, dataDir);
    cloud = new CloudSync(cfg, { seq });
  }
} catch (e) {
  console.error(`Démarrage annulé : ${e.message}`);
  process.exit(1);
}

const ctx = createApp({ dataDir, staticDir: path.join(root, 'dist'), cloud });
cloud?.onWrite(); // première copie (migrations éventuelles, base neuve)

try { ctx.ensureDailyBackup(); } catch (e) { console.error('Sauvegarde automatique impossible :', e.message); }
setInterval(() => {
  try { ctx.ensureDailyBackup(); } catch (e) { console.error('Sauvegarde automatique impossible :', e.message); }
}, 15 * 60 * 1000).unref();

const server = ctx.app.listen(port, () => console.log(`Boutique prête sur http://localhost:${port}  (données : ${dataDir}${cloud ? ', copie en ligne activée' : ''})`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await cloud?.flush(); } catch { /* déjà journalisé */ }
    server.close(() => { try { ctx.db.close(); } catch { /* ignore */ } process.exit(0); });
  });
}
