import { accountOutcomes, dayKey } from './model.js';
import { tallyFromOutcomes } from './tally.js';
import { validateDayTotals, validateTallyUpdate } from './tally-validation.js';
import { StorageError, validDay } from './validation.js';

const counters = ['calls','eligibleCalls','savedCalls','saleCalls','mobileOrders','mobileLines'];
const groupKey = g => JSON.stringify([g.before,g.kept,g.added,g.washed]);
const invalid = message => { throw new StorageError('VALIDATION',message); };

export function originalTally(groups, orders, lines) {
  const retained = groups.filter(group => !group.washed);
  return {calls:1, eligibleCalls:Number(retained.length > 0), savedCalls:Number(retained.some(g => g.kept.length)),
    mobileOrders:orders, mobileLines:lines, saleCalls:Number(orders > 0), groups};
}

export function revisedTally(accounts, orders, lines) {
  if (!accounts.length || accounts.some(a => !a.before.length || !Number.isSafeInteger(a.count) || a.count < 1)) {
    invalid('Choose starting services and a positive quantity for each account.');
  }
  return tallyFromOutcomes(accountOutcomes(accounts, a => a.count), orders, lines);
}

/** Apply one call to a date, keeping account quantities separate from call counters. */
function adjust(summary, day, delta, sign, requestId) {
  const next = {day};
  for (const key of counters) next[key] = (summary?.[key] ?? 0) + sign * delta[key];
  const groups = new Map((summary?.groups ?? []).map(g => [groupKey(g), {...g}]));
  for (const g of delta.groups) {
    const key = groupKey(g), count = (groups.get(key)?.count ?? 0) + sign * g.count;
    if (count < 0) invalid('The selected original accounts exceed the saved count.');
    if (count) groups.set(key, {...g,count});
    else groups.delete(key);
  }
  next.groups = [...groups.values()];
  if (!next.calls && !next.groups.length && counters.every(key => next[key] === 0)) return null;
  const retained = next.groups.filter(group => !group.washed);
  const accounts = retained.reduce((sum,g) => sum + g.count, 0);
  const saves = retained.reduce((sum,g) => sum + (g.kept.length ? g.count : 0), 0);
  const losses = accounts - saves;
  const washedPairs = next.groups.filter(g => g.washed && g.kept.length).reduce((sum,g) => sum+g.count,0);
  if (next.eligibleCalls > accounts || Boolean(accounts) !== Boolean(next.eligibleCalls) ||
      next.savedCalls > saves || Boolean(saves) !== Boolean(next.savedCalls) ||
      next.eligibleCalls - next.savedCalls > losses || next.calls - next.eligibleCalls > washedPairs) {
    invalid('Check which accounts belonged to the original call. The remaining outcomes must match the other calls.');
  }
  try {
    if (next.calls === 1) {
      const {day:date, ...onlyCall} = next;
      validateTallyUpdate(date,onlyCall,requestId);
    }
    return validateDayTotals(next);
  }
  catch { invalid('The remaining totals do not match the other calls. Check the original accounts, orders and lines.'); }
}

/** Compute both dates on the server from single-call contributions. An empty date is represented by null. */
export function correctionChanges({source, destinationDay, destination, original, revised, requestId}) {
  const expected = validateDayTotals(source);
  const before = validateTallyUpdate(expected.day, original, requestId).delta;
  const remainder = adjust(expected, expected.day, before, -1, requestId);
  if (revised === null) {
    if (destinationDay !== expected.day || destination !== null) invalid('A removal affects only the original date.');
    return [{day:expected.day,expected,replacement:remainder}];
  }
  if (!validDay(destinationDay) || destinationDay > dayKey()) invalid('Choose a report date through today.');
  const after = validateTallyUpdate(destinationDay, revised, requestId).delta;
  if (destinationDay === expected.day) {
    if (destination !== null) invalid('Choose one original report date.');
    return [{day:expected.day,expected,replacement:adjust(remainder, expected.day, after, 1, requestId)}];
  }
  const target = destination === null ? null : validateDayTotals(destination);
  if (target && target.day !== destinationDay) invalid('Check the destination report date.');
  return [{day:expected.day,expected,replacement:remainder},
    {day:destinationDay,expected:target,replacement:adjust(target,destinationDay,after,1,requestId)}];
}
