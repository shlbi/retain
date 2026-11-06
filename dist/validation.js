import { DEFAULT_GOALS, SERVICES } from './model.js';

export const SCHEMA_VERSION = 3;
export const MAX_BACKUP_BYTES = 3 * 1024 * 1024;
export const MAX_BACKUP_CALLS = 10000;
export const MAX_MOBILE_ORDERS = 20;
export const MAX_LINES_PER_ORDER = 12;
const SERVICE_KEYS = SERVICES.map(service => service.key);
const RECORD_FIELDS = ['id','day','time','order','ucid','account','before','kept','mobileOrders','sold','soldLines','revision'];

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

/** Validate a call and derive canonical sales fields before persistence or metric calculation. */
export function validateCall(value, {allowLegacy = true} = {}) {
  object(value, 'Call'); fields(value, RECORD_FIELDS, 'Call');
  const id = identifier(value.id, 'Call record ID');
  const ucid = identifier(value.ucid, 'UCID', true);
  const account = identifier(value.account, 'Account number', true);
  if (!validDay(value.day)) throw new StorageError('VALIDATION', 'Call date must be a valid YYYY-MM-DD date.');
  if (typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new StorageError('VALIDATION', 'Call time must be a valid 24-hour HH:mm time.');
  if (!Number.isFinite(value.order) || value.order < 0) throw new StorageError('VALIDATION', 'Call sorting time must be a nonnegative finite number.');
  if (!Array.isArray(value.before) || value.before.length < 1 || value.before.length > SERVICE_KEYS.length || new Set(value.before).size !== value.before.length || Array.from(value.before).some(key => !SERVICE_KEYS.includes(key))) throw new StorageError('VALIDATION', 'Choose 1–4 distinct starting services.');
  if (!Array.isArray(value.kept) || new Set(value.kept).size !== value.kept.length || Array.from(value.kept).some(key => !value.before.includes(key))) throw new StorageError('VALIDATION', 'Kept services must be distinct services the customer started with.');
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 1)) throw new StorageError('VALIDATION', 'Call revision must be a positive integer.');
  const sales = mobileOrders(value, allowLegacy);
  return {id,day:value.day,time:value.time,order:value.order,ucid,account,before:SERVICE_KEYS.filter(key=>value.before.includes(key)),kept:SERVICE_KEYS.filter(key=>value.kept.includes(key)),...sales,revision:value.revision ?? 1};
}

/** Require every known goal; version 2 alone may omit the newly introduced orders target. */
export function validateGoals(value, version = SCHEMA_VERSION) {
  object(value, 'Goals'); fields(value, Object.keys(DEFAULT_GOALS), 'Goals');
  if (![2,SCHEMA_VERSION].includes(version)) throw new StorageError('VALIDATION', 'Unsupported goals schema version.');
  const goals = {};
  for (const key of Object.keys(DEFAULT_GOALS)) {
    const candidate = version === 2 && key === 'orders' && value[key] === undefined ? DEFAULT_GOALS.orders : value[key];
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
  if (value.exportedAt !== undefined && (typeof value.exportedAt !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value.exportedAt) || !validDay(value.exportedAt.slice(0,10)) || !Number.isFinite(Date.parse(value.exportedAt)))) throw new StorageError('VALIDATION', 'The backup export timestamp is invalid.');
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
function sameCall(a, b) {
  const {revision:revisionA,...left} = a, {revision:revisionB,...right} = b;
  left.ucid = left.ucid.toLowerCase(); right.ucid = right.ucid.toLowerCase();
  return JSON.stringify(left) === JSON.stringify(right);
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
