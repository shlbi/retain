/** API-safe failures never include raw database messages, credentials, or request bodies. */
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}

/** Map only explicit domain error categories; hide Postgres diagnostics from clients. */
export function databaseError(error, rpcName) {
  const category = typeof error?.message === 'string' ? error.message.split(':',1)[0] : '';
  if (rpcName === 'workspace_admin_delete_team' || rpcName === 'workspace_admin_delete_account') {
    const subject = rpcName === 'workspace_admin_delete_team' ? 'team' : 'account';
    if (error?.code === 'PGRST202') return new ApiError(503,'SETUP','Apply the account and team deletion database update in Supabase, then refresh the admin page.');
    if (category === 'CONFLICT') return new ApiError(409,'CONFLICT',`The ${subject} or its assignments changed. Refresh the directory and review the details before deleting.`);
    if (category === 'FORBIDDEN') return new ApiError(403,'FORBIDDEN',subject === 'team'
      ? 'Only admins can delete teams.' : 'Only admins can delete other agent or supervisor accounts.');
    if (category === 'VALIDATION') return new ApiError(400,'VALIDATION',`Refresh the directory and select the ${subject} again.`);
    return new ApiError(503,'STORAGE',`Storage could not confirm the ${subject} deletion. Refresh the directory to check its status before trying again.`);
  }
  if (rpcName === 'workspace_admin_save_team_details') {
    if (error?.code === 'PGRST202') return new ApiError(503,'SETUP','Team editing needs the latest Teams database update. Apply it in Supabase, then reopen Teams.');
    if (category === 'TEAM_NAME_TAKEN') return new ApiError(409,'TEAM_NAME_TAKEN','That team name is already in use. Choose a different name.');
    if (category === 'SUPERVISOR_TAKEN') return new ApiError(409,'SUPERVISOR_TAKEN','That supervisor already leads a team. Choose an available supervisor.');
    if (category === 'CONFLICT' || error?.code === '23505') return new ApiError(409,'CONFLICT','Another change affected this team or its agents. Refresh Teams and review the current assignments before saving again.');
    if (category === 'INVALID_TEAM') return new ApiError(400,'INVALID_TEAM','Check the team name, supervisor, and agent selections before saving.');
  }
  if (error?.code === 'PGRST202' && ['workspace_admin_save_team','workspace_admin_add_team_members'].includes(rpcName)) {
    return new ApiError(503,'SETUP','Team management needs the named teams database update. Apply it in Supabase, then refresh Teams.');
  }
  if (category === 'CONFLICT' && rpcName === 'workspace_admin_save_team') {
    return new ApiError(409,'CONFLICT','This team name or supervisor is already in use, or the team was edited. Refresh Teams to see its current details.');
  }
  if (category === 'DUPLICATE' || error?.code === '23505') return new ApiError(409,'DUPLICATE','That username already exists.');
  if (category === 'CONFLICT') return new ApiError(409,'CONFLICT','These records changed or conflict with existing records. Reload the latest records before trying again. No conflicting changes were applied.');
  if (category === 'FORBIDDEN') return new ApiError(403,'FORBIDDEN','Your role or team assignment does not allow this action.');
  if (category === 'SELF_ROLE') return new ApiError(403,'SELF_ROLE','You can change your team. Another admin must change your role.');
  if (category === 'TEAM_IN_USE') return new ApiError(409,'TEAM_IN_USE','Reassign this supervisor’s team members before changing their role.');
  if (category === 'TEAM_REQUIRED') return new ApiError(403,'TEAM_REQUIRED','Ask an admin to create your team before scheduling a game.');
  if (category === 'INVALID_TEAM') return new ApiError(400,'INVALID_TEAM','Choose a current supervisor or leave the account unassigned.');
  if (category === 'LIMIT') return new ApiError(400,'VALIDATION','This workspace has reached its storage capacity.');
  if (category === 'VALIDATION') return new ApiError(400,'VALIDATION','The supplied record or target is invalid, or the workspace storage limit would be exceeded. No changes were applied.');
  return new ApiError(503,'STORAGE','Cloud storage could not confirm this operation. Try the same operation again.');
}

/** Use Supabase's server-only REST RPC interface with no browser SDK or dependencies. */
export function createDatabase(env = process.env, fetchImpl = globalThis.fetch) {
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  let base;
  try {
    base = new URL(env.SUPABASE_URL);
    const local = ['localhost','127.0.0.1','[::1]'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(local && base.protocol === 'http:')) || base.username || base.password || base.search || base.hash || !['','/'].includes(base.pathname) || !key) throw new Error();
  } catch { throw new ApiError(503,'SETUP','Cloud storage is not configured. Set the server Supabase URL and secret key, then apply the database migration.'); }
  const headers = {'Content-Type':'application/json', apikey:key};
  // New sb_secret keys are opaque API keys, not JWT bearer tokens.
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return {
    async rpc(name, args = {}, timeoutMs = 15000) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new ApiError(503,'STORAGE','Invalid server database operation.');
      let response, data;
      try {
        response = await fetchImpl(new URL(`/rest/v1/rpc/${name}`,base), {method:'POST',headers,body:JSON.stringify(args),signal:AbortSignal.timeout(timeoutMs),cache:'no-store'});
        data = await response.json();
      } catch { throw databaseError(null,name); }
      if (!response.ok) throw databaseError(data,name);
      return data;
    }
  };
}
