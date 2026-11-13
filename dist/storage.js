import { StorageError } from './validation.js';
import { validateDayTotals, validateTallyState, validateTallyUpdate } from './tally-validation.js';
export { validDay } from './validation.js';

/** Call only our same-origin server. Authentication lives in an HttpOnly cookie. */
export async function apiRequest(action, data, userId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const headers = { Accept:'application/json' };
  if (userId) headers['X-Workspace-User'] = userId;
  const method = data === undefined ? 'GET' : 'POST';
  const uncertain = action === 'tally' ? 'The save could not be confirmed. Use Retry save to check it without counting twice.'
    : 'Could not confirm the change. Check your connection and try again.';
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch('/api/workspace' + (method === 'GET' && action ? '?action='+encodeURIComponent(action) : ''), {
      method, headers, credentials:'same-origin', cache:'no-store', signal:controller.signal,
      ...(method === 'POST' ? {body:JSON.stringify({action,...data})} : {})
    });
    let result;
    try { result = await response.json(); } catch { throw new StorageError('NETWORK',method === 'POST' ? uncertain : 'The server returned an unexpected response. Try again.'); }
    if (!response.ok) {
      const error = new StorageError(result.error?.code || 'NETWORK', result.error?.message || 'The request could not be completed.');
      if (response.status === 401 && userId && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('session-expired',{detail:{userId}}));
      throw error;
    }
    return result;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('NETWORK', method==='POST' ? uncertain : 'Could not load your records. Check your connection and try again.');
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
      return validateTallyState(result);
    },
    async tally(day, delta, requestId) {
      const update = validateTallyUpdate(day,delta,requestId);
      const response = await call('tally',update);
      try {
        const result = validateDayTotals(response);
        if (result.day === day) return result;
      } catch { /* The write may have committed before the response was damaged. */ }
      throw new StorageError('STORAGE','Could not confirm the saved day. Use Retry save.');
    },
    setGoal(key,value) { return call('goal',{key,value}); },
    close() { closed = true; }
  };
}
export async function openStore(userId) { return createRepository(userId); }
