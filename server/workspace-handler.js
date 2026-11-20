import { DEFAULT_GOALS } from '../dist/model.js';
import { StorageError } from '../dist/validation.js';
import { validateDayTotals, validateTallyState, validateTallyUpdate } from '../dist/tally-validation.js';
import { credentials, hashPassword, verifyPassword, tokenHash, newSession, sessionToken, sessionCookie, SESSION_SECONDS } from './auth.js';
import { gameConnection } from './game-connection.js';
import { ApiError, createDatabase } from './database.js';

const ACTION_FIELDS = {signup:['username','password','requestedRole'],login:['username','password'],logout:[],tally:['day','delta','requestId'],goal:['key','value'],editDay:['expected','replacement'],
  adminCreateAccount:['username','password','role','supervisorId'],adminReviewSignup:['requestId','decision','role','supervisorId'],
  adminAssignAccount:['accountId','role','supervisorId','expectedRole','expectedSupervisorId'],
  agentState:['agentId'],teamGoals:['agentIds','goals'],gameSchedule:['title','incentive','startsAt','endsAt','pattern','squares']};
const READ_ACTIONS = {
  state:'workspace_tally_state', teamContext:'workspace_team_context',
  adminStats:'workspace_admin_stats', adminPerformance:'workspace_admin_performance',
  adminAccounts:'workspace_admin_accounts', gameState:'workspace_game_state'
};
const signupRoles = ['agent','supervisor'];
const accountRoles = [...signupRoles,'admin'];
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
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
function validatedCredentials(body, action) {
  try { return credentials(body.username,body.password,action); }
  catch (error) { throw VALIDATION(error.message); }
}
function validateAssignment(role, supervisorId, roles = accountRoles) {
  if (!roles.includes(role)) throw VALIDATION('Choose a valid account role.');
  if (supervisorId !== null && (!isUuid(supervisorId) || role === 'supervisor')) throw VALIDATION('Choose a valid supervisor for this account.');
}
/** A management session may see tracker identities and assignments, never credential records. */
function accountDirectory(value) {
  return {
    pending:value.pending.map(({id,username,requestedRole,requestedAt}) => ({id,username,requestedRole,requestedAt})),
    accounts:value.accounts.map(({id,username,role,supervisorId}) => ({id,username,role,supervisorId}))
  };
}
/** A schema mismatch must never expose unvalidated columns or legacy identifiers. */
function safeResult(value, validate) {
  try { return validate(value); }
  catch { throw new ApiError(503,'STORAGE','The saved tallies could not be read safely.'); }
}

/** Dependency injection makes authorization and HTTP behavior testable without real credentials. */
export function createHandler({env = process.env, database, fetchImpl = globalThis.fetch, clock = Date.now} = {}) {
  return async function handler(req,res) {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Vary','Cookie, X-Workspace-User');
    let metricsDatabase;
    const started = performance.now();
    // Count authenticated workspace requests only. The monitoring write has its own
    // short timeout and cannot turn a committed save into a failed response.
    const send = async (status,value) => {
      if (metricsDatabase) {
        const elapsed = Math.round(performance.now() - started);
        try {
          await metricsDatabase.rpc('workspace_record_request',{p_failed:status >= 500,p_elapsed_ms:elapsed},1000);
        } catch { /* Telemetry may be unavailable during a database outage. */ }
      }
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    try {
      if (!['GET','POST'].includes(req.method)) { res.setHeader('Allow','GET, POST'); throw new ApiError(405,'METHOD','Use GET or POST for this endpoint.'); }
      let body;
      if (req.method === 'POST') { guardMutation(req,env); body = await readJson(req); }
      const db = database || createDatabase(env,fetchImpl);
      if (req.method === 'POST' && ['signup','login'].includes(body.action)) {
        const account = validatedCredentials(body,body.action);
        const requestedRole = body.requestedRole === undefined ? 'agent' : body.requestedRole;
        if (body.action === 'signup' && !signupRoles.includes(requestedRole)) throw VALIDATION('Choose an agent or supervisor account.');
        await authRateLimit(db,req,env,body.action,account.username);
        if (body.action === 'signup') {
          const submitted = await db.rpc('auth_request_signup',{p_username:account.username,p_password_hash:await hashPassword(account.password),p_requested_role:requestedRole});
          if (submitted?.status !== 'pending') throw new ApiError(503,'STORAGE','Could not confirm the sign-up request. Try again.');
          return send(202,{status:'pending'});
        }
        const stored = await db.rpc('auth_get_user',{p_username_key:account.username});
        const matches = await verifyPassword(account.password,stored?.password_hash);
        const user = publicUser(stored);
        if (!matches || !user) throw new ApiError(401,'AUTH','Username or password is incorrect.');
        if (stored.status === 'pending') throw new ApiError(403,'PENDING_APPROVAL','Your request is waiting for admin approval.');
        if (stored.status !== 'active') throw new ApiError(503,'STORAGE','Your account could not be opened. Try signing in again.');
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
      let action;
      if (req.method === 'GET') {
        action = new URL(req.url || '/api/workspace','http://localhost').searchParams.get('action');
        if (!action) return send(200,{user});
        if (!Object.hasOwn(READ_ACTIONS,action)) throw VALIDATION('Choose a supported action.');
      }
      if (!user) throw new ApiError(401,'AUTH','Sign in to open your saved records.');
      if (header(req,'x-workspace-user') !== user.id) throw new ApiError(401,'AUTH','Your session changed. Sign in again.');
      metricsDatabase = db;
      if (req.method === 'GET') {
        const data = await db.rpc(READ_ACTIONS[action],{p_user_id:user.id});
        if (action === 'gameState') return send(200,gameConnection(data,env));
        if (action === 'adminAccounts') return send(200,accountDirectory(data));
        return send(200,action === 'state' ? safeResult(data,validateTallyState) : data);
      }
      let result;
      switch (body.action) {
        case 'adminCreateAccount': {
          const {role,supervisorId} = body;
          validateAssignment(role,supervisorId);
          const account = validatedCredentials(body,'signup');
          // Check access before performing a password hash. The write checks it again atomically.
          const context = await db.rpc('workspace_team_context',{p_user_id:user.id});
          if (context?.role !== 'admin') throw new ApiError(403,'FORBIDDEN','Only an admin can create an account.');
          result = await db.rpc('workspace_admin_create_account',{
            p_user_id:user.id,p_username:account.username,p_password_hash:await hashPassword(account.password),
            p_role:role,p_supervisor_id:supervisorId
          });
          break;
        }
        case 'adminReviewSignup': {
          const {requestId,decision} = body;
          if (!isUuid(requestId) || !['approve','deny'].includes(decision)) throw VALIDATION('Choose a pending request and a decision.');
          const role = body.role ?? null, supervisorId = body.supervisorId ?? null;
          if (decision === 'approve') validateAssignment(role,supervisorId,signupRoles);
          else if (role !== null || supervisorId !== null) throw VALIDATION('A denied request cannot receive an assignment.');
          result = await db.rpc('workspace_admin_review_signup',{
            p_user_id:user.id,p_request_id:requestId,p_decision:decision,p_role:role,p_supervisor_id:supervisorId
          });
          break;
        }
        case 'adminAssignAccount': {
          const {accountId,role,supervisorId,expectedRole,expectedSupervisorId} = body;
          if (!isUuid(accountId)) throw VALIDATION('Choose an account to update.');
          validateAssignment(role,supervisorId);
          validateAssignment(expectedRole,expectedSupervisorId);
          result = await db.rpc('workspace_admin_assign_account',{
            p_user_id:user.id,p_account_id:accountId,p_role:role,p_supervisor_id:supervisorId,
            p_expected_role:expectedRole,p_expected_supervisor_id:expectedSupervisorId
          });
          break;
        }
        case 'tally': {
          const {day, delta, requestId} = validateTallyUpdate(body.day,body.delta,body.requestId);
          result = safeResult(await db.rpc('workspace_tally',{
            p_user_id:user.id,p_day:day,p_delta:delta,p_request_id:requestId
          }),validateDayTotals);
          if (result.day !== day) throw new ApiError(503,'STORAGE','Could not confirm the saved day.');
          break;
        }
        case 'editDay': {
          const expected = validateDayTotals(body.expected), replacement = validateDayTotals(body.replacement);
          if (expected.day !== replacement.day) throw VALIDATION('Choose the same report date.');
          result = safeResult(await db.rpc('workspace_edit_day',{p_user_id:user.id,p_expected:expected,p_replacement:replacement}),validateDayTotals);
          if (result.day !== expected.day) throw new ApiError(503,'STORAGE','Could not confirm the edited day.');
          break;
        }
        case 'goal':
          throw new ApiError(403,'FORBIDDEN','A supervisor sets goals for the team.');
        case 'agentState':
          if (!isUuid(body.agentId)) throw VALIDATION('Choose an agent.');
          result = safeResult(await db.rpc('workspace_agent_state',{p_user_id:user.id,p_agent_id:body.agentId}),validateTallyState);
          break;
        case 'teamGoals': {
          const {agentIds,goals} = body;
          if (agentIds !== null && (!Array.isArray(agentIds) || !agentIds.length || !agentIds.every(isUuid))) throw VALIDATION('Choose the team or selected agents.');
          if (!goals || typeof goals !== 'object' || Array.isArray(goals) || !Object.keys(goals).length ||
              Object.entries(goals).some(([key,v]) => !Object.hasOwn(DEFAULT_GOALS,key) || !Number.isInteger(v) || v<5 || v>100)) {
            throw VALIDATION('Choose a goal and a whole percentage from 5 to 100.');
          }
          result = await db.rpc('workspace_team_goals',{p_user_id:user.id,p_agent_ids:agentIds,p_goals:goals});
          break;
        }
        case 'gameSchedule': {
          const {action:unused,...game} = body;
          result = await db.rpc('workspace_launch_game',{p_user_id:user.id,p_game:game});
          break;
        }
        default: throw VALIDATION('Choose a supported action.');
      }
      if (['adminCreateAccount','adminReviewSignup','adminAssignAccount'].includes(body.action)) {
        if (result?.ok !== true) throw new ApiError(503,'STORAGE','Could not confirm the account change. Refresh Accounts to check its status.');
        return send(200,{ok:true});
      }
      return send(200,result);
    } catch(error) {
      const problem = error instanceof ApiError ? error : error instanceof StorageError ? new ApiError(error.code === 'CONFLICT' || error.code === 'DUPLICATE' ? 409 : 400,error.code,error.message) : new ApiError(503,'STORAGE','The server could not confirm this operation. Try the same operation again.');
      if (problem.status === 429) res.setHeader('Retry-After','900');
      return send(problem.status,{error:{code:problem.code,message:problem.message}});
    }
  };
}
