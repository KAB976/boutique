import crypto from 'node:crypto';

const N = 16384, R = 8, P = 1;

export const PIN_RE = /^\d{4,8}$/;

/** Retourne un message d'erreur en français, ou null si le PIN est acceptable. */
export function pinProblem(pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) return 'Le code PIN doit contenir de 4 à 8 chiffres.';
  if (/^(\d)\1+$/.test(pin)) return 'Ce code est trop simple (même chiffre répété).';
  const d = [...pin].map(Number);
  const asc = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const desc = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  if (asc || desc) return 'Ce code est trop simple (suite de chiffres).';
  return null;
}

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pin, salt, 32, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${h.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  try {
    const [alg, n, r, p, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const h = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length, { N: +n, r: +r, p: +p });
    return crypto.timingSafeEqual(h, expected);
  } catch {
    return false;
  }
}

/** Faux hachage pour que « utilisateur inconnu » prenne le même temps que « mauvais PIN ». */
const DUMMY = hashPin('00000000');
export const burnTime = (pin) => verifyPin(String(pin ?? ''), DUMMY);

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
