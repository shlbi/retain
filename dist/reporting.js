import { SERVICES, ordersFor, outcomesForCall, soldLinesFor, soldOrdersFor } from './model.js';

const outcomeNames = {
  SPS: 'Single-play save', SPD: 'Single-play disconnect',
  DPS: 'Double-play save', DPD: 'Double-play disconnect',
  TPS: 'Triple-play (3+) save', TPD: 'Triple-play (3+) disconnect'
};

export function outcomeName(outcome) {
  return outcomeNames[outcome.code] ?? 'Bundle downgrade';
}

export function serviceName(key) {
  return SERVICES.find(service => service.key === key).short;
}

export function matchesFilter(call, filter) {
  if (filter === 'all') return true;
  if (filter === 'mobile') return soldOrdersFor(call) > 0;
  const outcomes = outcomesForCall(call);
  if (filter === 'wash') return outcomes.some(outcome => outcome.washed);
  if (filter === 'saved') return outcomes.some(outcome => outcome.added.length || (!outcome.washed && outcome.saved));
  if (filter === 'disconnected') return outcomes.some(outcome => !outcome.washed && outcome.disconnected.length);
  return filter === 'downgrade' && outcomes.some(outcome => outcome.kind === 'downgrade');
}

export function orderLabel(call) {
  const orders = soldOrdersFor(call), lines = soldLinesFor(call);
  return orders ? `${orders} order${orders === 1 ? '' : 's'} · ${lines} mobile${lines === 1 ? '' : 's'}` : '';
}

// Neutralize formula-like cells while preserving the original text and CSV quoting.
function csvCell(value) {
  const text = String(value ?? '');
  return '"' + (/^\s*[=+@-]/.test(text) ? "'" : '') + text.replace(/"/g, '""') + '"';
}

export function callsToCsv(calls) {
  const rows = [['Date','Time (Eastern)','UCID','Account number','Outcome','Starting services','Kept services','Disconnected services','Added services','Mobile orders','Mobiles sold','Mobiles per order','Callback (UTC)','Callback status','Callback note']];
  for (const call of calls) {
    const outcomes = outcomesForCall(call);
    // Account numbers and service lists keep the same order in every column.
    const grouped = read => outcomes.map(outcome => {
      const value = read(outcome);
      return outcomes.length === 1 ? value : `Account ${outcome.index + 1}: ${value || '—'}`;
    }).join(' | ');
    const services = key => grouped(outcome => outcome[key].map(serviceName).join(', '));
    rows.push([call.day, call.time, call.ucid, grouped(outcome => outcome.account),
      grouped(outcome => outcome.washed ? `Wash (${outcome.code})` : outcome.code),
      services('before'), services('kept'), services('disconnected'), services('added'),
      soldOrdersFor(call), soldLinesFor(call), ordersFor(call).join('; '),
      call.callback?.dueAt, call.callback?.status, call.callback?.note]);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
