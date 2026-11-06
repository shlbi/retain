import { StorageError, validateCall, validateGoals, validateBackup, MAX_BACKUP_CALLS } from './validation.js';
export { parseBackup, MAX_BACKUP_BYTES, MAX_BACKUP_CALLS, validDay } from './validation.js';

/** Call only our same-origin server. Authentication lives in an HttpOnly cookie. */
export async function apiRequest(action, data, userId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const headers = { Accept:'application/json' };
  if (userId) headers['X-Workspace-User'] = userId;
  const method = data === undefined ? 'GET' : 'POST';
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch('/api/workspace' + (method === 'GET' && action ? '?action='+encodeURIComponent(action) : ''), {
      method, headers, credentials:'same-origin', cache:'no-store', signal:controller.signal,
      ...(method === 'POST' ? {body:JSON.stringify({action,...data})} : {})
    });
    let result;
    try { result = await response.json(); } catch { throw new StorageError('NETWORK','The server returned an unexpected response. Reload and try again.'); }
    if (!response.ok) {
      const error = new StorageError(result.error?.code || 'NETWORK', result.error?.message || 'The request could not be completed.');
      if (response.status === 401 && userId && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('session-expired',{detail:{userId}}));
      throw error;
    }
    return result;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('NETWORK', method==='POST' ? 'Could not confirm the change. Check your connection and refresh saved records before retrying. Your entry is still here.' : 'Could not load your records. Check your connection and try again.');
  } finally { clearTimeout(timer); }
}

/** Bind every operation to the signed-in account to reject stale tabs after an account switch. */
export function createRepository(userId, request = apiRequest) {
  if (typeof userId !== 'string' || !userId.trim()) throw new StorageError('AUTH','Sign in to open your records.');
  let closed = false;
  const call = (action, data) => {
    if (closed) return Promise.reject(new StorageError('AUTH','Sign in to open your records.'));
    return request(action, data, userId);
  };
  return {
    async read() {
      const result = await call('state');
      if (!result || result.version !== 3) throw new StorageError('STORAGE','The saved records could not be read safely.');
      return validateBackup(result);
    },
    async saveCall(record, expectedRevision = null) { return validateCall(await call('save',{call:validateCall(record),expectedRevision})); },
    async removeCall(id, expectedRevision) { return validateCall(await call('remove',{id,expectedRevision})); },
    async restoreCall(record) { return validateCall(await call('restore',{call:validateCall(record)})); },
    setGoal(key,value) { return call('goal',{key,value}); },
    importBackup(backup) { return call('import',{backup:validateBackup(backup)}); },
    close() { closed = true; }
  };
}
export async function openStore(userId) { return createRepository(userId); }
