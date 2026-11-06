import { DEFAULT_GOALS } from '../dist/model.js';
import { validateCall, validateGoals, validateBackup, MAX_BACKUP_CALLS, StorageError } from '../dist/validation.js';
import { credentials, hashPassword, verifyPassword, tokenHash, newSession, sessionToken, sessionCookie, SESSION_SECONDS } from './auth.js';
import { ApiError, createDatabase } from './database.js';

const ACTION_FIELDS = {signup:['username','password'],login:['username','password'],logout:[],save:['call','expectedRevision'],remove:['id','expectedRevision'],restore:['call'],goal:['key','value'],import:['backup']};
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const VALIDATION = message => new ApiError(400,'VALIDATION',message);

/** Read a single HTTP header without accepting ambiguous array values. */
function header(req,key) { const value = req.headers?.[key]; return typeof value === 'string' ? value : ''; }

/** The local exception is limited to loopback, never arbitrary plain-HTTP production hosts. */
function localHost(host) { try { return ['localhost','127.0.0.1','[::1]'].includes(new URL(`http://${host}`).hostname); } catch { return false; } }
function secureRequest(req,env) { if (env.VERCEL || env.NODE_ENV === 'production' || env.APP_ORIGIN?.startsWith('https://') || header(req,'x-forwarded-proto') === 'https') return true; return env.NODE_ENV !== 'development' && !localHost(header(req,'host')); }

/** Require the browser's exact origin plus JSON on every mutating request, including login. */
export function guardMutation(req,env) {
  const host = header(req,'host');
  if (!host || /[\s/\\@]/.test(host)) throw VALIDATION('The request host is invalid.');
  let expected, supplied;
  try {
    expected = new URL(env.APP_ORIGIN || `${secureRequest(req,env)?'https':'http'}://${host}`).origin;
    supplied = new URL(header(req,'origin')).origin;
  } catch { throw VALIDATION('Open this page on its own site before submitting changes.'); }
  if (header(req,'origin') !== supplied || expected !== supplied || (header(req,'sec-fetch-site') && header(req,'sec-fetch-site') !== 'same-origin')) throw VALIDATION('Cross-site requests are not allowed. Reload this page on its original site.');
  if (!/^application\/json(?:\s*;|$)/i.test(header(req,'content-type'))) throw VALIDATION('Send this request as JSON.');
}

/** Bound raw or platform-parsed request bodies before accepting an action. */
export async function readJson(req) {
  const length = header(req,'content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) throw VALIDATION('The request exceeds the 4 MiB limit.');
  let input = req.body;
  if (input === undefined) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_REQUEST_BYTES) throw VALIDATION('The request exceeds the 4 MiB limit.');
      chunks.push(buffer);
    }
    input = Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(input)) input = input.toString('utf8');
  if (typeof input === 'string') {
    if (Buffer.byteLength(input,'utf8') > MAX_REQUEST_BYTES) throw VALIDATION('The request exceeds the 4 MiB limit.');
    try { input = JSON.parse(input); } catch { throw VALIDATION('This request contains invalid JSON.'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) throw VALIDATION('Send one JSON object.');
  if (Buffer.byteLength(JSON.stringify(input),'utf8') > MAX_REQUEST_BYTES) throw VALIDATION('The request exceeds the 4 MiB limit.');
  if (!Object.hasOwn(ACTION_FIELDS,input.action)) throw VALIDATION('Choose a supported action.');
  const fields = ['action',...ACTION_FIELDS[input.action]];
  if (Object.keys(input).some(key=>!fields.includes(key))) throw VALIDATION('This request contains unsupported fields.');
  return input;
}

/** Use Vercel's overwritten forwarding header only when actually deployed on Vercel. */
function clientAddress(req,env) { return env.VERCEL ? (header(req,'x-vercel-forwarded-for') || header(req,'x-forwarded-for')).split(',')[0].trim() || 'unknown' : req.socket?.remoteAddress || 'unknown'; }

/** Rate counters live in Postgres so all function instances enforce the same limits. */
async function authRateLimit(db,req,env,action,username) {
  const limits = [
    {key:`auth:ip:${tokenHash(clientAddress(req,env))}`,limit:60,seconds:900},
    {key:`${action}:name:${tokenHash(username.toLowerCase())}`,limit:10,seconds:900},
    ...(action === 'signup' ? [{key:`signup:ip:${tokenHash(clientAddress(req,env))}`,limit:5,seconds:3600}] : [])
  ];
  for (const item of limits) {
    const allowed = await db.rpc('auth_rate_limit',{p_key:item.key,p_limit:item.limit,p_window_seconds:item.seconds});
    if (allowed !== true) throw new ApiError(429,'RATE_LIMIT','Too many attempts. Wait before trying again.');
  }
}

/** Return only the public identity fields, never a stored hash or session record. */
function publicUser(value) { return value && typeof value.id === 'string' && typeof value.username === 'string' ? {id:value.id,username:value.username} : null; }
async function currentUser(db,req) { const token = sessionToken(header(req,'cookie')); return token ? publicUser(await db.rpc('auth_session',{p_token_hash:tokenHash(token)})) : null; }
function expectedRevision(value, nullable = false) { if (nullable && value === null) return null; if (!Number.isSafeInteger(value) || value < 1) throw VALIDATION('Supply the record revision you reviewed.'); return value; }
function recordId(value) { if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /\p{C}/u.test(value)) throw VALIDATION('Choose a valid call record.'); return value.trim(); }

/** Validate the persisted snapshot before returning it to browser calculations. */
function safeState(state) {
  if (!state || state.version !== 3 || !Array.isArray(state.calls) || state.calls.length > MAX_BACKUP_CALLS) throw new ApiError(503,'STORAGE','Saved records could not be read safely.');
  try { return {version:3,calls:state.calls.map(call=>validateCall(call,{allowLegacy:false})),goals:validateGoals(state.goals)}; }
  catch { throw new ApiError(503,'STORAGE','Saved records could not be read safely.'); }
}

/** Dependency injection makes authorization and HTTP behavior testable without real credentials. */
export function createHandler({env = process.env, database, fetchImpl = globalThis.fetch, clock = Date.now} = {}) {
  return async function handler(req,res) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Vary','Cookie, X-Workspace-User');
    const send = (status,value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    try {
      if (!['GET','POST'].includes(req.method)) { res.setHeader('Allow','GET, POST'); throw new ApiError(405,'METHOD','Use GET or POST for this endpoint.'); }
      let body;
      if (req.method === 'POST') { guardMutation(req,env); body = await readJson(req); }
      const db = database || createDatabase(env,fetchImpl);
      if (req.method === 'POST' && ['signup','login'].includes(body.action)) {
        let account;
        try { account = credentials(body.username,body.password); } catch(error) { throw VALIDATION(error.message); }
        await authRateLimit(db,req,env,body.action,account.username);
        let user;
        if (body.action === 'signup') {
          user = publicUser(await db.rpc('auth_register',{p_username:account.username,p_password_hash:await hashPassword(account.password)}));
        } else {
          const stored = await db.rpc('auth_get_user',{p_username_key:account.username});
          const matches = await verifyPassword(account.password,stored?.password_hash);
          if (!matches || !publicUser(stored)) throw new ApiError(401,'AUTH','Username or password is incorrect.');
          user = publicUser(stored);
        }
        if (!user) throw new ApiError(503,'STORAGE','Your account could not be opened. Try signing in again.');
        const session = newSession(), now = clock();
        await db.rpc('auth_create_session',{p_user_id:user.id,p_token_hash:session.hash,p_expires_at:new Date(now + SESSION_SECONDS * 1000).toISOString()});
        const previous = sessionToken(header(req,'cookie'));
        if (previous) await db.rpc('auth_logout',{p_token_hash:tokenHash(previous)});
        res.setHeader('Set-Cookie',sessionCookie(session.token,{secure:secureRequest(req,env),now}));
        return send(200,{user});
      }
      if (req.method === 'POST' && body.action === 'logout') {
        const token = sessionToken(header(req,'cookie'));
        if (token) await db.rpc('auth_logout',{p_token_hash:tokenHash(token)});
        res.setHeader('Set-Cookie',sessionCookie('',{secure:secureRequest(req,env),clear:true}));
        return send(200,{ok:true});
      }
      const user = await currentUser(db,req);
      if (req.method === 'GET') {
        const action = new URL(req.url || '/api/workspace','http://localhost').searchParams.get('action');
        if (!action) return send(200,{user});
        if (action !== 'state') throw VALIDATION('Choose a supported action.');
      }
      if (!user) throw new ApiError(401,'AUTH','Sign in to open your saved records.');
      if (header(req,'x-workspace-user') !== user.id) throw new ApiError(401,'AUTH','Your session changed. Sign in again.');
      if (req.method === 'GET') return send(200,safeState(await db.rpc('workspace_state',{p_user_id:user.id})));
      let result;
      switch (body.action) {
        case 'save': result = await db.rpc('workspace_save',{p_user_id:user.id,p_call:validateCall(body.call,{allowLegacy:false}),p_expected_revision:expectedRevision(body.expectedRevision,true)}); break;
        case 'remove': result = await db.rpc('workspace_remove',{p_user_id:user.id,p_id:recordId(body.id),p_expected_revision:expectedRevision(body.expectedRevision)}); break;
        case 'restore': result = await db.rpc('workspace_restore',{p_user_id:user.id,p_call:validateCall(body.call,{allowLegacy:false})}); break;
        case 'goal': {
          if (!Object.hasOwn(DEFAULT_GOALS,body.key) || !Number.isInteger(body.value) || body.value < 5 || body.value > 100) throw VALIDATION('Choose a known goal and a whole percentage from 5 to 100.');
          result = await db.rpc('workspace_goal',{p_user_id:user.id,p_key:body.key,p_value:body.value}); break;
        }
        case 'import': result = await db.rpc('workspace_import',{p_user_id:user.id,p_backup:validateBackup(body.backup)}); break;
        default: throw VALIDATION('Choose a supported action.');
      }
      return send(200,result);
    } catch(error) {
      const problem = error instanceof ApiError ? error : error instanceof StorageError ? new ApiError(error.code === 'CONFLICT' || error.code === 'DUPLICATE' ? 409 : 400,error.code,error.message) : new ApiError(503,'STORAGE','The server could not confirm this operation. Reload your saved records before retrying.');
      if (problem.status === 429) res.setHeader('Retry-After','900');
      return send(problem.status,{error:{code:problem.code,message:problem.message}});
    }
  };
}
