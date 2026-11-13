import test from 'node:test';
import assert from 'node:assert/strict';
import { groupedRows, groupedCsv, groupedTable } from '../dist/tally-history.js';

const account = (before, kept, added, washed, count) => ({before, kept, added, washed, count});
const day = {
  day: '2026-11-11', calls: 18, eligibleCalls: 15, savedCalls: 12, mobileOrders: 6, mobileLines: 9,
  groups: [
    account(['tv','internet'], ['internet'], [], false, 8),
    account(['internet'], ['internet'], [], false, 11),
    account(['phone'], [], ['mobile'], true, 2),
    account(['phone'], ['phone'], [], true, 2)
  ]
};

test('grouped history uses stored counts and one independent mobile row per day', () => {
  const rows = groupedRows([day]);
  assert.deepEqual(rows.map(row => row.count), [11,8,2,2,undefined]);
  assert.equal(rows[1].outcome, 'DP → SP');
  const html = groupedTable(rows, {showDate:true});
  for (const text of ['Internet kept', 'Video disconnected', '8 accounts', '11 accounts', '6 orders · 9 lines', 'Nov 11, 2026']) assert.ok(html.includes(text));
  assert.equal(groupedRows([day], 'wash').length, 2);
  assert.deepEqual(groupedRows([day], 'saved').map(row => row.count), [11,8,2]);
  assert.equal(groupedRows([day], 'disconnected').length, 1);
  assert.equal(groupedRows([day], 'downgrade').length, 1);
  assert.equal(groupedRows([day], 'mobile').length, 1);
});

test('all-date export keeps dates independently and exports only displayed grouped fields', () => {
  const next = {...day, day:'2026-11-12', ucid:'sensitive-marker', callback:{note:'sensitive-marker'}};
  const rows = groupedRows([day,next], 'mobile');
  assert.deepEqual(rows.map(row => row.day), ['2026-11-12','2026-11-11']);
  const csv = groupedCsv(rows);
  assert.equal(csv.split('\r\n').length, 3);
  assert.ok(csv.includes('"2026-11-12","Mobile sold","","","","","","6","9"'));
  assert.ok(!csv.includes('sensitive-marker'));
  assert.ok(!csv.includes('UCID'));
  assert.ok(!csv.includes('Callback'));
});

test('empty histories stay empty and empty-state text is escaped', () => {
  const rows = groupedRows([{...day, groups:[],mobileOrders:0,mobileLines:0}]);
  assert.deepEqual(rows, []);
  assert.equal(groupedCsv(rows).split('\r\n').length, 1);
  assert.ok(groupedTable(rows, {empty:'<img>'}).includes('&lt;img&gt;'));
});
