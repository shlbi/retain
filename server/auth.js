import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { signupRules } from '../dist/signup-rules.js';
import { ApiError } from './database.js';

const derive = promisify(scrypt);
// OWASP's 32 MiB scrypt configuration. The recorded parameter tuple identifies
// the profile, so existing credentials can be verified and upgraded at sign-in.
const SCRYPT_OPTIONS = { N:32768, r:8, p:3, maxmem:64 * 1024 * 1024 };
const KEY_BYTES = 64;
const CURRENT_PREFIX = 'scrypt$32768$8$3$';
const LEGACY_PREFIX = 'scrypt$32768$8$1$';
const HASH_FORMAT = /^scrypt\$32768\$8\$[13]\$[a-f0-9]{32}\$[a-f0-9]{128}$/;
const MAX_DERIVATIONS = 2;
const waiting = [];
let deriving = 0;
export const SESSION_COOKIE = 'workspace_session';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
// A nonexistent account still incurs the same scrypt work and constant-time comparison.
const DUMMY_HASH = `${CURRENT_PREFIX}${Buffer.alloc(16, 0x59).toString('hex')}$${Buffer.alloc(KEY_BYTES, 0xa7).toString('hex')}`;

// Shared by sign-in, account creation and password changes. Bound both native memory in use
// and the number of queued jobs on each server instance under a burst of traffic.
async function deriveKey(password, salt, parallelism) {
  if (deriving < MAX_DERIVATIONS) deriving++;
  else {
    if (waiting.length >= 8) throw new ApiError(503,'AUTH_BUSY','Sign-in is busy. Try again in a moment.');
    await new Promise(resolve => waiting.push(resolve));
  }
  try {
    return await derive(password, salt, KEY_BYTES, {...SCRYPT_OPTIONS,p:parallelism});
  } finally {
    const next = waiting.shift();
    if (next) next();
    else deriving--;
  }
}

/** Existing usernames retain the limits active when the account was created. */
export function existingUsername(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 128 || Array.from(name).length > 64) throw new Error('Username must contain 1–64 characters.');
  return name;
}

export function credentials(username, password, action = 'login') {
  if (action === 'signup') {
    const errors = signupRules(username, password);
    if (errors.username || errors.password) throw new Error(errors.username || errors.password);
  } else {
    username = existingUsername(username);
    if (action === 'completePasswordChange') {
      const error = signupRules(username,password).password;
      if (error) throw new Error(error);
    } else if (typeof password !== 'string' || password.length < 1 || password.length > 2048 || Array.from(password).length > 1024) throw new Error('Password must contain 1–1024 characters.');
  }
  return { username:username.trim(), password };
}

/** Hash passwords with a fresh random 128-bit salt and bounded scrypt parameters. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, SCRYPT_OPTIONS.p);
  return `${CURRENT_PREFIX}${salt.toString('hex')}$${key.toString('hex')}`;
}

export function needsPasswordUpgrade(storedHash) {
  return typeof storedHash === 'string' && storedHash.startsWith(LEGACY_PREFIX) && HASH_FORMAT.test(storedHash);
}

/** Never let a malformed stored hash choose its own expensive KDF parameters. */
export async function verifyPassword(password, storedHash) {
  const valid = typeof storedHash === 'string' && HASH_FORMAT.test(storedHash);
  const parts = (valid ? storedHash : DUMMY_HASH).split('$');
  const expected = Buffer.from(parts[5], 'hex');
  const salt = Buffer.from(parts[4], 'hex'), parallelism = Number(parts[3]);
  const actual = await deriveKey(password, salt, parallelism);
  const matches = timingSafeEqual(actual, expected) && valid;
  // Failed legacy guesses should incur comparable work to a missing or upgraded account.
  if (!matches && parallelism === 1) await deriveKey(password, salt, SCRYPT_OPTIONS.p - parallelism);
  return matches;
}

/** Only a token digest is persisted; the 256-bit bearer token remains in the cookie. */
export function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
export function newSession() { const token = randomBytes(32).toString('base64url'); return { token, hash:tokenHash(token) }; }
export function newPasswordChangeCode() { return randomBytes(16).toString('hex'); }

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
