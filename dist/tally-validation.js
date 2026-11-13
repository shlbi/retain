import { DEFAULT_GOALS, SERVICES } from './model.js';
import { StorageError, validDay, validateGoals } from './validation.js';

const countFields = ['calls','eligibleCalls','savedCalls','saleCalls','mobileOrders','mobileLines'];
const groupFields = ['before','kept','added','washed','count'];
const serviceKeys = SERVICES.map(service => service.key);

function invalid() {
  throw new StorageError('VALIDATION', 'Invalid grouped tally. Check the selected services and totals.');
}

function exactFields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) invalid();
}

function serviceList(value) {
  if (!Array.isArray(value)) invalid();
  const normalized = serviceKeys.filter(key => value.includes(key));
  if (normalized.length !== value.length) invalid();
  return normalized;
}

function validateGroup(value) {
  exactFields(value, groupFields);
  const before = serviceList(value.before), kept = serviceList(value.kept), added = serviceList(value.added);
  if (!before.length || kept.some(key => !before.includes(key)) || added.some(key => before.includes(key)) ||
      typeof value.washed !== 'boolean' || (value.washed && kept.length && kept.length !== before.length) ||
      !Number.isSafeInteger(value.count) || value.count < 1) invalid();
  return {before, kept, added, washed:value.washed, count:value.count};
}

function checkedTotals(value, keys) {
  exactFields(value, keys);
  if (!countFields.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
      !value.calls || value.savedCalls > value.eligibleCalls || value.eligibleCalls > value.calls ||
      value.saleCalls > value.calls || value.saleCalls > value.mobileOrders ||
      value.mobileOrders > value.saleCalls * 20 || value.mobileLines < value.mobileOrders ||
      value.mobileLines > value.mobileOrders * 12 || !Array.isArray(value.groups) || !value.groups.length) invalid();
  const groups = Array.from(value.groups, validateGroup);
  const seen = new Set(), washBalance = new Map();
  let accounts = 0;
  for (const group of groups) {
    const signature = JSON.stringify([group.before,group.kept,group.added,group.washed]);
    if (seen.has(signature)) invalid();
    seen.add(signature);
    accounts += group.count;
    if (group.washed) {
      const key = group.before.join(',');
      washBalance.set(key, (washBalance.get(key) ?? 0) + (group.kept.length ? group.count : -group.count));
    }
  }
  if (accounts < value.calls || !Number.isSafeInteger(accounts) || [...washBalance.values()].some(Boolean)) invalid();
  return {...Object.fromEntries(countFields.map(key => [key,value[key]])), groups};
}

export function validateDayTotals(value) {
  const totals = checkedTotals(value, [...countFields, 'groups','day']);
  if (!validDay(value.day)) invalid();
  return {day:value.day,...totals};
}

export function validateTallyUpdate(day,delta,requestId) {
  if (!validDay(day) || typeof requestId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) invalid();
  const totals = checkedTotals(delta,[...countFields,'groups']);
  const unpaired = totals.groups.filter(group => !group.washed);
  const fullSaves = new Set(unpaired.filter(g => g.kept.length === g.before.length).map(g => g.before.join(',')));
  if (unpaired.some(g => !g.kept.length && fullSaves.has(g.before.join(',')))) invalid();
  if (totals.groups.some(g => g.count > 2147483647)) invalid();
  if (totals.calls !== 1 || totals.eligibleCalls !== Number(Boolean(unpaired.length)) ||
      totals.savedCalls !== Number(unpaired.some(group => group.kept.length > 0)) ||
      totals.saleCalls !== Number(totals.mobileOrders > 0)) invalid();
  return {day, delta:totals, requestId};
}

export function validateTallyState(value) {
  exactFields(value,['version','days','goals']);
  if (value.version !== 4 || !Array.isArray(value.days)) invalid();
  const days = Array.from(value.days, validateDayTotals);
  if (new Set(days.map(summary => summary.day)).size !== days.length) invalid();
  exactFields(value.goals,Object.keys(DEFAULT_GOALS));
  return {version:4,days,goals:validateGoals(value.goals)};
}
