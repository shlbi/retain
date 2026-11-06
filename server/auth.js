import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const SCRYPT_OPTIONS = { N:32768, r:8, p:1, maxmem:64 * 1024 * 1024 };
const KEY_BYTES = 64;
export const SESSION_COOKIE = 'workspace_session';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
// A nonexistent account still incurs the same scrypt work and constant-time comparison.
const DUMMY_HASH = `scrypt$32768$8$1$${Buffer.alloc(16, 0x59).toString('hex')}$${Buffer.alloc(KEY_BYTES, 0xa7).toString('hex')}`;

/** Keep the requested permissive credential policy without coercing non-text values. */
export function credentials(username, password) {
  if (typeof username !== 'string' || !username.trim() || Array.from(username.trim()).length > 64) throw new Error('Username must contain 1–64 characters.');
  if (typeof password !== 'string' || password.length < 1 || Array.from(password).length > 1024) throw new Error('Password must contain 1–1024 characters.');
  return { username:username.trim(), password };
}

/** Hash passwords with a fresh random 128-bit salt and bounded scrypt parameters. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_BYTES, SCRYPT_OPTIONS);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Never let a malformed stored hash choose its own expensive KDF parameters. */
export async function verifyPassword(password, storedHash) {
  const valid = typeof storedHash === 'string' && /^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(storedHash);
  const parts = (valid ? storedHash : DUMMY_HASH).split('$');
  const expected = Buffer.from(parts[5], 'hex');
  const actual = await derive(password, Buffer.from(parts[4], 'hex'), KEY_BYTES, SCRYPT_OPTIONS);
  return timingSafeEqual(actual, expected) && valid;
}

/** Only a token digest is persisted; the 256-bit bearer token remains in the cookie. */
export function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
export function newSession() { const token = randomBytes(32).toString('base64url'); return { token, hash:tokenHash(token) }; }

/** Ignore malformed or ambiguous duplicate cookies rather than guessing an identity. */
export function sessionToken(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  const matches = cookieHeader.split(';').map(part=>part.trim()).filter(part=>part.startsWith(SESSION_COOKIE + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/** Cookies are host-only, inaccessible to JavaScript, and never sent cross-site. */
export function sessionCookie(token, { secure = true, now = Date.now(), clear = false } = {}) {
  return `${SESSION_COOKIE}=${clear?'':token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:SESSION_SECONDS}; Expires=${new Date(clear?0:now + SESSION_SECONDS * 1000).toUTCString()}${secure?'; Secure':''}`;
}
