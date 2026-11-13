import { metricsFromGroups, ordersFor, outcomesForCall } from './model.js';

const zeroTotals = {
  calls: 0, eligibleCalls: 0, savedCalls: 0, mobileOrders: 0, mobileLines: 0, saleCalls: 0
};

// The validated service lists use the same order in the browser and database.
function accumulateGroup(groups, {before, kept, added, washed}, count) {
  const key = JSON.stringify([before, kept, added, washed]);
  const found = groups.get(key);
  if (found) found.count += count;
  else groups.set(key, {before, kept, added, washed, count});
}

function sortedGroups(groups) {
  return Array.from(groups.keys()).sort().map(key => groups.get(key));
}

/** The only call-derived data sent to storage is a delta of counters and fixed service tags. */
export function tallyForCall(call) {
  const outcomes = outcomesForCall(call);
  if (!outcomes.length || (call.accounts && outcomes.length !== call.accounts.length)) {
    throw new Error('Choose starting services for each account.');
  }
  const groups = new Map();
  for (const outcome of outcomes) accumulateGroup(groups, outcome, 1);
  const orders = ordersFor(call);
  return {
    calls: 1,
    eligibleCalls: Number(outcomes.some(outcome => !outcome.washed)),
    savedCalls: Number(outcomes.some(outcome => !outcome.washed && outcome.saved)),
    mobileOrders: orders.length,
    mobileLines: orders.reduce((sum, lines) => sum + lines, 0),
    saleCalls: Number(orders.length > 0),
    groups: sortedGroups(groups)
  };
}

/** Combine the same fixed service outcomes across day summaries without expanding individual rows. */
export function groupsFromDays(days) {
  const groups = new Map();
  for (const day of days) {
    for (const group of day.groups) accumulateGroup(groups, group, group.count);
  }
  return sortedGroups(groups);
}

export function metricsForDay(day, goals) {
  return metricsFromGroups(day?.groups ?? [], day ?? zeroTotals, goals);
}
