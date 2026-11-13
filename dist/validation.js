import { DEFAULT_GOALS, SERVICES } from './model.js';

export const SCHEMA_VERSION = 3;
export const MAX_BACKUP_BYTES = 3 * 1024 * 1024;
export const MAX_BACKUP_CALLS = 10000;
export const MAX_MOBILE_ORDERS = 20;
export const MAX_LINES_PER_ORDER = 12;
const SERVICE_KEYS = SERVICES.map(service => service.key);
const ACCOUNT_FIELDS = ['account', 'before', 'kept', 'added'];
const RECORD_FIELDS = ['id','day','time','order','ucid','account','before','kept','accounts','callback','mobileOrders','sold','soldLines','revision'];
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;

/** Carry stable validation categories with messages suitable for the call form or import UI. */
export class StorageError extends Error {
  /** Attach a machine-readable category while preserving the normal Error interface. */
  constructor(code, message) { super(message); this.name = 'StorageError'; this.code = code; }
}

/** Reject arrays, nulls, and objects with unexpected prototypes. */
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new StorageError('VALIDATION', `${label} must be an object.`);
}

/** Reject unknown properties rather than silently dropping unsupported backup information. */
function fields(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new StorageError('VALIDATION', `${label} contains an unsupported field: ${key}.`);
}

/** Preserve identifiers as text, including leading zeroes, and normalize optional blanks. */
function identifier(value, label, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') throw new StorageError('VALIDATION', `${label} must be text.`);
  const result = value.trim();
  if ((!optional && !result) || result.length > 100 || /[\p{C}]/u.test(result)) throw new StorageError('VALIDATION', `${label} must contain ${optional?'0':'1'}–100 visible characters.`);
  return result;
}

/** Reject impossible calendar dates, including leap-year and end-of-month rollovers. */
export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
}

/** Normalize explicit orders or a legacy single-order count without inventing order splits. */
function mobileOrders(value, allowLegacy) {
  if (value.sold !== undefined && typeof value.sold !== 'boolean') throw new StorageError('VALIDATION', 'Mobile sold must be true or false when supplied.');
  if (value.soldLines !== undefined && (!Number.isInteger(value.soldLines) || value.soldLines < 0)) throw new StorageError('VALIDATION', 'Mobile line count must be a nonnegative integer.');
  let orders;
  if (value.mobileOrders === undefined) {
    if (!allowLegacy) throw new StorageError('VALIDATION', 'Version 3 calls must include a mobileOrders array.');
    const legacyLines = value.soldLines ?? Number(value.sold === true);
    if (legacyLines > MAX_LINES_PER_ORDER) throw new StorageError('VALIDATION', 'This legacy call has more than 12 mobile lines. Split it into orders of at most 12 lines before importing; order counts cannot be inferred.');
    orders = legacyLines ? [legacyLines] : [];
  } else {
    if (!Array.isArray(value.mobileOrders) || value.mobileOrders.length > MAX_MOBILE_ORDERS || Array.from(value.mobileOrders).some(lines => !Number.isInteger(lines) || lines < 1 || lines > MAX_LINES_PER_ORDER)) throw new StorageError('VALIDATION', 'A call may contain up to 20 mobile orders, each with 1–12 lines.');
    orders = [...value.mobileOrders];
  }
  const soldLines = orders.reduce((sum, lines) => sum + lines, 0);
  const sold = orders.length > 0;
  if ((value.sold !== undefined && value.sold !== sold) || (value.soldLines !== undefined && value.soldLines !== soldLines)) throw new StorageError('VALIDATION', 'Mobile sold and line totals must agree with the mobile orders.');
  return {mobileOrders:orders, sold, soldLines};
}

function validTimestamp(value) {
  return typeof value === 'string' && UTC_TIMESTAMP.test(value)
    && validDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

function serviceList(value, allowed, message, required = false) {
  if (!Array.isArray(value) || (required && value.length === 0)
    || value.length > allowed.length || new Set(value).size !== value.length
    || Array.from(value).some(key => !allowed.includes(key))) {
    throw new StorageError('VALIDATION', message);
  }
  return SERVICE_KEYS.filter(key => value.includes(key));
}

function validateAccount(value) {
  object(value, 'Account');
  fields(value, ACCOUNT_FIELDS, 'Account');
  const account = identifier(value.account, 'Account number', true);
  const before = serviceList(value.before, SERVICE_KEYS, 'Choose 1–4 distinct starting services.', true);
  const kept = serviceList(value.kept, before, 'Kept services must be distinct services the account started with.');
  const available = SERVICE_KEYS.filter(key => !before.includes(key));
  const added = serviceList(value.added === undefined ? [] : value.added, available,
    'Added services must be distinct services the account did not start with.');
  return {account, before, kept, added};
}

function callAccounts(value) {
  if (value.accounts === undefined) {
    const {account, before, kept} = validateAccount({
      account: value.account, before: value.before, kept: value.kept
    });
    return {account, before, kept};
  }
  if (!Array.isArray(value.accounts) || !value.accounts.length) {
    throw new StorageError('VALIDATION', 'A call must include at least one account.');
  }
  const accounts = Array.from(value.accounts, validateAccount);
  const {account, before, kept} = accounts[0];
  // Older clients use these three aliases. Reject inconsistent backup data.
  const aliases = validateAccount({
    account: value.account === undefined ? account : value.account,
    before: value.before === undefined ? before : value.before,
    kept: value.kept === undefined ? kept : value.kept
  });
  if (aliases.account !== account || aliases.before.join() !== before.join()
    || aliases.kept.join() !== kept.join()) {
    throw new StorageError('VALIDATION', 'Call account number and services must match the first account.');
  }
  return {account, before, kept, accounts};
}

function validateCallback(value) {
  if (value === null) return null;
  object(value, 'Callback');
  fields(value, ['dueAt', 'note', 'status', 'approved'], 'Callback');
  if (value.approved !== true) {
    throw new StorageError('VALIDATION', 'Confirm supervisor approval before scheduling a callback.');
  }
  if (!validTimestamp(value.dueAt)) {
    throw new StorageError('VALIDATION', 'Choose a valid callback date and time.');
  }
  if (!['scheduled', 'done'].includes(value.status)) {
    throw new StorageError('VALIDATION', 'Choose a valid callback status.');
  }
  if (typeof value.note !== 'string' || value.note.length > 4000 || Array.from(value.note).length > 2000
    || /[\u0000\p{Cs}]/u.test(value.note)) {
    throw new StorageError('VALIDATION', 'Callback notes must be text up to 2,000 characters.');
  }
  return {
    dueAt: new Date(value.dueAt).toISOString(),
    note: value.note,
    status: value.status,
    approved: true
  };
}

/** Validate a call and derive canonical sales fields before persistence or metric calculation. */
export function validateCall(value, {allowLegacy = true} = {}) {
  object(value, 'Call'); fields(value, RECORD_FIELDS, 'Call');
  const id = identifier(value.id, 'Call record ID');
  const ucid = identifier(value.ucid, 'UCID', true);
  const accounts = callAccounts(value);
  if (!validDay(value.day)) throw new StorageError('VALIDATION', 'Call date must be a valid YYYY-MM-DD date.');
  if (typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new StorageError('VALIDATION', 'Call time must be a valid 24-hour HH:mm time.');
  if (!Number.isFinite(value.order) || value.order < 0) throw new StorageError('VALIDATION', 'Call sorting time must be a nonnegative finite number.');
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 1)) throw new StorageError('VALIDATION', 'Call revision must be a positive integer.');
  const sales = mobileOrders(value, allowLegacy);
  const call = {id, day: value.day, time: value.time, order: value.order, ucid, ...accounts, ...sales, revision: value.revision ?? 1};
  if (value.callback !== undefined) call.callback = validateCallback(value.callback);
  return call;
}

/** Existing backups can predate the bundle goal. Version 2 also predates the orders goal. */
export function validateGoals(value, version = SCHEMA_VERSION) {
  object(value, 'Goals'); fields(value, Object.keys(DEFAULT_GOALS), 'Goals');
  if (![2,SCHEMA_VERSION].includes(version)) throw new StorageError('VALIDATION', 'Unsupported goals schema version.');
  const goals = {};
  for (const key of Object.keys(DEFAULT_GOALS)) {
    const introducedLater = key === 'bundle' || (version === 2 && key === 'orders');
    const candidate = introducedLater && value[key] === undefined ? DEFAULT_GOALS[key] : value[key];
    if (!Number.isInteger(candidate) || candidate < 5 || candidate > 100) throw new StorageError('VALIDATION', `The ${key} goal must be a whole percentage from 5 to 100.`);
    goals[key] = candidate;
  }
  return goals;
}

/** Enforce record-ID uniqueness and nonempty UCID uniqueness without treating blanks as an identity. */
function uniqueCalls(calls) {
  const ids = new Set(), ucids = new Set();
  for (const call of calls) {
    const ucid = call.ucid.toLowerCase();
    if (ids.has(call.id) || (ucid && ucids.has(ucid))) throw new StorageError('VALIDATION', 'This backup contains duplicate call IDs or nonempty UCIDs. Nothing was imported.');
    ids.add(call.id); if (ucid) ucids.add(ucid);
  }
}

/** Validate the entire portable backup and upgrade unambiguous version-2 data to version 3. */
export function validateBackup(value) {
  object(value, 'Backup'); fields(value, ['version','calls','goals','exportedAt'], 'Backup');
  if (![2,SCHEMA_VERSION].includes(value.version)) throw new StorageError('VALIDATION', 'Choose a version 2 or version 3 call-tracker backup.');
  if (!Array.isArray(value.calls) || value.calls.length > MAX_BACKUP_CALLS) throw new StorageError('VALIDATION', `A backup must contain at most ${MAX_BACKUP_CALLS.toLocaleString('en-US')} calls.`);
  if (value.exportedAt !== undefined && !validTimestamp(value.exportedAt)) throw new StorageError('VALIDATION', 'The backup export timestamp is invalid.');
  const calls = value.calls.map(call=>validateCall(call,{allowLegacy:value.version===2}));
  uniqueCalls(calls);
  const result = {version:SCHEMA_VERSION,calls,goals:validateGoals(value.goals,value.version)};
  if (value.exportedAt !== undefined) result.exportedAt = value.exportedAt;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BACKUP_BYTES) throw new StorageError('VALIDATION', 'The backup exceeds the 3 MiB import limit.');
  return result;
}

/** Check upload size before parsing and report malformed JSON without exposing customer data. */
export function parseBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new StorageError('VALIDATION', 'Choose a JSON backup no larger than 3 MiB.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new StorageError('VALIDATION', 'This file is not valid JSON. Nothing was imported.'); }
  return validateBackup(parsed);
}

/** Compare canonical records while ignoring concurrency revisions and UCID letter case. */
function comparableCall(call) {
  const {revision, accounts, callback, ...core} = call;
  core.ucid = core.ucid.toLowerCase();
  if (accounts && (accounts.length !== 1 || accounts[0].added.length)) core.accounts = accounts;
  if (callback) core.callback = callback;
  return JSON.stringify(core);
}

function sameCall(a, b) {
  return comparableCall(a) === comparableCall(b);
}

/** Produce a conflict-free import plan without mutating existing data or deduplicating blank UCIDs. */
export function planImport(existingCalls, incomingCalls) {
  if (!Array.isArray(existingCalls) || !Array.isArray(incomingCalls)) throw new StorageError('VALIDATION','Import records must be arrays.');
  const existing = existingCalls.map(call=>validateCall(call)), incoming = incomingCalls.map(call=>validateCall(call));
  uniqueCalls(existing); uniqueCalls(incoming);
  const ids = new Map(existing.map(call=>[call.id,call]));
  const ucids = new Map(existing.filter(call=>call.ucid).map(call=>[call.ucid.toLowerCase(),call]));
  const additions = []; let skipped = 0;
  for (const call of incoming) {
    const byId = ids.get(call.id), byUcid = call.ucid ? ucids.get(call.ucid.toLowerCase()) : undefined;
    if (byId || byUcid) {
      if (byId && (!byUcid || byId.id === byUcid.id) && sameCall(byId,call)) { skipped++; continue; }
      throw new StorageError('CONFLICT','A backup record conflicts with an existing call ID or UCID. Nothing was imported; your current records are unchanged.');
    }
    additions.push(call); ids.set(call.id,call); if (call.ucid) ucids.set(call.ucid.toLowerCase(),call);
  }
  if (ids.size > MAX_BACKUP_CALLS) throw new StorageError('VALIDATION',`This import would exceed the ${MAX_BACKUP_CALLS.toLocaleString('en-US')}-call limit.`);
  return {additions,skipped};
}
