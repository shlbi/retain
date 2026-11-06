/** API-safe failures never include raw database messages, credentials, or request bodies. */
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}

/** Map only explicit domain error categories; hide Postgres diagnostics from clients. */
export function databaseError(error) {
  const category = typeof error?.message === 'string' ? error.message.split(':',1)[0] : '';
  if (category === 'DUPLICATE' || error?.code === '23505') return new ApiError(409,'DUPLICATE','That username, call ID, or UCID already exists.');
  if (category === 'CONFLICT') return new ApiError(409,'CONFLICT','These records changed or conflict with existing records. Reload the latest records before trying again. No conflicting changes were applied.');
  if (category === 'LIMIT') return new ApiError(400,'VALIDATION','This workspace has reached its storage capacity. Export a backup before removing older records.');
  if (category === 'VALIDATION') return new ApiError(400,'VALIDATION','The supplied record or target is invalid, or the workspace storage limit would be exceeded. No changes were applied.');
  return new ApiError(503,'STORAGE','Cloud storage could not confirm this operation. Reload your saved records before retrying.');
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
    async rpc(name, args = {}) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new ApiError(503,'STORAGE','Invalid server database operation.');
      let response, data;
      try {
        response = await fetchImpl(new URL(`/rest/v1/rpc/${name}`,base), {method:'POST',headers,body:JSON.stringify(args),signal:AbortSignal.timeout(15000),cache:'no-store'});
        data = await response.json();
      } catch { throw new ApiError(503,'STORAGE','Cloud storage could not confirm this operation. Reload your saved records before retrying.'); }
      if (!response.ok) throw databaseError(data);
      return data;
    }
  };
}
