import { SERVICES, classifyAccount } from './model.js';

const shortNames = new Map(SERVICES.map(service => [service.key, service.short]));
const formatCount = new Intl.NumberFormat('en-US');
const formatDay = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
});
const outcomeNames = {
  SPS: 'Single-play save', SPD: 'Single-play disconnect',
  DPS: 'Double-play save', DPD: 'Double-play disconnect',
  TPS: 'Triple-play save', TPD: 'Triple-play disconnect'
};

function serviceNames(keys) {
  return keys.map(key => shortNames.get(key));
}

function includeGroup(outcome, washed, filter) {
  switch (filter) {
    case 'all': return true;
    case 'saved': return outcome.added.length > 0 || (!washed && outcome.saved);
    case 'disconnected': return !washed && outcome.disconnected.length > 0;
    case 'downgrade': return outcome.kind === 'downgrade';
    case 'wash': return washed;
    default: return false;
  }
}

/** Each row is one persisted daily category. Mobile sales stay independent of account groups. */
export function groupedRows(days, filter = 'all') {
  const rows = [];
  for (const day of [...days].sort((a, b) => b.day.localeCompare(a.day))) {
    const groups = [];
    for (const group of day.groups) {
      const outcome = classifyAccount(group);
      if (!outcome || !group.count || !includeGroup(outcome, group.washed, filter)) continue;
      groups.push({
        day: day.day, outcome: outcome.code, kind: outcome.kind, washed: group.washed,
        kept: serviceNames(outcome.kept), disconnected: serviceNames(outcome.disconnected),
        added: serviceNames(outcome.added), count: group.count
      });
    }
    // Sort by frequency, then tags, so the list never implies a call sequence.
    groups.sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome) ||
      a.kept.join().localeCompare(b.kept.join()) || a.disconnected.join().localeCompare(b.disconnected.join()) ||
      a.added.join().localeCompare(b.added.join()) || Number(a.washed) - Number(b.washed));
    rows.push(...groups);
    if (day.mobileOrders && (filter === 'all' || filter === 'mobile')) {
      rows.push({day: day.day, kind: 'mobile', outcome: 'Mobile sold', orders: day.mobileOrders, lines: day.mobileLines});
    }
  }
  return rows;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
}

function countLabel(value, unit) {
  return formatCount.format(value) + ' ' + unit + (value === 1 ? '' : 's');
}

function rowTags(row) {
  const tags = [];
  if (row.washed) tags.push('<span class="badge neutral">Wash</span>');
  const title = outcomeNames[row.outcome] ?? (row.kind === 'downgrade' ? 'Bundle downgrade' : row.outcome);
  tags.push(`<span class="badge ${row.washed ? 'neutral' : row.kind}" title="${escapeHtml(title)}">${escapeHtml(row.outcome)}</span>`);
  for (const [field, label, color] of [['kept', 'kept', 'save'], ['disconnected', 'disconnected', 'disconnect'], ['added', 'added', 'added']]) {
    for (const service of row[field] ?? []) {
      tags.push(`<span class="badge ${color}">${escapeHtml(service)} ${label}</span>`);
    }
  }
  return tags.join('');
}

export function groupedTable(rows, {showDate = false, empty = 'No saved outcomes for this date.', editable = false} = {}) {
  if (!rows.length) return `<p class="tally-empty">${escapeHtml(empty)}</p>`;
  const body = rows.map(row => {
    const count = row.kind === 'mobile'
      ? `${countLabel(row.orders, 'order')} · ${countLabel(row.lines, 'line')}`
      : countLabel(row.count, 'account');
    const date = showDate ? `<td class="tally-date"><time datetime="${escapeHtml(row.day)}">${formatDay.format(new Date(row.day + 'T00:00:00Z'))}</time></td>` : '';
    return `<tr>${date}<td><span class="outcome-tags">${rowTags(row)}</span></td><td class="tally-count">${count}${editable ? `<button class="tally-edit" data-action="edit-history" data-day="${row.day}" aria-label="Edit totals for ${row.day}">Edit</button>` : ''}</td></tr>`;
  }).join('');
  return `<table class="tally-table"><thead><tr>${showDate ? '<th scope="col">Date</th>' : ''}<th scope="col">Outcome tags</th><th scope="col" class="tally-count">Count</th></tr></thead><tbody>${body}</tbody></table>`;
}

export function groupedCsv(rows) {
  const records = [['Date (Eastern)', 'Outcome', 'Wash', 'Services kept', 'Services disconnected', 'Services added', 'Accounts', 'Mobile orders', 'Mobile lines']];
  for (const row of rows) {
    records.push([row.day, row.outcome, row.kind === 'mobile' ? '' : row.washed ? 'Yes' : 'No',
      row.kept?.join(', '), row.disconnected?.join(', '), row.added?.join(', '), row.count, row.orders, row.lines]);
  }
  const quote = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  return '\uFEFF' + records.map(record => record.map(quote).join(',')).join('\r\n');
}
