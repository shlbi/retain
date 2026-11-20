import { DEFAULT_GOALS } from '../dist/model.js';
import { StorageError } from '../dist/validation.js';
import { validateDayTotals, validateTallyState, validateTallyUpdate } from '../dist/tally-validation.js';
import { credentials, existingUsername, hashPassword, needsPasswordUpgrade, verifyPassword, tokenHash, newPasswordChangeCode, newSession, sessionToken, sessionCookie, SESSION_SECONDS } from './auth.js';
import { gameConnection } from './game-connection.js';
import { ApiError, createDatabase, invalidReset } from './database.js';

const ACTION_FIELDS = {signup:['username','password','requestedRole'],login:['username','password'],logout:[],tally:['day','delta','requestId'],goal:['key','value'],editDay:['expected','replacement'],
  adminCreateAccount:['username','password','role','supervisorId'],adminReviewSignup:['requestId','decision','role','supervisorId'],
  adminAssignAccount:['accountId','role','supervisorId','expectedRole','expectedSupervisorId'],
  adminSaveTeam:['supervisorId','name','expectedName'],adminAddTeamMembers:['supervisorId','members'],
  adminSaveTeamDetails:['originalSupervisorId','supervisorId','name','expectedName','expectedMemberIds','members'],
  adminDeleteTeam:['supervisorId','expectedTeamId','expectedName','expectedMemberIds'],
  adminDeleteAccount:['accountId','expectedUsername','expectedRole','expectedSupervisorId','expectedTeamId','expectedTeamName','expectedMemberIds'],
  requestPasswordChange:['username'],completePasswordChange:['username','code','password'],adminReviewPasswordChange:['requestId','decision'],
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
  if (typeof input.action !== 'string' || !Object.hasOwn(ACTION_FIELDS,input.action)) throw VALIDATION('Choose a supported action.');
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

async function authenticatedAccount(db, account) {
  const lookup = () => db.rpc('auth_get_user',{p_username_key:account.username});
  const authenticate = async stored => {
    const matches = await verifyPassword(account.password,stored?.password_hash);
    if (!matches || !publicUser(stored)) throw new ApiError(401,'AUTH','Username or password is incorrect.');
    if (!['pending','active'].includes(stored.status)) throw new ApiError(503,'STORAGE','Your account could not be opened. Try signing in again.');
    return stored;
  };
  const stored = await authenticate(await lookup());
  if (!needsPasswordUpgrade(stored.password_hash)) return stored;

  // Rehashing is opportunistic. The existing verified credential continues to work
  // if the migration has not finished rolling out or the server is at KDF capacity.
  let upgraded, newHash;
  try {
    newHash = await hashPassword(account.password);
    upgraded = await db.rpc('auth_upgrade_password_hash',{
      p_identity_id:stored.id,p_status:stored.status,p_expected_hash:stored.password_hash,
      p_new_hash:newHash
    });
  } catch (error) {
    if (!(error instanceof ApiError) || !['STORAGE','AUTH_BUSY'].includes(error.code)) throw error;
    return stored;
  }
  // A concurrent login, approval or denial may have changed this identity.
  if (upgraded !== true) return authenticate(await lookup());
  return {...stored,password_hash:newHash};
}

async function createVerifiedSession(db, stored, tokenDigest, expiresAt) {
  const session = {p_user_id:stored.id,p_token_hash:tokenDigest,p_expires_at:expiresAt};
  let issued;
  try {
    issued = await db.rpc('auth_create_verified_session',{...session,p_expected_hash:stored.password_hash});
  } catch (error) {
    // During rollout, only an explicitly missing RPC identifies the pre-reset schema.
    // The reset migration retires the legacy function in the same transaction.
    if (!(error instanceof ApiError) || error.code !== 'VERIFIED_SESSION_UNAVAILABLE') throw error;
    issued = (await db.rpc('auth_create_session',session))?.ok;
  }
  if (issued === false) throw new ApiError(401,'AUTH','Username or password is incorrect.');
  if (issued !== true) throw new ApiError(503,'STORAGE','Could not confirm sign-in. Try again.');
}
function validateAssignment(role, supervisorId, roles = accountRoles) {
  if (!roles.includes(role)) throw VALIDATION('Choose a valid account role.');
  if (supervisorId !== null && (!isUuid(supervisorId) || role === 'supervisor')) throw VALIDATION('Choose a valid supervisor for this account.');
}
function teamName(value) {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) throw VALIDATION('Use a team name without control characters.');
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > 60) throw VALIDATION('Team names must contain 1–60 characters.');
  return trimmed;
}
/** Bind each transfer to the membership the admin saw when selecting the roster. */
function validateMemberChanges(members, supervisorId) {
  if (!Array.isArray(members)) throw VALIDATION('Include the list of selected agents.');
  const seen = new Set();
  for (const member of members) {
    if (!member || typeof member !== 'object' || Array.isArray(member) ||
        Object.keys(member).some(key => !['id','expectedSupervisorId'].includes(key)) ||
        !isUuid(member.id) || (member.expectedSupervisorId !== null && !isUuid(member.expectedSupervisorId))) {
      throw VALIDATION('Each selected agent must include their current supervisor assignment.');
    }
    const id = member.id.toLowerCase();
    if (id === supervisorId.toLowerCase() || seen.has(id)) throw VALIDATION('Choose each agent once and exclude the team supervisor.');
    seen.add(id);
  }
}
/** An edit includes the original team and roster so stale saves can be rejected atomically. */
function validatePriorTeam(originalSupervisorId, expectedName, expectedMemberIds) {
  if (!Array.isArray(expectedMemberIds) || !expectedMemberIds.every(isUuid) ||
      new Set(expectedMemberIds.map(id => id.toLowerCase())).size !== expectedMemberIds.length) {
    throw VALIDATION('Include each original team member once.');
  }
  if (originalSupervisorId === null) {
    if (expectedName !== null || expectedMemberIds.length) throw VALIDATION('A new team must start with an empty original roster and no original name.');
  } else {
    if (!isUuid(originalSupervisorId)) throw VALIDATION('Choose a current team to edit.');
    teamName(expectedName);
    if (expectedMemberIds.some(id => id.toLowerCase() === originalSupervisorId.toLowerCase())) {
      throw VALIDATION('The original roster must exclude its supervisor.');
    }
  }
}
/** A management session may see tracker identities and assignments, never credential records. */
function accountDirectory(value) {
  return {
    pending:value.pending.map(({id,username,requestedRole,requestedAt}) => ({id,username,requestedRole,requestedAt})),
    passwordChanges:(value.passwordChanges ?? []).map(({id,username,requestedAt}) => ({id,username,requestedAt})),
    accounts:value.accounts.map(({id,username,role,supervisorId,ownedTeamId,ownedTeamName}) => ({id,username,role,supervisorId,ownedTeamId,ownedTeamName})),
    // Accounts remain usable on the previous schema. Teams needs to distinguish
    // an unavailable directory from a successfully loaded, empty roster.
    teams:Array.isArray(value.teams) ? value.teams.map(({id,supervisorId,name}) => ({id,supervisorId,name})) : null
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
      if (req.method === 'POST' && body.action === 'requestPasswordChange') {
        let username;
        try { username = existingUsername(body.username); } catch (error) { throw VALIDATION(error.message); }
        await authRateLimit(db,req,env,body.action,username);
        const result = await db.rpc('auth_request_password_change',{p_username:username});
        if (result?.ok !== true) throw new ApiError(503,'STORAGE','Could not confirm the password change request. Try again.');
        return send(200,{ok:true});
      }
      if (req.method === 'POST' && body.action === 'completePasswordChange') {
        const {username,password} = validatedCredentials(body,body.action);
        await authRateLimit(db,req,env,body.action,username);
        const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
        if (!/^[0-9a-f]{32}$/.test(code)) throw invalidReset();
        const result = await db.rpc('auth_complete_password_change',{
          p_username:username,p_token_hash:tokenHash(code),p_password_hash:await hashPassword(password)
        });
        if (result?.ok !== true) throw new ApiError(503,'STORAGE','Could not confirm the password change. Try signing in again.');
        return send(200,{ok:true});
      }
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
        const stored = await authenticatedAccount(db,account);
        const user = publicUser(stored);
        if (stored.status === 'pending') throw new ApiError(403,'PENDING_APPROVAL','Your request is waiting for admin approval.');
        const session = newSession(), now = clock();
        // The database checks the verified hash under a row lock before issuing the session.
        await createVerifiedSession(db,stored,session.hash,new Date(now + SESSION_SECONDS * 1000).toISOString());
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
        case 'adminReviewPasswordChange': {
          const {requestId,decision} = body;
          if (!isUuid(requestId) || !['approve','deny'].includes(decision)) throw VALIDATION('Choose a pending password change and a decision.');
          const code = decision === 'approve' ? newPasswordChangeCode() : null;
          const reviewed = await db.rpc('workspace_admin_review_password_change',{
            p_user_id:user.id,p_request_id:requestId,p_decision:decision,p_token_hash:code && tokenHash(code)
          });
          if (reviewed?.ok !== true) throw new ApiError(503,'STORAGE','Could not confirm this review. Refresh the request list.');
          return send(200,code ? {ok:true,code} : {ok:true});
        }
        case 'adminSaveTeam': {
          const {supervisorId,name,expectedName} = body;
          if (!isUuid(supervisorId)) throw VALIDATION('Choose the team supervisor.');
          if (expectedName !== null) teamName(expectedName);
          result = await db.rpc('workspace_admin_save_team',{
            p_user_id:user.id,p_supervisor_id:supervisorId,p_name:teamName(name),p_expected_name:expectedName
          });
          break;
        }
        case 'adminAddTeamMembers': {
          const {supervisorId,members} = body;
          if (!isUuid(supervisorId)) throw VALIDATION('Choose a team to receive the agents.');
          validateMemberChanges(members,supervisorId);
          if (!members.length) throw VALIDATION('Choose at least one agent to assign.');
          result = await db.rpc('workspace_admin_add_team_members',{p_user_id:user.id,p_supervisor_id:supervisorId,p_members:members});
          break;
        }
        case 'adminSaveTeamDetails': {
          const {originalSupervisorId,supervisorId,name,expectedName,expectedMemberIds,members} = body;
          if (!isUuid(supervisorId)) throw VALIDATION('Choose the team supervisor.');
          validatePriorTeam(originalSupervisorId,expectedName,expectedMemberIds);
          validateMemberChanges(members,supervisorId);
          result = await db.rpc('workspace_admin_save_team_details',{
            p_user_id:user.id,p_original_supervisor_id:originalSupervisorId,p_supervisor_id:supervisorId,
            p_name:teamName(name),p_expected_name:expectedName,p_expected_member_ids:expectedMemberIds,p_members:members
          });
          break;
        }
        case 'adminDeleteTeam': {
          const {supervisorId,expectedTeamId,expectedName,expectedMemberIds} = body;
          if (!isUuid(supervisorId) || !isUuid(expectedTeamId)) throw VALIDATION('Choose a current team to delete.');
          validatePriorTeam(supervisorId,expectedName,expectedMemberIds);
          result = await db.rpc('workspace_admin_delete_team',{
            p_user_id:user.id,p_supervisor_id:supervisorId,p_expected_team_id:expectedTeamId,
            p_expected_name:expectedName,p_expected_member_ids:expectedMemberIds
          });
          break;
        }
        case 'adminDeleteAccount': {
          const {accountId,expectedUsername,expectedRole,expectedSupervisorId,expectedTeamId,expectedTeamName,expectedMemberIds} = body;
          if (!isUuid(accountId)) throw VALIDATION('Choose a current account to delete.');
          if (user.id.toLowerCase() === accountId.toLowerCase() || expectedRole === 'admin') {
            throw new ApiError(403,'FORBIDDEN','Only agent and supervisor accounts can be deleted.');
          }
          validateAssignment(expectedRole,expectedSupervisorId,signupRoles);
          if (expectedTeamName === null ? expectedTeamId !== null : !isUuid(expectedTeamId)) {
            throw VALIDATION('Include the current team identity for this account.');
          }
          validatePriorTeam(expectedTeamName === null ? null : accountId,expectedTeamName,expectedMemberIds);
          // Use the account's exact stored name, including names created under the older 64-character limit.
          if (typeof expectedUsername !== 'string' || !expectedUsername.trim() ||
              expectedUsername.length > 128 || [...expectedUsername].length > 64) {
            throw VALIDATION('Include the current username for this account.');
          }
          result = await db.rpc('workspace_admin_delete_account',{
            p_user_id:user.id,p_account_id:accountId,p_expected_username:expectedUsername,
            p_expected_role:expectedRole,p_expected_supervisor_id:expectedSupervisorId,
            p_expected_team_id:expectedTeamId,p_expected_team_name:expectedTeamName,p_expected_member_ids:expectedMemberIds
          });
          break;
        }
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
      if (['adminCreateAccount','adminReviewSignup','adminAssignAccount','adminSaveTeam','adminAddTeamMembers',
        'adminSaveTeamDetails','adminDeleteTeam','adminDeleteAccount'].includes(body.action)) {
        if (result?.ok !== true) throw new ApiError(503,'STORAGE','Could not confirm this change. Refresh the directory to check its status.');
        return send(200,{ok:true});
      }
      return send(200,result);
    } catch(error) {
      const problem = error instanceof ApiError ? error : error instanceof StorageError ? new ApiError(error.code === 'CONFLICT' || error.code === 'DUPLICATE' ? 409 : 400,error.code,error.message) : new ApiError(503,'STORAGE','The server could not confirm this operation. Try the same operation again.');
      if (problem.status === 429) res.setHeader('Retry-After','900');
      if (problem.code === 'AUTH_BUSY') res.setHeader('Retry-After','2');
      return send(problem.status,{error:{code:problem.code,message:problem.message}});
    }
  };
}
