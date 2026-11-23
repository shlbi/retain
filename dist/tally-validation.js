import { DEFAULT_GOALS, SERVICES } from './model.js';
import { StorageError, validDay, validateGoals, validateGoalPercentage } from './validation.js';

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
  const known = Object.hasOwn(value ?? {},'lineStart');
  exactFields(value, known ? [...groupFields,'lineStart','lineEnd'] : groupFields);
  if (known && (!Number.isInteger(value.lineStart) || value.lineStart < 1 || value.lineStart > 999 ||
      !Number.isInteger(value.lineEnd) || value.lineEnd < 0 || value.lineEnd > 999)) invalid();
  const before = serviceList(value.before), kept = serviceList(value.kept), added = serviceList(value.added);
  if (!before.length || kept.some(key => !before.includes(key)) || added.some(key => before.includes(key)) ||
      typeof value.washed !== 'boolean' || (value.washed && kept.length && kept.length !== before.length) ||
      !Number.isSafeInteger(value.count) || value.count < 1) invalid();
  if (known && (!before.includes('mobile') || kept.includes('mobile') !== (value.lineEnd > 0))) invalid();
  return {before, kept, added, ...(known ? {lineStart:value.lineStart,lineEnd:value.lineEnd} : {}), washed:value.washed, count:value.count};
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
    const signature = JSON.stringify([group.before,group.kept,group.added,group.washed,group.lineStart,group.lineEnd]);
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

function validateReportDays(value) {
  if (value.version !== 4 || !Array.isArray(value.days)) invalid();
  const days = Array.from(value.days, validateDayTotals);
  if (new Set(days.map(summary => summary.day)).size !== days.length) invalid();
  return days;
}

// During a rolling release, a report can still carry the earlier goal set.
function expandedGoals(input) {
  const goals={...input};
  for(const [key,base] of Object.entries({lineSave:'mobile',subscriber:'overall',exactTp:'tp',spInternet:'internet'})) {
    if(!Object.hasOwn(goals,key) && Object.hasOwn(goals,base))goals[key]=goals[base];
  }
  exactFields(goals,Object.keys(DEFAULT_GOALS));
  return goals;
}
export function validateTallyState(value) {
  exactFields(value,['version','days','goals']);
  return {version:4,days:validateReportDays(value),goals:validateGoals(expandedGoals(value.goals))};
}

/** A team goal is present only when every current member shares that percentage. */
export function validateTeamReport(value) {
  exactFields(value,['version','days','goals','memberCount']);
  const days = validateReportDays(value);
  const {memberCount} = value;
  if (!Number.isSafeInteger(memberCount) || memberCount < 0 || (!memberCount && days.length)) invalid();
  const complete=expandedGoals(value.goals);
  const goals = {};
  for (const [key,goal] of Object.entries(complete)) {
    if ((!memberCount && goal !== null) || (memberCount === 1 && goal === null)) invalid();
    goals[key] = goal === null ? null : validateGoalPercentage(key,goal);
  }
  return {version:4,days,goals,memberCount};
}
